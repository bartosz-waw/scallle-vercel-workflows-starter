import {
  MAX_FILLED_FIELDS,
  MAX_FILLED_TEXT,
  type FilledValue,
  type JobField,
  type ScallleJob,
} from './contract'

/**
 * What Claude is given besides the procedure, and what comes back from its
 * answer. Plain functions only: workflow code calls them, so this file never
 * imports claude.ts (npm run build fails if workflow code reaches the
 * project's Vercel sign-in).
 *
 *   promptFor(job)        the user message: the item, and — when the job
 *                         carries them — what each field is, about this run,
 *                         a person's send-back note and the rows it may fill.
 *                         All of it data, each part in its own tags, `<`
 *                         escaped so nothing in it can close a tag.
 *   extrasOf(job)         what systemPromptFor needs to know about that
 *                         message (never its text): the rules for the extra
 *                         parts are written in code, never taken from the job.
 *   readReply(text, fill) Claude's draft, and the values it filled for the
 *                         rows in `fill`, coerced to each row's type.
 *   filledFieldsFor(...)  only the names the job's `fill` lists, as Scallle
 *                         takes them — runForScallle sends nothing else.
 *
 * A job with none of the new parts (from a Scallle before 21 Oct 2026, or
 * one that ticked nothing) gets exactly the message and rules it always did.
 */

/** A job's parts read with defaults, so a job built by hand without the
 *  new parts still works. */
function partsOf(job: ScallleJob) {
  return {
    context: job.context ?? {},
    fields: job.fields ?? [],
    fill: job.fill ?? [],
    note: job.step?.sentBackNote ?? null,
  }
}

/** True when the job carries anything besides the item for Claude to read. */
export function hasExtras(job: ScallleJob): boolean {
  const { context, fields, fill, note } = partsOf(job)
  return Object.keys(context).length > 0 || fields.length > 0 || fill.length > 0 || Boolean(note)
}

/** What the system prompt needs to know about the user message: false when
 *  it is the item alone, as it always was. */
export type PromptExtras = false | { fill: boolean }

export function extrasOf(job: ScallleJob): PromptExtras {
  return hasExtras(job) ? { fill: partsOf(job).fill.length > 0 } : false
}

/** `<` as `\u003c`, so data can never close (or open) a tag. Inside JSON
 *  strings that is still valid JSON. */
const escapeTags = (text: string) => text.replace(/</g, '\\u003c')

/** One line, whatever the business typed. */
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

/** "- room: “Room” (text, required)" — what one field is. */
function fieldLine(field: JobField, leftBlank: boolean): string {
  // A choice's answers are listed, so "required" follows them after a semicolon.
  const listed = field.type === 'choice' && field.choices.length > 0
  const kind = listed ? `one of: ${field.choices.map((c) => `“${oneLine(c)}”`).join(', ')}` : field.type
  const about = [kind, field.required ? 'required' : null].filter(Boolean).join(listed ? '; ' : ', ')
  return `- ${field.name}: “${oneLine(field.label)}”${about ? ` (${about})` : ''}${leftBlank ? ' — left blank' : ''}`
}

function section(tag: string, body: string): string {
  return `<${tag}>\n${escapeTags(body)}\n</${tag}>`
}

/**
 * The user message for Claude. The item alone, as JSON, when the job carries
 * nothing else — byte for byte what this starter always sent. Otherwise the
 * item inside <item> tags, then each other part in its own tags, only those
 * with something in them.
 */
export function promptFor(job: ScallleJob): string {
  const item = job.item ?? {}
  if (!hasExtras(job)) return JSON.stringify(item, null, 2)
  const { context, fields, fill, note } = partsOf(job)
  const sections = [section('item', JSON.stringify(item, null, 2))]
  if (fields.length > 0) {
    sections.push(section('fields', fields.map((f) => fieldLine(f, !Object.hasOwn(item, f.name))).join('\n')))
  }
  if (Object.keys(context).length > 0) sections.push(section('about_this_run', JSON.stringify(context, null, 2)))
  if (note) sections.push(section('sent_back_note', note))
  if (fill.length > 0) sections.push(section('fill', fill.map((f) => fieldLine(f, false)).join('\n')))
  return sections.join('\n')
}

/** A filled value made to fit its row's type, or undefined to leave it out. */
function coerce(raw: string, field: JobField): FilledValue | undefined {
  const value = raw.trim()
  if (!value) return undefined
  switch (field.type) {
    case 'number': {
      const n = Number(value)
      return Number.isFinite(n) ? n : undefined
    }
    case 'boolean': {
      const word = value.toLowerCase()
      if (word === 'yes' || word === 'true') return true
      if (word === 'no' || word === 'false') return false
      return undefined
    }
    case 'choice': {
      // A choice row with no answers listed: Scallle matches it to the row.
      if (field.choices.length === 0) return value.slice(0, MAX_FILLED_TEXT)
      return field.choices.find((c) => c.trim().toLowerCase() === value.toLowerCase())
    }
    default:
      return value.slice(0, MAX_FILLED_TEXT)
  }
}

const FIELD_TAG = /<field\s+name\s*=\s*"([^"]*)"\s*>([\s\S]*?)<\/field>/g
const RESULT_TAG = /<result>([\s\S]*?)<\/result>/

/**
 * Claude's answer as Scallle takes it. With nothing to fill, the whole text
 * is the result. With rows to fill, each `<field name="NAME">VALUE</field>`
 * whose NAME the job's `fill` lists (the first one of each name) is made to
 * fit that row's type — a number, one of a choice's answers, yes or no —
 * or left out; the result is what is inside `<result>…</result>` (with no
 * such tag, the whole text), with every field tag taken out — one Claude
 * wrote inside the draft never lands on the step as text.
 */
export function readReply(
  text: string,
  fill: readonly JobField[] = []
): { result: string; fields?: Record<string, FilledValue> } {
  if (fill.length === 0) return { result: text }
  const byName = new Map(fill.map((f) => [f.name, f]))
  const fields: Record<string, FilledValue> = {}
  for (const [, name, raw] of text.matchAll(FIELD_TAG)) {
    const field = byName.get(name)
    if (!field || Object.hasOwn(fields, name)) continue
    const value = coerce(raw, field)
    if (value !== undefined) fields[name] = value
  }
  const tagged = RESULT_TAG.exec(text)
  const result = (tagged ? tagged[1] : text).replace(FIELD_TAG, '').trim()
  return Object.keys(fields).length > 0 ? { result, fields } : { result }
}

/**
 * Only what Scallle takes back: names the job's `fill` lists, as text (up to
 * 4,000 characters), a finite number or true/false, at most 20. Undefined
 * when nothing is left, so the report has no `fields` at all.
 */
export function filledFieldsFor(
  fill: readonly JobField[] = [],
  fields: Record<string, unknown> | null | undefined
): Record<string, FilledValue> | undefined {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return undefined
  const out: Record<string, FilledValue> = {}
  for (const { name } of fill) {
    if (Object.keys(out).length >= MAX_FILLED_FIELDS) break
    if (!Object.hasOwn(fields, name)) continue
    const value = fields[name]
    if (typeof value === 'string' && value.trim()) out[name] = value.slice(0, MAX_FILLED_TEXT)
    else if (typeof value === 'number' && Number.isFinite(value)) out[name] = value
    else if (typeof value === 'boolean') out[name] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}
