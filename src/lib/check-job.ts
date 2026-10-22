import { type Config, UUID } from './config'
import {
  CALLBACK_PATH,
  CONTRACT_VERSION,
  KNOWN_JOB_KEYS,
  type JobContext,
  type JobField,
  type JobFieldType,
  type ScallleJob,
} from './contract'

/**
 * The checks a signed job must pass before any work starts. The signature has
 * already been verified by then (route.ts), so everything here is about the
 * job being meant for THIS deployment, now:
 *
 *   - it speaks contract version 1, and says whether the run is a test,
 *   - it was issued within 5 minutes of now (a captured job can't be replayed later),
 *   - it belongs to the one business this deployment serves (403 otherwise).
 *     Scallle signs every business's jobs with the same key, so this is the
 *     wall between businesses,
 *   - it is addressed to this project: `to` names this request's host and
 *     /api/scallle (400 otherwise — a 403 would read as "another business"),
 *     so a job captured on its way to one of the business's projects can't
 *     be replayed at another,
 *   - its callback is on Scallle's own origin and names this same automation
 *     and run — so a result can never be posted anywhere else,
 *   - it is for the one automation this project runs (SCALLLE_AUTOMATION_ID):
 *     400 otherwise; while it isn't set, 500 naming the job's own automation
 *     id. Each automation has a project of its own, holding only its own keys,
 *     so this keeps one automation's job from ever reaching another's keys.
 *
 * Then the parts that only describe the work — `context`, `fields`, `fill`
 * and `step.sent_back_note` — are read as far as they make sense and never
 * refused: one that is missing or malformed reads as empty, so a job from a
 * Scallle before they were added runs exactly as it always has.
 *
 * Fields the contract doesn't name are kept in `job.more`, never refused:
 * the contract only grows.
 */

/** The path every job is addressed to. */
export const RECEIVER_PATH = '/api/scallle'

export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000

export type JobCheck =
  | { ok: true; job: ScallleJob }
  | { ok: false; status: 400 | 401 | 403 | 500; error: string }

function refuse(status: 400 | 401 | 403 | 500, error: string): JobCheck {
  return { ok: false, status, error }
}

/** A job for an automation other than SCALLLE_AUTOMATION_ID (400). */
export const OTHER_AUTOMATION = 'This project runs another automation, so the job was refused.'

/**
 * While SCALLLE_AUTOMATION_ID isn't set (500): names the job's own automation
 * id as the value to set — only once the job has passed every other check, so
 * the id named back is one Scallle signed for this business, this project and
 * this run.
 */
