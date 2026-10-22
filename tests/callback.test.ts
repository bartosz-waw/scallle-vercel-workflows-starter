import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { FatalError, RetryableError } from 'workflow'

import { sendToScallle } from '../src/lib/callback'
import type { CallbackReport } from '../src/lib/contract'
// @ts-expect-error — a plain .mjs test helper without types
import { startMockScallle } from '../scripts/mock-scallle.mjs'

type MockScallle = {
  origin: string
  forRun: (runId: string) => Array<{ body: unknown; token: string | null; status: number }>
  planFor: (runId: string, statuses: Array<number | { status: number; closed?: boolean }>) => void
  close: () => Promise<void>
}

const report: CallbackReport = {
  status: 'success',
  metadata: { result: 'A draft.' },
  usage: { model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 5 },
}

let scallle: MockScallle
let elsewhere: Server
let elsewhereHits = 0
let run = 0
const url = (runId: string) => `${scallle.origin}/api/automations/auto_1/runs/${runId}?token=tok-${runId}`

beforeAll(async () => {
  scallle = await startMockScallle()
  elsewhere = createServer((_req, res) => {
    elsewhereHits++
    res.end('ok')
  })
  await new Promise<void>((resolve) => elsewhere.listen(0, '127.0.0.1', resolve))
})

afterAll(async () => {
  await scallle.close()
  await new Promise((resolve) => elsewhere.close(resolve))
})

beforeEach(() => {
  vi.stubEnv('SCALLLE_APP_URL', scallle.origin)
  run++
})

describe('sendToScallle', () => {
  it('posts the report as JSON to the callback, token and all, and counts 200 as delivered', async () => {
    const runId = `run_ok_${run}`
    await expect(sendToScallle(url(runId), report)).resolves.toEqual({ status: 200, runClosed: false })
    const [got] = scallle.forRun(runId)
    expect(got.body).toEqual(report)
    expect(got.token).toBe(`tok-${runId}`)
  })

  it('counts 200 { ok: false, reason: "run closed" } as delivered', async () => {
    const runId = `run_closed_${run}`
    scallle.planFor(runId, [{ status: 200, closed: true }])
    await expect(sendToScallle(url(runId), report)).resolves.toEqual({ status: 200, runClosed: true })
  })

  it('counts any 2xx as delivered', async () => {
    const runId = `run_204_${run}`
    scallle.planFor(runId, [204])
    await expect(sendToScallle(url(runId), report)).resolves.toMatchObject({ status: 204 })
  })

  it.each([500, 502, 503, 504, 429])('retries on %i', async (status) => {
    const runId = `run_${status}_${run}`
    scallle.planFor(runId, [status])
    const err = await sendToScallle(url(runId), report).catch((e: unknown) => e)
    expect(RetryableError.is(err)).toBe(true)
    expect((err as RetryableError).retryAfter.getTime()).toBeGreaterThan(Date.now())
  })

  it.each([400, 401, 403, 404, 410, 422])('does not retry on %i', async (status) => {
    const runId = `run_${status}_${run}`
    scallle.planFor(runId, [status])
    const err = await sendToScallle(url(runId), report).catch((e: unknown) => e)
    expect(FatalError.is(err)).toBe(true)
    expect((err as Error).message).toBe(`Scallle refused the result (HTTP ${status}).`)
  })

  it('never follows a redirect', async () => {
    const runId = `run_302_${run}`
    scallle.planFor(runId, [302])
    const err = await sendToScallle(url(runId), report).catch((e: unknown) => e)
    expect(FatalError.is(err)).toBe(true)
    expect(elsewhereHits).toBe(0)
  })

  it('retries when Scallle cannot be reached', async () => {
    vi.stubEnv('SCALLLE_APP_URL', 'http://127.0.0.1:9')
    const err = await sendToScallle('http://127.0.0.1:9/api/automations/a/runs/r', report).catch((e: unknown) => e)
    expect(RetryableError.is(err)).toBe(true)
    expect((err as Error).message).toBe("Couldn't reach Scallle to deliver the result.")
  })

  it('refuses, without sending, a callback that is not on SCALLLE_APP_URL', async () => {
    const { port } = elsewhere.address() as AddressInfo
    const err = await sendToScallle(`http://127.0.0.1:${port}/api/automations/a/runs/r`, report).catch(
      (e: unknown) => e
    )
    expect(FatalError.is(err)).toBe(true)
    expect(elsewhereHits).toBe(0)
  })

  it('refuses a Scallle address that is not a run callback', async () => {
    const err = await sendToScallle(`${scallle.origin}/api/something-else`, report).catch((e: unknown) => e)
    expect(FatalError.is(err)).toBe(true)
  })
})
