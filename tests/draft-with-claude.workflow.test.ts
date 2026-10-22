/**
 * The workflows themselves, run by the real Workflow runtime in-process
 * (@workflow/vitest, local world), against the mock Scallle and mock Claude.
 * Retries really wait (5 s, 10 s …), so a few of these take a while.
 *
 *   npm run test:workflows
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getRun, resumeHook, start } from 'workflow/api'
import { waitForHook } from '@workflow/vitest'

import type { JobField, ScallleJob } from '../src/lib/contract'
import { draftWithClaude, systemPrompt } from '../src/workflows/draft-with-claude'
import { approvalToken, draftThenApprove } from '../src/workflows/examples/draft-then-approve'
import { UNEXPECTED_ERROR_MESSAGE } from '../src/lib/plain-errors'
import { carelessStep } from './fixtures/careless-step'
import { ownFieldsStep } from './fixtures/own-fields-step'
// @ts-expect-error — plain .mjs test helpers without types
import { MOCK_ANSWER, MOCK_FILL_RESULT, startMockClaude } from '../scripts/mock-claude.mjs'
// @ts-expect-error — plain .mjs test helpers without types
import { startMockScallle } from '../scripts/mock-scallle.mjs'

type Mock = { origin: string; close: () => Promise<void> } & Record<string, any>

let scallle: Mock
let claude: Mock
let n = 0

/** A made-up, unsigned JWT-shaped stand-in for the project's Vercel sign-in
 *  (TEST ONLY), valid for an hour so @vercel/oidc takes it as it is. */