export function notSetUpFor(automationId: string): string {
  return UUID.test(automationId)
    ? `This project isn’t set up for its automation yet: set SCALLLE_AUTOMATION_ID to ${automationId.toLowerCase()} in its environment variables, then redeploy.`
    : 'This project isn’t set up for its automation yet: set SCALLLE_AUTOMATION_ID to the step’s automation id in Scallle, then redeploy.'
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** Limits on the parts that describe the work. Scallle stays well inside
 *  them; anything past them is cut or left out, never refused. */
export const JOB_LIMITS = {
  contextText: 200,
  label: 200,
  choices: 20,
  choiceText: 120,
  fields: 50,
  fill: 20,
  sentBackNote: 2000,
} as const

const FIELD_NAME = /^[A-Za-z0-9_-]{1,64}$/
const FIELD_TYPES: readonly JobFieldType[] = ['text', 'number', 'choice', 'url', 'boolean', 'json']
const CONTEXT_KEYS = ['today', 'system_name', 'done_by'] as const

/** About this run: only the three keys Scallle names, each a non-empty string. */
function contextOf(value: unknown): JobContext {
  const given = record(value)
  const out: JobContext = {}
  for (const key of CONTEXT_KEYS) {
    const v = text(given?.[key])
    if (v) out[key] = v.slice(0, JOB_LIMITS.contextText)
  }
  return out
}

/** `fields` or `fill`: the well-formed entries, at most `max`, each name once. */
function fieldsOf(value: unknown, max: number): JobField[] {
  if (!Array.isArray(value)) return []
  const out: JobField[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (out.length >= max) break
    const field = record(entry)
    const name = typeof field?.name === 'string' ? field.name : ''
    if (!FIELD_NAME.test(name) || seen.has(name)) continue
    seen.add(name)
    const type = FIELD_TYPES.find((t) => t === field?.type) ?? null
    const choices = Array.isArray(field?.choices)
      ? field.choices
          .map(text)
          .filter((c): c is string => c !== null && c.length <= JOB_LIMITS.choiceText)
          .slice(0, JOB_LIMITS.choices)
      : []
    out.push({
      name,
      label: (text(field?.label) ?? name).slice(0, JOB_LIMITS.label),
      type,
      choices,
      required: field?.required === true,
    })
  }
  return out
}

/** Every top-level key this starter doesn't know, as sent. */
function moreOf(job: Record<string, unknown>): Record<string, unknown> {
  const known: readonly string[] = KNOWN_JOB_KEYS
  return Object.fromEntries(Object.entries(job).filter(([key]) => !known.includes(key)))
}

/**
 * @param requestHost this request's own host (the `host` header, or the
 *   request URL's host) — never X-Forwarded-Host, which a caller can set.
 */
export function checkJob(
  body: unknown,
  config: Config,
  requestHost: string,
  now: number = Date.now()
): JobCheck {
  const job = record(body)
  if (!job) return refuse(400, 'The job is not a JSON object.')

  if (job.version !== CONTRACT_VERSION) {
    return refuse(400, `This project speaks contract version ${CONTRACT_VERSION} only.`)
  }

  const issuedAt = Date.parse(typeof job.issued_at === 'string' ? job.issued_at : '')
  if (Number.isNaN(issuedAt)) return refuse(400, 'The job has no valid issued_at time.')
  if (Math.abs(now - issuedAt) > MAX_CLOCK_SKEW_MS) {
    return refuse(401, 'The job was issued more than 5 minutes from now, so it was refused.')
  }

  const run = record(job.run)
  const runId = text(run?.id)
  const automationId = text(run?.automation_id)
  const workspaceId = text(run?.workspace_id)
  const connectionId = text(job.connection_id)
  if (!runId || !automationId || !workspaceId || !connectionId) {
    return refuse(400, "The job doesn't say which connection, run, automation and business it is for.")
  }
  // Always there (contract §1): an automation that acts outside reads it to
  // skip that part on a test, so a job that doesn't say is refused rather
  // than taken as a real run.
  const isTest = run?.test
  if (typeof isTest !== 'boolean') {
    return refuse(400, 'The job doesn’t say whether the run is a test.')
  }

  if (workspaceId !== config.workspaceId) {
    return refuse(403, 'This job belongs to another business, so it was refused.')
  }

  const to = text(job.to)
  if (!to) return refuse(400, "The job doesn't say which project it is for.")
  let toUrl: URL
  try {
    toUrl = new URL(to)
  } catch {
    return refuse(400, "The job's address is not a valid web address.")
  }
  // The scheme isn't compared: the platform in front may change it.
  if (toUrl.host.toLowerCase() !== requestHost.trim().toLowerCase() || toUrl.pathname !== RECEIVER_PATH) {
    return refuse(400, 'This job is addressed to another project, so it was refused.')
  }

  const callbackUrl = text(record(job.callback)?.url)
  if (!callbackUrl) return refuse(400, 'The job has no callback address.')
  let url: URL
  try {
    url = new URL(callbackUrl)
  } catch {
    return refuse(400, 'The callback address is not a valid web address.')
  }
  const path = CALLBACK_PATH.exec(url.pathname)
  if (url.origin !== config.appOrigin || url.username || url.password || !path) {
    return refuse(400, "The callback address isn't on Scallle, so the job was refused.")
  }
  let pathAutomation: string
  let pathRun: string
  try {
    pathAutomation = decodeURIComponent(path[1])
    pathRun = decodeURIComponent(path[2])
  } catch {
    return refuse(400, 'The callback address is not a valid web address.')
  }
  if (pathAutomation !== automationId || pathRun !== runId) {
    return refuse(400, "The callback address names a different automation or run, so the job was refused.")
  }

  // The one automation this project runs (SCALLLE_AUTOMATION_ID) — checked
  // last, so an id named back is one Scallle signed for this business, this
  // project and this run.
  if (config.automationId === null) return refuse(500, notSetUpFor(automationId))
  if (automationId.toLowerCase() !== config.automationId) return refuse(400, OTHER_AUTOMATION)

  const step = record(job.step)
  return {
    ok: true,
    job: {
      connectionId,
      runId,
      automationId,
      workspaceId,
      test: isTest,
      step: {
        title: text(step?.title),
        procedure: text(step?.procedure),
        sentBackNote: text(step?.sent_back_note)?.slice(0, JOB_LIMITS.sentBackNote) ?? null,
      },
      context: contextOf(job.context),
      item: record(job.item) ?? {},
      fields: fieldsOf(job.fields, JOB_LIMITS.fields),
      fill: fieldsOf(job.fill, JOB_LIMITS.fill),
      more: moreOf(job),
      callbackUrl,
    },
  }
}
