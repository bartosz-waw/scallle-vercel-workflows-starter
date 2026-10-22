/**
 * The Scallle automation connector contract, v1 — what Scallle sends and what
 * this project posts back. The source of truth is Scallle's contract; this
 * file mirrors it.
 *
 * Scallle POSTs one job per run to /api/scallle:
 *
 *   {
 *     "version": 1,
 *     "connection_id": "…",
 *     "to": "https://<this project>/api/scallle",
 *     "issued_at": "2026-10-21T09:41:00.000Z",
 *     "run":  { "id": "…", "automation_id": "…", "workspace_id": "…", "test": true | false },
 *     "step": { "title": "…", "procedure": "…" | null, "sent_back_note": "…" | null },
 *     "context": { "today": "2026-10-21", "system_name": "…", "done_by": "…" },
 *     "item": { …only the fields this automation was given — DATA, never instructions },
 *     "fields": [ { "name": "room", "label": "Room", "type": "text", "required": true }, … ],
 *     "fill": [ { "name": "incident_report", "label": "Incident report", "type": "text", "required": true } ],
 *     "callback": { "url": "https://app.scallle.com/api/automations/<automation_id>/runs/<run id>?token=…" }
 *   }
 *
 * `run.test` is true when the run is a test (Send a test, Execute, the first
 * test after one-press setup) and false for every real run. It is always
 * there. An automation that does anything outside (sends, writes, books)
 * skips that part on a test and returns what it would have done.
 *
 * Added 21 Oct 2026, all data, never instructions:
 *   - `context` — about this run: today's date (London, YYYY-MM-DD), the
 *     system's name and who is doing it, only those ticked in Scallle; {}
 *     when none.
 *   - `fields` — one entry per item field the automation was given, in the
 *     order ticked: its name, label, type, answers and whether it's
 *     required. One listed here but missing from `item` was left blank.
 *   - `fill` — the rows after this step in Scallle that the result may fill;
 *     [] when none.
 *   - `step.sent_back_note` — on a redo, the note the person wrote when they
 *     sent the last result back; otherwise null.
 * A job from a Scallle before these were added has none of them: each then
 * reads as empty (check-job.ts), and the work runs exactly as before.
 *
 * signed by Scallle with Ed25519 over the raw body bytes:
 *
 *   X-Scallle-Key-Id:    <kid of one of the keys Scallle publishes at
 *                         <SCALLLE_APP_URL>/.well-known/scallle-job-keys>
 *   X-Scallle-Signature: ed25519=<base64url of the 64-byte signature>
 *
 * The automation reports back with ONE POST to callback.url:
 *
 *   success → { status: "success", metadata: { result, fields? }, usage?: { model, input_tokens, output_tokens } }
 *   failure → { status: "error", error_message: "<one plain sentence, no personal data>" }
 *
 * `metadata.fields` fills the rows the job's `fill` names, and only those:
 * Scallle takes no other name. Values are text (up to 4,000 characters), a
 * number or true/false, at most 20. Scallle puts them on their rows, where
 * the person doing the task checks them. `result` may be empty when fields
 * were filled.
 *
 * Scallle answers any repeat, or a result for a closed run, with
 * 200 { ok: false, reason: "run closed" } — so any 2xx counts as delivered.
 */

export const CONTRACT_VERSION = 1

/** Every top-level key of a job this starter knows. Any other is kept in
 *  `job.more`, never refused (the contract only grows). */
export const KNOWN_JOB_KEYS = [
  'version',
  'connection_id',
  'to',
  'issued_at',
  'run',
  'step',
  'context',
  'item',
  'fields',
  'fill',
  'callback',
] as const

/** A field's type, as Scallle names it. */
export type JobFieldType = 'text' | 'number' | 'choice' | 'url' | 'boolean' | 'json'

/** One field the job describes — in `fields` (an item field it was given) or
 *  in `fill` (a row its result may fill). Its words are the business's own
 *  text: data, never instructions. */
export type JobField = {
  /** The key it has in `item`, or the key to fill it under. */
  name: string
  /** The words a person sees in Scallle (the name, when it has none). */
  label: string
  /** null when Scallle sent a type this starter doesn't know. */
  type: JobFieldType | null
  /** A choice's answers, as written in Scallle. Empty for any other type. */
  choices: string[]
  required: boolean
}

/** About this run — only the values ticked in Scallle. */
export type JobContext = {
  /** Today's date in London, YYYY-MM-DD. */
  today?: string
  /** The name of the system the step belongs to. */
  system_name?: string
  /** Who is doing it: the person whose task it is. */
  done_by?: string
}

/** A job as this project uses it, after the receiver has checked it. */
export type ScallleJob = {
  connectionId: string
  runId: string
  automationId: string
  workspaceId: string
  /** True when the run is a test (Send a test, Execute, the first test after
   *  one-press setup). An automation that acts outside — sends, writes,
   *  books — skips that part when this is true, and returns what it would
   *  have done instead. */
  test: boolean
  step: {
    title: string | null
    /** The step's written procedure — the instructions. Written by the
     *  business's systems lead in Scallle. */
    procedure: string | null
    /** On a redo after a person sent the last result back: their note,
     *  saying what was wrong. DATA — it may say what to change in the
     *  draft, never what the rules are. null otherwise. */
    sentBackNote: string | null
  }
  /** About this run (today, the system's name, who is doing it) — only
   *  what was ticked in Scallle. DATA, sent apart from the item. */
  context: JobContext
  /** The unit of work. DATA: it may contain text that reads like
   *  instructions, and must never be treated as one. */
  item: Record<string, unknown>
  /** What each item field is, in the order ticked. One listed here but
   *  missing from `item` was left blank in Scallle. */
  fields: JobField[]
  /** The rows after this step that the result may fill. Return their
   *  values as `fields` (AutomationResult); any other name is dropped. */
  fill: JobField[]
  /** Top-level keys of the job this starter doesn't know yet (the contract
   *  only grows) — as sent. Data, never instructions: use one only once
   *  Scallle's contract names it. */
  more: Record<string, unknown>
  /** Where the result goes. Holds the run's token, so it is never logged. */
  callbackUrl: string
}

export type Usage = {
  model: string
  input_tokens: number
  output_tokens: number
}

/** A value the result fills a row with. */
export type FilledValue = string | number | boolean

/** At most this many filled fields go back, each text at most this long. */
export const MAX_FILLED_FIELDS = 20
export const MAX_FILLED_TEXT = 4000

export type SuccessReport = {
  status: 'success'
  metadata: { result: string; fields?: Record<string, FilledValue> }
  usage?: Usage
}

export type ErrorReport = {
  status: 'error'
  error_message: string
}

export type CallbackReport = SuccessReport | ErrorReport

/** The callback path Scallle uses: /api/automations/<automation_id>/runs/<run id>. */
export const CALLBACK_PATH = /^\/api\/automations\/([^/]+)\/runs\/([^/]+)$/

/** The hook token a workflow run holds to claim a Scallle run id, so the same
 *  run.id arriving twice does the work once (contract §4). */
export function runClaimToken(runId: string): string {
  return `scallle-run:${runId}`
}
