import { describe, expect, it } from 'vitest'

import { checkJob, JOB_LIMITS } from '../src/lib/check-job'
import type { ScallleJob } from '../src/lib/contract'

/**
 * The parts of a job that only describe the work (contract §1, added 21 Oct
 * 2026): `context`, `fields`, `fill` and `step.sent_back_note`. They are read
 * as far as they make sense and never refused, and every top-level key the
 * starter doesn't know is kept in `job.more`. The receiver's own checks are
 * in receiver.test.ts.
 */

/** TEST ONLY ids. */
const WORKSPACE = '11111111-1111-4111-8111-111111111111'
const AUTOMATION = '33333333-3333-4333-8333-333333333333'
const APP = 'https://app.scallle.test'
const HOST = 'kit-test.example'
const CONFIG = { workspaceId: WORKSPACE, automationId: AUTOMATION, appOrigin: APP }

function body(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    connection_id: 'conn_1',
    to: `https://${HOST}/api/scallle`,
    issued_at: new Date().toISOString(),
    run: { id: 'run_1', automation_id: AUTOMATION, workspace_id: WORKSPACE, test: false },
    step: { title: 'Draft the incident report', procedure: 'Draft an incident report.' },
    item: { room: '12B' },
    callback: { url: `${APP}/api/automations/${AUTOMATION}/runs/run_1?token=tok` },
    ...overrides,
  }
}

function accepted(overrides: Record<string, unknown> = {}): ScallleJob {
  const r = checkJob(body(overrides), CONFIG, HOST)
  if (!r.ok) throw new Error(`refused: ${r.status} ${r.error}`)
  return r.job
}

describe('a job from a Scallle before 21 Oct 2026 (none of the new parts)', () => {
  it('is accepted, and each new part reads as empty', () => {
    const job = accepted()
    expect(job.step).toEqual({ title: 'Draft the incident report', procedure: 'Draft an incident report.', sentBackNote: null })
    expect(job.context).toEqual({})
    expect(job.fields).toEqual([])
    expect(job.fill).toEqual([])
    expect(job.more).toEqual({})
  })
})

describe('the new parts, as Scallle sends them', () => {
  const sent = {
    step: { title: 'Draft', procedure: 'Draft it.', sent_back_note: '  Too long — one paragraph.  ' },
    context: { today: '2026-10-21', system_name: 'Incident reports', done_by: 'Test Person' },
    fields: [
      { name: 'room', label: 'Room', type: 'text', required: true },
      { name: 'was_anyone_hurt', label: 'Was anyone hurt?', type: 'choice', choices: ['Yes', 'No'], required: true },
      { name: 'what_happened', label: 'What happened', type: 'text', required: false },
    ],
    fill: [{ name: 'incident_report', label: 'Incident report', type: 'text', required: true }],
  }

  it('come through: the note trimmed, every field with its label, type, answers and required', () => {
    const job = accepted(sent)
    expect(job.step.sentBackNote).toBe('Too long — one paragraph.')
    expect(job.context).toEqual(sent.context)
    expect(job.fields).toEqual([
      { name: 'room', label: 'Room', type: 'text', choices: [], required: true },
      { name: 'was_anyone_hurt', label: 'Was anyone hurt?', type: 'choice', choices: ['Yes', 'No'], required: true },
      { name: 'what_happened', label: 'What happened', type: 'text', choices: [], required: false },
    ])
    expect(job.fill).toEqual([{ name: 'incident_report', label: 'Incident report', type: 'text', choices: [], required: true }])
  })
})

describe('malformed new parts are never refused', () => {
  it.each<[string, Record<string, unknown>]>([
    ['context a string', { context: 'today' }],
    ['context an array', { context: ['today'] }],
    ['fields an object', { fields: { room: 'Room' } }],
    ['fill a string', { fill: 'incident_report' }],
    ['fields null', { fields: null }],
    ['a note that is a number', { step: { title: 'Draft', procedure: null, sent_back_note: 42 } }],
  ])('%s → accepted, read as empty', (_name, overrides) => {
    const job = accepted(overrides)
    expect(job.context).toEqual({})
    expect(job.fields).toEqual([])
    expect(job.fill).toEqual([])
    expect(job.step.sentBackNote).toBeNull()
  })

  it('context keeps only its three keys, each a non-empty string, cut to 200 characters', () => {
    const job = accepted({
      context: { today: ' 2026-10-21 ', system_name: '', done_by: 7, item: 'not a context key', more: { x: 1 } },
    })
    expect(job.context).toEqual({ today: '2026-10-21' })
    expect(accepted({ context: { system_name: 's'.repeat(500) } }).context.system_name).toHaveLength(JOB_LIMITS.contextText)
  })

  it('a field entry needs a well-formed name; the rest falls back or is left out', () => {
    const job = accepted({
      fields: [
        'room',
        null,
        { label: 'No name' },
        { name: 'has space', label: 'Bad name' },
        { name: 'x'.repeat(65) },
        { name: 'room', label: 'Room', type: 'date', choices: 'Yes', required: 'yes' },
        { name: 'room', label: 'A second room' },
        { name: 'kind', label: '  ', type: 'choice', choices: ['A', 7, '', 'c'.repeat(121), ' B '] },
      ],
    })
    expect(job.fields).toEqual([
      { name: 'room', label: 'Room', type: null, choices: [], required: false },
      { name: 'kind', label: 'kind', type: 'choice', choices: ['A', 'B'], required: false },
    ])
  })

  it('at most 50 fields and 20 rows to fill, 20 answers each, labels cut to 200 characters', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `f${i}`, label: 'L'.repeat(300), type: 'text' }))
    const job = accepted({
      fields: many(60),
      fill: many(30),
      step: { title: 'Draft', procedure: null, sent_back_note: 'n'.repeat(3000) },
    })
    expect(job.fields).toHaveLength(JOB_LIMITS.fields)
    expect(job.fill).toHaveLength(JOB_LIMITS.fill)
    expect(job.fields[0].label).toHaveLength(JOB_LIMITS.label)
    expect(job.step.sentBackNote).toHaveLength(JOB_LIMITS.sentBackNote)
    const choices = accepted({ fill: [{ name: 'c', type: 'choice', choices: Array.from({ length: 30 }, (_, i) => `a${i}`) }] })
    expect(choices.fill[0].choices).toHaveLength(JOB_LIMITS.choices)
  })

  it('a blank note reads as no note', () => {
    expect(accepted({ step: { title: 'Draft', procedure: null, sent_back_note: '   ' } }).step.sentBackNote).toBeNull()
  })
})

describe('keys the contract doesn’t name yet', () => {
  it('are kept, as sent, in job.more — never refused', () => {
    const job = accepted({ future_part: { anything: true }, notes_for_later: ['a', 'b'] })
    expect(job.more).toEqual({ future_part: { anything: true }, notes_for_later: ['a', 'b'] })
  })

  it('job.more never holds a key the contract names', () => {
    const job = accepted({ context: {}, fields: [], fill: [], extra: 1 })
    expect(Object.keys(job.more)).toEqual(['extra'])
  })

  it('the checks still come first: a job for another business is refused whatever else it holds', () => {
    const r = checkJob(
      body({ run: { id: 'run_1', automation_id: AUTOMATION, workspace_id: '22222222-2222-4222-8222-222222222222', test: false }, future_part: 1 }),
      CONFIG,
      HOST
    )
    expect(r).toMatchObject({ ok: false, status: 403 })
  })
})
