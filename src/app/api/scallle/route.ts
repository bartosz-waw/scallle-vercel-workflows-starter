import { getHookByToken, start } from 'workflow/api'
import { HookNotFoundError } from 'workflow/errors'

import { checkJob } from '../../../lib/check-job'
import { NotConfiguredError, readConfig } from '../../../lib/config'
import { runClaimToken } from '../../../lib/contract'
import { scallleKeyFor } from '../../../lib/scallle-keys'
import { KEY_ID_HEADER, readSignatureHeaders, SIGNATURE_HEADER, verifySignature } from '../../../lib/signature'
import { WORKFLOW } from '../../../workflows'

/**
 * POST /api/scallle — where Scallle sends this business's jobs.
 *
 * A job is refused, and nothing starts, unless it is signed by Scallle (with
 * a key Scallle publishes at SCALLLE_APP_URL), speaks contract v1, was issued
 * within 5 minutes, is for this business's workspace, is addressed to this
 * project, its callback is that same run's callback on Scallle, and it is for
 * the one automation this project runs. Then its workflow starts and Scallle gets 202 { accepted: true } straight away; the
 * result goes back later, to the callback.
 *
 * In this order — the status codes matter, Scallle reads them:
 *   1. over 1 MB → 413
 *   2. key id or signature header missing or malformed → 401, nothing fetched
 *   3. Scallle's public key for that key id: can't be fetched → 503 (Scallle
 *      sends again); not published → 401
 *   4. the signature → 401
 *   5. not JSON → 400; not contract v1 → 400
 *   6. issued_at more than 5 minutes off → 401
 *   7. another business → 403
 *   8. addressed to another project → 400
 *   9. a callback that isn't this run's, on Scallle → 400
 *  10. for another automation than SCALLLE_AUTOMATION_ID → 400; while
 *      SCALLLE_AUTOMATION_ID isn't set → 500, naming the job's own
 *      automation id as the value to set
 *  11. a run already seen → 202, nothing started again
 *
 * Status codes follow the contract (§4): Scallle resends only after a network
 * error, 429, 502 or 503 — so a refusal is a 4xx (final), and only a
 * temporary failure (fetching the key, starting the workflow) is a 503.
 *
 * Logs name run ids and reasons only — never the item, the procedure or the
 * callback address (it holds the run's token).
 */

/** A job is a small JSON object; anything bigger is refused unread. */
const MAX_BODY_BYTES = 1_000_000

/**
 * Delete a run's data (the item, Claude's draft, every step's input and
 * output) as soon as the run ends. The result has already gone to Scallle by
 * then, which is the only place it needs to live. Run ids, step names, times
 * and status are kept, so runs stay visible in the Vercel dashboard.
 * Set to 'default' to keep the data for your Vercel plan's retention window
 * instead, e.g. while debugging an automation on test data.
 */
const RUN_DATA_RETENTION: 0 | 'default' = 0

const NOT_SIGNED = 'This job isn’t signed by Scallle.'

const NO_OIDC =
  'This project can’t run Vercel Workflows: in Vercel open the project → Settings → Security and turn on ' +
  'Secure backend access with OIDC federation, and under Environment Variables tick Automatically expose ' +
  'System Environment Variables. Then redeploy.'

/** This request's own host — the Host header, else the request URL's. Never
 *  X-Forwarded-Host: a caller can set that where no proxy overwrites it. */
function requestHost(request: Request): string {
  return (request.headers.get('host') ?? new URL(request.url).host).toLowerCase()
}

function answer(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

function refuse(status: number, error: string): Response {
  console.warn(`Refused a Scallle job (${status}): ${error}`)
  return answer(status, { accepted: false, error })
}

export async function POST(request: Request): Promise<Response> {
  let config
  try {
    config = readConfig()
  } catch (err) {
    if (err instanceof NotConfiguredError) return refuse(500, err.message)
    throw err
  }

  // 1. The raw bytes, exactly as sent — the signature covers these.
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) {
    return refuse(413, 'The job is too large.')
  }
  const raw = new Uint8Array(await request.arrayBuffer())
  if (raw.byteLength > MAX_BODY_BYTES) return refuse(413, 'The job is too large.')

  // 2. Signed at all? Checked before any key is fetched, so unsigned noise
  //    costs nothing and never reaches Scallle.
  const signed = readSignatureHeaders(request.headers.get(KEY_ID_HEADER), request.headers.get(SIGNATURE_HEADER))
  if (!signed) return refuse(401, NOT_SIGNED)

  // 3. Scallle's public key for it — only ever from SCALLLE_APP_URL.
  const found = await scallleKeyFor(config.appOrigin, signed.kid)
  if (!found.ok) {
    if (found.reason === 'unavailable') {
      return refuse(503, 'Couldn’t fetch Scallle’s public key just now. Try again in a minute.')
    }
    return refuse(
      401,
      `This job is signed with a key Scallle doesn’t publish at ${config.appOrigin} — it may have come from a test copy of Scallle.`
    )
  }

  // 4. Signed by Scallle, over exactly these bytes?
  if (!verifySignature(raw, signed.signature, found.key)) return refuse(401, NOT_SIGNED)

  // 5–10. Meant for this deployment and its one automation, now?
  let body: unknown
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))
  } catch {
    return refuse(400, 'The job is not valid JSON.')
  }
  const check = checkJob(body, config, requestHost(request))
  if (!check.ok) return refuse(check.status, check.error)
  const { job } = check

  // Vercel Workflows can't run without this project's Vercel sign-in (OIDC),
  // which Vercel passes on every request once it is switched on. Without it
  // start() would fail every time, and a 503 would make that look temporary.
  if (process.env.VERCEL === '1' && !request.headers.get('x-vercel-oidc-token')) {
    return refuse(500, NO_OIDC)
  }

  // 11. Seen this run before? Then its work has started already. This lookup
  //     is a shortcut only — two copies arriving at the same moment can both
  //     get past it, and the workflow's own claim (run-for-scallle.ts) is what
  //     makes the work happen once.
  if (await alreadyClaimed(job.runId)) {
    console.info(`Scallle run ${job.runId} arrived again; its work has already started.`)
    return answer(202, { accepted: true })
  }

  // Start the automation and answer at once.
  try {
    const run = await start(WORKFLOW, [job], {
      experimental_retention: RUN_DATA_RETENTION,
      // Plain-text labels kept with the run, so it can be found in the
      // Vercel dashboard from Scallle's run id. Ids only — never data.
      attributes: { scallle_run_id: job.runId, scallle_automation_id: job.automationId },
    })
    console.info(`Scallle run ${job.runId} started as workflow run ${run.runId}.`)
  } catch (err) {
    console.error(`Couldn't start Scallle run ${job.runId}: ${err instanceof Error ? err.name : 'Error'}`)
    return refuse(503, "The job couldn't be started just now. Scallle may send it again.")
  }
  return answer(202, { accepted: true })
}

async function alreadyClaimed(runId: string): Promise<boolean> {
  try {
    await getHookByToken(runClaimToken(runId))
    return true
  } catch (err) {
    // Not found is the usual answer. Any other failure: carry on and let the
    // workflow's claim decide.
    if (!HookNotFoundError.is(err)) {
      console.warn(`Couldn't check whether Scallle run ${runId} was seen before.`)
    }
    return false
  }
}
