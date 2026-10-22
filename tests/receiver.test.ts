import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HookNotFoundError } from 'workflow/errors'

import { forgetScallleKeys, KEYS_PATH } from '../src/lib/scallle-keys'
// @ts-expect-error — a plain .mjs test helper without types
import { signatureHeaders, TEST_KEY, TEST_STRAY_KEY } from '../scripts/test-signing-key.mjs'

// The receiver's only side effects are these two calls; everything else is checks.
const start = vi.fn()
const getHookByToken = vi.fn()
vi.mock('workflow/api', () => ({
  start: (...args: unknown[]) => start(...args),
  getHookByToken: (...args: unknown[]) => getHookByToken(...args),
}))

const { POST } = await import('../src/app/api/scallle/route')
const { WORKFLOW } = await import('../src/workflows')

/** Test workspace ids (TEST ONLY): this business, and another one. */
const WORKSPACE = '11111111-1111-4111-8111-111111111111'
const OTHER_WORKSPACE = '22222222-2222-4222-8222-222222222222'
/** Test automation ids (TEST ONLY): the one this project runs, and another one. */
const AUTOMATION = '33333333-3333-4333-8333-333333333333'
const OTHER_AUTOMATION = '55555555-5555-4555-8555-555555555555'

/** What the receiver answers about SCALLLE_AUTOMATION_ID (check-job.ts, config.ts). */
const S1A = `This project isn’t set up for its automation yet: set SCALLLE_AUTOMATION_ID to ${AUTOMATION} in its environment variables, then redeploy.`
const S1B = 'This project isn’t set up for its automation yet: set SCALLLE_AUTOMATION_ID to the step’s automation id in Scallle, then redeploy.'
const S2 = 'This project runs another automation, so the job was refused.'
const S3 = 'SCALLLE_AUTOMATION_ID isn’t an automation id. It must be the step’s automation id in Scallle, a UUID like 33333333-3333-4333-8333-333333333333.'
const APP = 'https://app.scallle.test'
const HOST = 'kit-test.example'
const TO = `https://${HOST}/api/scallle`

function job(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    connection_id: 'conn_1',
    to: TO,
    issued_at: new Date().toISOString(),
    run: { id: 'run_1', automation_id: AUTOMATION, workspace_id: WORKSPACE, test: false },
    step: { title: 'Acknowledge', procedure: 'Write a short acknowledgement.' },
    item: { name: 'Test Person' },
    callback: { url: `${APP}/api/automations/${AUTOMATION}/runs/run_1?token=tok` },
    ...overrides,
  }
}

type Sent = {
  /** null: no signature headers at all; an object: these headers instead. */
  signed?: null | Record<string, string>
  /** Sign with this key (TEST_KEY by default), under its own kid. */
  key?: unknown
  raw?: string
  headers?: Record<string, string>
}

function request(body: unknown, { signed, key = TEST_KEY, raw, headers = {} }: Sent = {}) {
  const text = raw ?? JSON.stringify(body)
  const sig = signed === undefined ? signatureHeaders(text, key) : (signed ?? {})
  return new Request(`https://${HOST}/api/scallle`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: HOST, ...sig, ...headers },
    body: text,
  })
}