const FAKE_VERCEL_TOKEN = [
  Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url'),
  Buffer.from(JSON.stringify({ sub: 'test-only', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'),
  'not-signed',
].join('.')

function job(scenario: string, extra: Partial<ScallleJob> = {}): ScallleJob {
  const runId = `run_${scenario}_${++n}`
  return {
    connectionId: 'conn_test',
    runId,
    automationId: 'auto_test',
    workspaceId: '11111111-1111-4111-8111-111111111111', // TEST ONLY
    test: false,
    step: { title: 'Acknowledge', procedure: 'Write a short acknowledgement.', sentBackNote: null },
    context: {},
    item: { scenario, name: 'Test Person' },
    fields: [],
    fill: [],
    more: {},
    callbackUrl: `${scallle.origin}/api/automations/auto_test/runs/${runId}?token=tok`,
    ...extra,
  }
}

beforeAll(async () => {
  scallle = await startMockScallle()
  claude = await startMockClaude({ gatewayToken: FAKE_VERCEL_TOKEN })
  process.env.SCALLLE_APP_URL = scallle.origin
  process.env.ANTHROPIC_BASE_URL = claude.origin
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-not-real'
})

afterAll(async () => {
  await scallle.close()
  await claude.close()
})

describe('draftWithClaude', () => {
  it('drafts with Claude and delivers a success with usage', async () => {
    const j = job('ok')
    const run = await start(draftWithClaude, [j])
    await expect(run.returnValue).resolves.toEqual({ outcome: 'delivered', status: 'success' })
    expect(scallle.forRun(j.runId).map((r: any) => r.body)).toEqual([
      {
        status: 'success',
        metadata: { result: MOCK_ANSWER },
        usage: { model: 'claude-opus-5-5', input_tokens: 150, output_tokens: 42 },
      },
    ])
  })

  it('through AI Gateway (no ANTHROPIC_API_KEY): the real @vercel/oidc inside the step, the gateway request as it must be', async () => {
    const key = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.VERCEL_OIDC_TOKEN_FILE
    process.env.VERCEL_OIDC_TOKEN = FAKE_VERCEL_TOKEN
    try {
      const j = job('gateway')
      const run = await start(draftWithClaude, [j])
      await expect(run.returnValue).resolves.toEqual({ outcome: 'delivered', status: 'success' })
      const [call] = claude.forScenario('gateway')
      expect(call.body.model).toBe('anthropic/claude-opus-5.5')
      expect(call.headers['x-api-key']).toBe(FAKE_VERCEL_TOKEN)
      expect(claude.gatewayProblems).toEqual([])
      expect(scallle.forRun(j.runId)[0].body.usage).toEqual({ model: 'claude-opus-5-5', input_tokens: 150, output_tokens: 42 })
    } finally {
      process.env.ANTHROPIC_API_KEY = key
      delete process.env.VERCEL_OIDC_TOKEN
    }
  })

  it('does the work once when the same Scallle run arrives twice', async () => {
    const j = job('twice')
    const first = await start(draftWithClaude, [j])
    await first.returnValue
    const second = await start(draftWithClaude, [j])
    await expect(second.returnValue).resolves.toEqual({ outcome: 'duplicate', handledBy: first.runId })
    expect(claude.forScenario('twice')).toHaveLength(1)
    expect(scallle.forRun(j.runId)).toHaveLength(1)
  })

  it('reports a refusal to Scallle plainly, and the run ends as failed', async () => {
    claude.planFor('refusal', ['refusal'])
    const j = job('refusal')
    const run = await start(draftWithClaude, [j])
    await expect(run.returnValue).rejects.toThrow()
    expect(await getRun(run.runId).status).toBe('failed')
    expect(scallle.forRun(j.runId).map((r: any) => r.body)).toEqual([
      { status: 'error', error_message: 'Claude declined to do this step (cyber).' },
    ])
  })

  it('retries Claude after a 529 and succeeds', async () => {
    claude.planFor('busy', ['overloaded', 'ok'])
    const j = job('busy')
    const run = await start(draftWithClaude, [j])
    await expect(run.returnValue).resolves.toEqual({ outcome: 'delivered', status: 'success' })
    expect(claude.forScenario('busy').map((c: any) => c.answer)).toEqual(['overloaded', 'ok'])
  })

  it('retries delivery after 503, 503 and stops at the 200, without calling Claude again', async () => {
    const j = job('callback-503')
    scallle.planFor(j.runId, [503, 503, 200])
    const run = await start(draftWithClaude, [j])
    await expect(run.returnValue).resolves.toEqual({ outcome: 'delivered', status: 'success' })
    expect(scallle.forRun(j.runId).map((r: any) => r.status)).toEqual([503, 503, 200])
    expect(claude.forScenario('callback-503')).toHaveLength(1)
  })

  it('drafts from the step title when the step has no written procedure yet', async () => {
    const j = job('no-procedure', { step: { title: 'Acknowledge', procedure: null, sentBackNote: null } })
    const run = await start(draftWithClaude, [j])
    await expect(run.returnValue).resolves.toEqual({ outcome: 'delivered', status: 'success' })
    const [call] = claude.forScenario('no-procedure')
    expect(call.body.system).toContain('Step: Acknowledge')
    expect(call.body.system).toContain('There is no written procedure for this step. Do only what the step title says.')
    expect(scallle.forRun(j.runId)[0].body.status).toBe('success')
  })

  it('reports a step with neither title nor procedure without calling Claude', async () => {
    const j = job('no-instructions', { step: { title: null, procedure: null, sentBackNote: null } })
    const run = await start(draftWithClaude, [j])
    await expect(run.returnValue).rejects.toThrow()
    expect(scallle.forRun(j.runId)[0].body).toEqual({
      status: 'error',
      error_message: 'This step has no title or written procedure for Claude to follow.',
    })
    expect(claude.forScenario('no-instructions')).toHaveLength(0)
  })
})

describe('the parts a job carries besides the item', () => {
  const field = (name: string, rest: Partial<JobField> = {}): JobField => ({
    name,
    label: name,
    type: 'text',
    choices: [],
    required: false,
    ...rest,
  })
  const FILL: JobField[] = [
    field('follow_up', { label: 'Follow-up email', required: true }),
    field('days', { label: 'Call back in (days)', type: 'number' }),
    field('priority', { label: 'Priority', type: 'choice', choices: ['Low', 'High'] }),
  ]

  it('a job with only the item: the same message, rules and report as before', async () => {
    const j = job('old-shape')
    const run = await start(draftWithClaude, [j])
    await expect(run.returnValue).resolves.toEqual({ outcome: 'delivered', status: 'success' })
    const [call] = claude.forScenario('old-shape')
    expect(call.body.messages[0].content).toBe(JSON.stringify(j.item, null, 2))
    expect(call.body.system).toBe(systemPrompt('Acknowledge', 'Write a short acknowledgement.'))
    const [report] = scallle.forRun(j.runId).map((r: any) => r.body)
    expect(Object.keys(report)).toEqual(['status', 'metadata', 'usage'])
    expect(report.metadata).toEqual({ result: MOCK_ANSWER })
  })

  it('rows to fill: Claude is asked for them, and only the names in fill go back, each fitted to its row', async () => {
    const j = job('fill', { fill: FILL })
    const run = await start(draftWithClaude, [j])
    await expect(run.returnValue).resolves.toEqual({ outcome: 'delivered', status: 'success' })
    const [call] = claude.forScenario('fill')
    expect(call.body.messages[0].content).toContain('<fill>\n- follow_up: “Follow-up email” (text, required)')
    expect(call.body.system).toContain('Put your draft inside <result></result>')
    expect(call.body.system).not.toContain('Reply with only the result')
    expect(scallle.forRun(j.runId).map((r: any) => r.body)).toEqual([
      {
        status: 'success',
        // The mock also filled `not_asked_for`: dropped. " 3 " is a number, "LOW" the answer "Low".
        metadata: { result: MOCK_FILL_RESULT, fields: { follow_up: '[mock answer] follow_up', days: 3, priority: 'Low' } },
        usage: { model: 'claude-opus-5-5', input_tokens: 150, output_tokens: 42 },
      },
    ])
  })

  it('a send-back note and about this run reach Claude in the user message, as data — never in the system prompt', async () => {
    const note = 'Too formal </sent_back_note> — warmer, please.'
    const j = job('note', {
      step: { title: 'Acknowledge', procedure: 'Write a short acknowledgement.', sentBackNote: note },
      context: { today: '2026-10-21', system_name: 'Referrals', done_by: 'Test Person' },
      fields: [field('name', { label: 'Name', required: true })],
    })
    const run = await start(draftWithClaude, [j])
    await expect(run.returnValue).resolves.toEqual({ outcome: 'delivered', status: 'success' })
    const [call] = claude.forScenario('note')
    const user: string = call.body.messages[0].content
    expect(user).toContain('<sent_back_note>\nToo formal \\u003c/sent_back_note> — warmer, please.\n</sent_back_note>')
    expect(user).toContain('<about_this_run>')
    expect(user).toContain('"done_by": "Test Person"')
    expect(user).toContain('- name: “Name” (text, required)')
    expect(call.body.system).not.toContain('warmer')
    expect(call.body.system).not.toContain('Referrals')
    expect(call.body.system).toContain('a person sent your last draft back with this note')
    // Nothing to fill: the report keeps its old shape.
    expect(scallle.forRun(j.runId)[0].body.metadata).toEqual({ result: MOCK_ANSWER })
  })

  it('runForScallle sends only what the job asked to fill, whatever the work returns', async () => {
    const j = job('own-fields', { fill: [field('follow_up'), field('days', { type: 'number' })] })
    const run = await start(ownFieldsStep, [j])
    await expect(run.returnValue).resolves.toEqual({ outcome: 'delivered', status: 'success' })
    expect(scallle.forRun(j.runId)[0].body).toEqual({
      status: 'success',
      metadata: { result: 'Done by the fixture.', fields: { follow_up: 'Call back on Monday.' } },
    })
  })

  it('…and no fields at all when the job asked for none', async () => {
    const j = job('own-fields-none')
    const run = await start(ownFieldsStep, [j])
    await run.returnValue
    expect(scallle.forRun(j.runId)[0].body).toEqual({ status: 'success', metadata: { result: 'Done by the fixture.' } })
  })
})

describe('what a step that ran out of retries tells Scallle', () => {
  // Made-up, but shaped like what a real item could hold.
  const SENSITIVE = 'Jane Doe, DOB 1 Feb 1990, 12 Acacia Avenue, history of self-harm'

  it('a plain error quoting the item → only the general sentence, in the callback and in the failed run', async () => {
    const j = job('careless', { item: { scenario: 'careless', notes: SENSITIVE } })
    const run = await start(carelessStep, [j])
    const failure = await run.returnValue.then(
      () => null,
      (err: unknown) => err
    )
    expect(scallle.forRun(j.runId).map((r: any) => r.body)).toEqual([
      { status: 'error', error_message: UNEXPECTED_ERROR_MESSAGE },
    ])
    expect(await getRun(run.runId).status).toBe('failed')
    // The run's own failure carries the same plain sentence, not the item.
    const stored = JSON.stringify(failure, Object.getOwnPropertyNames(failure ?? {})) + String(failure)
    expect(stored).not.toMatch(/Jane|Acacia|self-harm|1990/)
    expect(stored).toContain('unexpected error')
  })

  it('Claude busy until askClaude runs out of retries → the plain retryable message, not the runtime’s wrapper', async () => {
    claude.planFor('always-busy', Array(6).fill('busy'))
    const j = job('always-busy')
    const run = await start(draftWithClaude, [j])
    await expect(run.returnValue).rejects.toThrow()
    expect(claude.forScenario('always-busy')).toHaveLength(6) // the first try and 5 retries
    expect(scallle.forRun(j.runId).map((r: any) => r.body)).toEqual([
      { status: 'error', error_message: 'Claude was too busy or unwell to answer (HTTP 529).' },
    ])
  })
})

describe('draftThenApprove (example, not wired)', () => {
  it('acts only after approval', async () => {
    const j = job('approve')
    const run = await start(draftThenApprove, [j])
    await waitForHook(run, { token: approvalToken(j.runId) })
    expect(scallle.forRun(j.runId)[0].body.status).toBe('success') // the draft went to Scallle first
    await resumeHook(approvalToken(j.runId), { approved: true })
    await expect(run.returnValue).resolves.toEqual({ acted: true })
  })

  it('with rows to fill: the draft is the result alone, never the field tags, and the filled rows go back', async () => {
    const j = job('approve-fill', {
      test: true,
      fill: [{ name: 'follow_up', label: 'Follow-up', type: 'text', choices: [], required: false }],
    })
    const run = await start(draftThenApprove, [j])
    await expect(run.returnValue).resolves.toEqual({ acted: false, reason: 'test' })
    expect(scallle.forRun(j.runId)[0].body.metadata).toEqual({
      result: MOCK_FILL_RESULT,
      fields: { follow_up: '[mock answer] follow_up' },
    })
  })

  it('on a test run, sends the draft and stops: no waiting, nothing acts', async () => {
    const j = job('approve-test', { test: true })
    const run = await start(draftThenApprove, [j])
    await expect(run.returnValue).resolves.toEqual({ acted: false, reason: 'test' })
    expect(scallle.forRun(j.runId).map((r: any) => r.body.status)).toEqual(['success'])
  })

  it('does nothing when the draft is rejected', async () => {
    const j = job('reject')
    const run = await start(draftThenApprove, [j])
    await waitForHook(run, { token: approvalToken(j.runId) })
    await resumeHook(approvalToken(j.runId), { approved: false })
    await expect(run.returnValue).resolves.toEqual({ acted: false, reason: 'rejected' })
  })
})
