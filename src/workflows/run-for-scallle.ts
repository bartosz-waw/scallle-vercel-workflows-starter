import { createHook, FatalError } from 'workflow'

import { sendToScallle } from '../lib/callback'
import { runClaimToken, type CallbackReport, type ScallleJob, type Usage } from '../lib/contract'
import { errorKind, reportableMessage } from '../lib/plain-errors'
import { filledFieldsFor } from '../lib/reply'

/**
 * The frame every automation runs in. Call it from a "use workflow" function
 * with the automation's work:
 *
 *   export async function myAutomation(job: ScallleJob) {
 *     'use workflow'
 *     return runForScallle(job, async () => {
 *       const answer = await askClaude({ … })        // steps do the work
 *       return { result: answer.text, usage: answer.usage }   // + fields, for the rows in job.fill
 *     })
 *   }
 *
 * It does three things around the work:
 *
 *   1. Claims the Scallle run id. Scallle may send the same run twice
 *      (contract §4); only the first workflow run to claim it does the work,
 *      any other stops here without calling Claude or Scallle.
 *   2. Runs the work. If it fails for good — a FatalError, or a step out of
 *      retries — the failure becomes { status: 'error', error_message } with
 *      a plain message (plain-errors.ts), so the step goes back to a person
 *      in Scallle instead of waiting 20 minutes.
 *   3. Sends the one result — success or error — to the run's callback. That
 *      delivery is its own step and retries on its own. Of the fields the
 *      work filled it sends only those the job asked it to fill (the names
 *      in job.fill), as text, a number or true/false — any other is dropped.
 *
 * A failed run still ends as failed (after Scallle has been told), so it shows
 * up in the Vercel dashboard — but with the same plain message Scallle got,
 * never the original error: the runtime logs and stores whatever a failed run
 * throws, and the original may quote the item.
 */

export type AutomationResult = {
  /** What lands on the step in Scallle. Plain text: a draft, never an action taken. */
  result: string
  /** Token usage across the run's Claude calls, so Scallle can cost the run. */
  usage?: Usage | null
  /** Values for the rows the job's `fill` lists, by name: text, a number or
   *  true/false. A person checks each on its own row in Scallle before it is
   *  used. Any name not in `job.fill` is dropped. */
  fields?: Record<string, unknown> | null
}

export type RunOutcome =
  | { outcome: 'delivered'; status: 'success' | 'error' }
  | { outcome: 'duplicate'; handledBy: string }

/** How long a claimed run id stays claimed after its run ends, so a late
 *  repeat is still recognised. Scallle gives up on a run after 20 minutes. */
const CLAIM_KEPT_FOR = '7d'

export async function runForScallle(
  job: ScallleJob,
  work: () => Promise<AutomationResult>
): Promise<RunOutcome> {
  // 1. Claim the run id. Not `using`: disposing the claim would release it
  //    as soon as this run ends, and a late repeat would run the work again.
  const claim = createHook({
    token: runClaimToken(job.runId),
    experimental_minRetention: CLAIM_KEPT_FOR,
  })
  const owner = await claim.getConflict()
  if (owner) return { outcome: 'duplicate', handledBy: owner.runId }

  // 2. The work.
  let report: CallbackReport
  try {
    const out = await work()
    const fields = filledFieldsFor(job.fill, out.fields)
    report = {
      status: 'success',
      metadata: { result: out.result, ...(fields ? { fields } : {}) },
      ...(out.usage ? { usage: out.usage } : {}),
    }
  } catch (err) {
    report = { status: 'error', error_message: reportableMessage(err) }
    console.error(`Scallle run ${job.runId} failed: ${errorKind(err)}.`)
  }

  // 3. Tell Scallle.
  await sendToScallle(job.callbackUrl, report)
  if (report.status === 'error') throw new FatalError(report.error_message)
  return { outcome: 'delivered', status: report.status }
}