async function send(body: unknown, opts?: Sent) {
  const res = await POST(request(body, opts))
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

/** Scallle's key document, as the project fetches it. */
let keyDocument: () => Response
const keyFetches = vi.fn()

beforeEach(() => {
  vi.stubEnv('SCALLLE_WORKSPACE_ID', WORKSPACE)
  vi.stubEnv('SCALLLE_AUTOMATION_ID', AUTOMATION)
  vi.stubEnv('SCALLLE_APP_URL', APP)
  vi.stubEnv('ANTHROPIC_API_KEY', '')
  vi.stubEnv('ANTHROPIC_BASE_URL', '')
  vi.stubEnv('VERCEL', '')
  forgetScallleKeys()
  keyDocument = () => Response.json({ keys: [TEST_KEY.jwk] })
  keyFetches.mockReset()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      keyFetches(url)
      return keyDocument()
    })
  )
  start.mockReset().mockResolvedValue({ runId: 'wrun_test' })
  getHookByToken.mockReset().mockRejectedValue(new HookNotFoundError('scallle-run:run_1'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('POST /api/scallle — a valid job', () => {
  it('starts WORKFLOW, this project’s one automation, with the checked job and answers 202 { accepted: true }', async () => {
    const res = await send(job())
    expect(res).toEqual({ status: 202, body: { accepted: true } })
    expect(start).toHaveBeenCalledTimes(1)
    const [workflow, args, options] = start.mock.calls[0]
    expect(workflow).toBe(WORKFLOW)
    expect(args).toEqual([
      {
        connectionId: 'conn_1',
        runId: 'run_1',
        automationId: AUTOMATION,
        workspaceId: WORKSPACE,
        test: false,
        step: { title: 'Acknowledge', procedure: 'Write a short acknowledgement.', sentBackNote: null },
        context: {},
        item: { name: 'Test Person' },
        fields: [],
        fill: [],
        more: {},
        callbackUrl: `${APP}/api/automations/${AUTOMATION}/runs/run_1?token=tok`,
      },
    ])
    // Run data is deleted when the run ends; only ids go in the labels.
    expect(options).toEqual({
      experimental_retention: 0,
      attributes: { scallle_run_id: 'run_1', scallle_automation_id: AUTOMATION },
    })
  })

  it('fetches Scallle’s keys only from SCALLLE_APP_URL’s origin, once', async () => {
    await send(job())
    await send(job())
    expect(keyFetches.mock.calls).toEqual([[`${APP}${KEYS_PATH}`]])
  })

  it('needs no ANTHROPIC_API_KEY (Claude then goes through AI Gateway)', async () => {
    expect((await send(job())).status).toBe(202)
  })

  it('accepts fields the contract does not name yet, and keeps them in job.more', async () => {
    const res = await send({ ...job(), future_field: { anything: true } })
    expect(res.status).toBe(202)
    expect(start.mock.calls[0][1][0].more).toEqual({ future_field: { anything: true } })
  })

  it('passes the parts that describe the work through: about this run, the fields, the rows to fill, a send-back note', async () => {
    const res = await send(
      job({
        step: { title: 'Acknowledge', procedure: 'Write a short acknowledgement.', sent_back_note: 'Warmer, please.' },
        context: { today: '2026-10-21', system_name: 'Referrals', done_by: 'Test Person' },
        fields: [{ name: 'name', label: 'Name', type: 'text', required: true }],
        fill: [{ name: 'reply', label: 'Reply', type: 'text', required: false }],
      })
    )
    expect(res.status).toBe(202)
    expect(start.mock.calls[0][1][0]).toMatchObject({
      step: { sentBackNote: 'Warmer, please.' },
      context: { today: '2026-10-21', system_name: 'Referrals', done_by: 'Test Person' },
      fields: [{ name: 'name', label: 'Name', type: 'text', choices: [], required: true }],
      fill: [{ name: 'reply', label: 'Reply', type: 'text', choices: [], required: false }],
      more: {},
    })
  })

  it('never refuses a job for malformed descriptive parts (they read as empty)', async () => {
    const res = await send(job({ context: 'today', fields: { a: 1 }, fill: 'x', step: { title: 'A', procedure: null, sent_back_note: 3 } }))
    expect(res.status).toBe(202)
    expect(start.mock.calls[0][1][0]).toMatchObject({ context: {}, fields: [], fill: [], step: { sentBackNote: null } })
  })

  it('accepts a `to` whose host differs only in case, or whose scheme differs', async () => {
    expect((await send(job({ to: `https://${HOST.toUpperCase()}/api/scallle` }))).status).toBe(202)
    expect((await send(job({ to: `http://${HOST}/api/scallle` }))).status).toBe(202)
  })

  it('passes run.test through to the workflow: true for a test run', async () => {
    const res = await send(job({ run: { id: 'run_1', automation_id: AUTOMATION, workspace_id: WORKSPACE, test: true } }))
    expect(res.status).toBe(202)
    expect(start.mock.calls[0][1]).toMatchObject([{ runId: 'run_1', test: true }])
  })

  it('does not start the same run twice when its claim already exists', async () => {
    getHookByToken.mockResolvedValue({ runId: 'wrun_earlier' })
    const res = await send(job())
    expect(res).toEqual({ status: 202, body: { accepted: true } })
    expect(getHookByToken).toHaveBeenCalledWith('scallle-run:run_1')
    expect(start).not.toHaveBeenCalled()
  })

  it('answers 503 (Scallle sends again) when the workflow could not be started', async () => {
    start.mockRejectedValue(new Error('queue unavailable'))
    const res = await send(job())
    expect(res.status).toBe(503)
    expect(res.body.accepted).toBe(false)
  })

  it('on Vercel, starts the job when Vercel passed the project’s OIDC token', async () => {
    vi.stubEnv('VERCEL', '1')
    const res = await send(job(), { headers: { 'x-vercel-oidc-token': 'header.payload.signature' } })
    expect(res.status).toBe(202)
  })
})

describe('POST /api/scallle — the one automation it runs (SCALLLE_AUTOMATION_ID)', () => {
  /** A job for `automationId`, its callback naming that same automation. */
  const jobFor = (automationId: string, overrides: Record<string, unknown> = {}) =>
    job({
      run: { id: 'run_1', automation_id: automationId, workspace_id: WORKSPACE, test: false },
      callback: { url: `${APP}/api/automations/${automationId}/runs/run_1?token=tok` },
      ...overrides,
    })

  it('refuses a job for another automation (400), starting nothing and looking up no claim', async () => {
    const res = await send(jobFor(OTHER_AUTOMATION))
    expect(res).toEqual({ status: 400, body: { accepted: false, error: S2 } })
    expect(getHookByToken).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
  })

  it('while it isn’t set, refuses every job (500), naming the job’s own automation id as the value to set', async () => {
    vi.stubEnv('SCALLLE_AUTOMATION_ID', '')
    const res = await send(job())
    expect(res).toEqual({ status: 500, body: { accepted: false, error: S1A } })
    expect(getHookByToken).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
  })

  it('…names the id lower-cased, however the job wrote it', async () => {
    vi.stubEnv('SCALLLE_AUTOMATION_ID', '')
    const res = await send(jobFor('AAAAAAAA-3333-4333-8333-333333333333'))
    expect(res.status).toBe(500)
    expect(res.body.error).toBe(
      'This project isn’t set up for its automation yet: set SCALLLE_AUTOMATION_ID to aaaaaaaa-3333-4333-8333-333333333333 in its environment variables, then redeploy.'
    )
  })

  it('…and never names an id that isn’t a UUID: it points at the step in Scallle instead', async () => {
    vi.stubEnv('SCALLLE_AUTOMATION_ID', '')
    const res = await send(jobFor('auto_legacy'))
    expect(res).toEqual({ status: 500, body: { accepted: false, error: S1B } })
    expect(res.body.error).not.toContain('auto_legacy')
    expect(start).not.toHaveBeenCalled()
  })

  it('matches a SCALLLE_AUTOMATION_ID pasted in capitals or with spaces against the lower-case job id', async () => {
    vi.stubEnv('SCALLLE_AUTOMATION_ID', `  ${AUTOMATION} `)
    expect((await send(job())).status).toBe(202)
    vi.stubEnv('SCALLLE_AUTOMATION_ID', 'AAAAAAAA-3333-4333-8333-333333333333')
    expect((await send(jobFor('aaaaaaaa-3333-4333-8333-333333333333'))).status).toBe(202)
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('🔴 checks it last: a job for another business while it isn’t set gets 403, never the job’s automation id', async () => {
    vi.stubEnv('SCALLLE_AUTOMATION_ID', '')
    const res = await send(jobFor(AUTOMATION, { run: { id: 'run_1', automation_id: AUTOMATION, workspace_id: OTHER_WORKSPACE, test: false } }))
    expect(res).toEqual({ status: 403, body: { accepted: false, error: 'This job belongs to another business, so it was refused.' } })
    expect(JSON.stringify(res.body)).not.toContain(AUTOMATION)
    expect(start).not.toHaveBeenCalled()
  })

  it('…a job addressed to another project while it isn’t set gets 400 for the address, never the id to set', async () => {
    vi.stubEnv('SCALLLE_AUTOMATION_ID', '')
    const res = await send(job({ to: 'https://another-project.example/api/scallle' }))
    expect(res).toEqual({ status: 400, body: { accepted: false, error: 'This job is addressed to another project, so it was refused.' } })
    expect(JSON.stringify(res.body)).not.toContain('SCALLLE_AUTOMATION_ID')
  })

  it('…an unsigned job, or one whose callback names another automation, is refused for that — never the id to set', async () => {
    vi.stubEnv('SCALLLE_AUTOMATION_ID', '')
    expect(await send(job(), { signed: null })).toEqual({
      status: 401,
      body: { accepted: false, error: 'This job isn’t signed by Scallle.' },
    })
    const res = await send(job({ callback: { url: `${APP}/api/automations/${OTHER_AUTOMATION}/runs/run_1?token=tok` } }))
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('The callback address names a different automation or run, so the job was refused.')
  })

  it('set but not a UUID: every job is refused (500), saying what it must be', async () => {
    vi.stubEnv('SCALLLE_AUTOMATION_ID', 'auto_1')
    for (const j of [job(), jobFor('auto_1'), jobFor(OTHER_AUTOMATION)]) {
      expect(await send(j)).toEqual({ status: 500, body: { accepted: false, error: S3 } })
    }
    expect(start).not.toHaveBeenCalled()
  })
})

describe('POST /api/scallle — the signature', () => {
  const NOT_SIGNED = 'This job isn’t signed by Scallle.'

  it.each<[string, Sent]>([
    ['no signature headers', { signed: null }],
    ['no key id', { signed: { 'X-Scallle-Signature': `ed25519=${'A'.repeat(86)}` } }],
    ['no signature', { signed: { 'X-Scallle-Key-Id': TEST_KEY.kid } }],
    ['an HMAC signature of the old kind', { signed: { 'X-Scallle-Key-Id': TEST_KEY.kid, 'X-Scallle-Signature': `sha256=${'a'.repeat(64)}` } }],
    ['a signature of the wrong length', { signed: { 'X-Scallle-Key-Id': TEST_KEY.kid, 'X-Scallle-Signature': `ed25519=${'A'.repeat(85)}` } }],
  ])('refuses %s with 401, without fetching any key', async (_name, opts) => {
    const res = await send(job(), opts)
    expect(res).toEqual({ status: 401, body: { accepted: false, error: NOT_SIGNED } })
    expect(keyFetches).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
  })

  it('refuses a signature over different bytes, or by another key under Scallle’s key id (401)', async () => {
    const otherBytes = signatureHeaders('{}', TEST_KEY)
    expect(await send(job(), { signed: otherBytes })).toEqual({ status: 401, body: { accepted: false, error: NOT_SIGNED } })
    const otherKey = signatureHeaders(JSON.stringify(job()), TEST_STRAY_KEY, TEST_KEY.kid)
    expect((await send(job(), { signed: otherKey })).status).toBe(401)
    expect(start).not.toHaveBeenCalled()
  })

  it('refuses a key Scallle doesn’t publish (401), naming where it looked', async () => {
    const res = await send(job(), { key: TEST_STRAY_KEY })
    expect(res.status).toBe(401)
    expect(res.body.error).toBe(
      `This job is signed with a key Scallle doesn’t publish at ${APP} — it may have come from a test copy of Scallle.`
    )
    expect(start).not.toHaveBeenCalled()
  })

  it.each([
    ['is down', () => Response.json({ error: 'down' }, { status: 503 })],
    ['answers an HTML page', () => new Response('<!doctype html><title>Checking…</title>', { headers: { 'content-type': 'text/html' } })],
    ['can’t be reached', () => {
      throw new TypeError('fetch failed')
    }],
  ])('answers 503 (Scallle sends again) when Scallle’s key document %s', async (_name, answer) => {
    keyDocument = answer
    const res = await send(job())
    expect(res).toEqual({
      status: 503,
      body: { accepted: false, error: 'Couldn’t fetch Scallle’s public key just now. Try again in a minute.' },
    })
    expect(start).not.toHaveBeenCalled()
  })

  it('a burst of made-up key ids costs Scallle at most one fetch', async () => {
    for (let i = 0; i < 10; i++) {
      const kid = `made-up-${i}`
      await send(job(), { signed: signatureHeaders(JSON.stringify(job()), TEST_STRAY_KEY, kid) })
    }
    expect(keyFetches).toHaveBeenCalledTimes(1)
  })
})

describe('POST /api/scallle — refusals start nothing', () => {
  const cases: Array<[string, () => Promise<{ status: number; body: Record<string, unknown> }>, number]> = [
    ['issued_at more than 5 minutes ago', () => send(job({ issued_at: new Date(Date.now() - 6 * 60_000).toISOString() })), 401],
    ['issued_at more than 5 minutes ahead', () => send(job({ issued_at: new Date(Date.now() + 6 * 60_000).toISOString() })), 401],
    ['no issued_at', () => send(job({ issued_at: undefined })), 400],
    ['another workspace', () => send(job({ run: { id: 'run_1', automation_id: AUTOMATION, workspace_id: OTHER_WORKSPACE, test: false } })), 403],
    ['a `to` naming another project', () => send(job({ to: 'https://another-project.example/api/scallle' })), 400],
    ['a `to` with another path', () => send(job({ to: `https://${HOST}/api/other` })), 400],
    ['a `to` on another port', () => send(job({ to: `https://${HOST}:8443/api/scallle` })), 400],
    ['no `to`', () => send(job({ to: undefined })), 400],
    ['a `to` that is not an address', () => send(job({ to: 'not an address' })), 400],
    ['a callback on another origin', () => send(job({ callback: { url: `https://evil.test/api/automations/${AUTOMATION}/runs/run_1` } })), 400],
    ['a callback over http on Scallle’s host', () => send(job({ callback: { url: `http://app.scallle.test/api/automations/${AUTOMATION}/runs/run_1` } })), 400],
    ['a callback naming another run', () => send(job({ callback: { url: `${APP}/api/automations/${AUTOMATION}/runs/run_2` } })), 400],
    ['a callback naming another automation', () => send(job({ callback: { url: `${APP}/api/automations/${OTHER_AUTOMATION}/runs/run_1` } })), 400],
    ['a callback with another path', () => send(job({ callback: { url: `${APP}/api/other/${AUTOMATION}/runs/run_1` } })), 400],
    ['a callback carrying credentials', () => send(job({ callback: { url: `https://user:pw@app.scallle.test/api/automations/${AUTOMATION}/runs/run_1` } })), 400],
    ['no callback', () => send(job({ callback: undefined })), 400],
    ['contract version 2', () => send(job({ version: 2 })), 400],
    ['no run id', () => send(job({ run: { automation_id: AUTOMATION, workspace_id: WORKSPACE, test: false } })), 400],
    ['no run.test', () => send(job({ run: { id: 'run_1', automation_id: AUTOMATION, workspace_id: WORKSPACE } })), 400],
    ['a run.test that is not true or false', () => send(job({ run: { id: 'run_1', automation_id: AUTOMATION, workspace_id: WORKSPACE, test: 'false' } })), 400],
    ['a body that is not JSON', () => send(null, { raw: 'not json' }), 400],
    ['a JSON array', () => send([job()]), 400],
  ]

  it.each(cases)('refuses %s', async (_name, run, status) => {
    const res = await run()
    expect(res.status).toBe(status)
    expect(res.body.accepted).toBe(false)
    expect(typeof res.body.error).toBe('string')
    expect(start).not.toHaveBeenCalled()
  })

  it('refuses a job that doesn’t say whether its run is a test, rather than taking it as a real run', async () => {
    const res = await send(job({ run: { id: 'run_1', automation_id: AUTOMATION, workspace_id: WORKSPACE } }))
    expect(res).toEqual({ status: 400, body: { accepted: false, error: 'The job doesn’t say whether the run is a test.' } })
  })

  it('checks `to` against the Host header, never X-Forwarded-Host', async () => {
    const res = await send(job({ to: 'https://sibling-project.example/api/scallle' }), {
      headers: { 'x-forwarded-host': 'sibling-project.example' },
    })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('This job is addressed to another project, so it was refused.')
  })

  it('checks the business before the address: another business is a 403 whatever its `to`', async () => {
    const res = await send(job({ to: 'https://elsewhere.example/api/scallle', run: { id: 'run_1', automation_id: AUTOMATION, workspace_id: OTHER_WORKSPACE, test: false } }))
    expect(res.status).toBe(403)
  })

  it('refuses a job that is too large, unread', async () => {
    const res = await send(job({ item: { blob: 'x'.repeat(1_100_000) } }))
    expect(res.status).toBe(413)
    expect(keyFetches).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
  })

  it('refuses everything until the project is set up, naming what is missing', async () => {
    vi.stubEnv('SCALLLE_WORKSPACE_ID', '')
    vi.stubEnv('SCALLLE_APP_URL', '')
    const res = await send(job())
    expect(res.status).toBe(500)
    expect(res.body.error).toContain('SCALLLE_WORKSPACE_ID')
    expect(res.body.error).toContain('SCALLLE_APP_URL')
    expect(res.body.error).not.toContain('ANTHROPIC_API_KEY')
    expect(res.body.error).not.toMatch(/SECRET/)
    expect(start).not.toHaveBeenCalled()
  })

  it('refuses everything while SCALLLE_WORKSPACE_ID is not a UUID', async () => {
    vi.stubEnv('SCALLLE_WORKSPACE_ID', 'ws_test')
    const res = await send(job({ run: { id: 'run_1', automation_id: AUTOMATION, workspace_id: 'ws_test', test: false } }))
    expect(res.status).toBe(500)
    expect(res.body.error).toContain('SCALLLE_WORKSPACE_ID')
    expect(start).not.toHaveBeenCalled()
  })

  it('refuses an http SCALLLE_APP_URL outside this machine', async () => {
    vi.stubEnv('SCALLLE_APP_URL', 'http://app.scallle.test')
    const res = await send(job({ callback: { url: `http://app.scallle.test/api/automations/${AUTOMATION}/runs/run_1` } }))
    expect(res.status).toBe(500)
    expect(keyFetches).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
  })

  it('refuses everything while ANTHROPIC_BASE_URL would send items somewhere other than Anthropic', async () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'http://127.0.0.1:4020') // left over from .env.local
    const res = await send(job())
    expect(res.status).toBe(500)
    expect(res.body.error).toContain('ANTHROPIC_BASE_URL')
    expect(start).not.toHaveBeenCalled()
  })

  it('on Vercel without the project’s OIDC token, answers 500 (not resent) saying what to switch on — and starts nothing', async () => {
    vi.stubEnv('VERCEL', '1')
    const res = await send(job())
    expect(res.status).toBe(500)
    expect(res.body.error).toBe(
      'This project can’t run Vercel Workflows: in Vercel open the project → Settings → Security and turn on Secure backend access with OIDC federation, and under Environment Variables tick Automatically expose System Environment Variables. Then redeploy.'
    )
    expect(getHookByToken).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
  })

  it('…but only once the job is proven Scallle’s: an unsigned request still gets 401', async () => {
    vi.stubEnv('VERCEL', '1')
    expect((await send(job(), { signed: null })).status).toBe(401)
  })

  it('never puts the item or the callback token in a refusal', async () => {
    const res = await send(job({ run: { id: 'run_1', automation_id: AUTOMATION, workspace_id: OTHER_WORKSPACE, test: false } }))
    expect(JSON.stringify(res.body)).not.toMatch(/Test Person|tok/)
  })
})
