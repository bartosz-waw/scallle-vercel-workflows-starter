#!/usr/bin/env node
/**
 * A stand-in for Scallle, for local testing: its public job keys and its
 * callback endpoint.
 *
 * Keys. GET /.well-known/scallle-job-keys publishes the TEST key from
 * test-signing-key.mjs (TEST ONLY — never trusted by a deployed project), and
 * sign(raw) gives the headers Scallle would send with a job. To try what a
 * project does when the key document misbehaves, or across a rotation:
 *
 *   mock.setKeyDocument('down')    // 503, as when Scallle can't be reached ('html': a 200 HTML page)
 *   mock.publish(TEST_ROTATED_KEY) // publish a second key (sign with it later: signWith)
 *   POST /__keys { "document": "down" | "html" | "up", "rotate": true }   // over HTTP
 *
 * Callbacks. Records every POST to /api/automations/<automation_id>/runs/<run id> and
 * answers 200 { ok: true } — or, per run, whatever statuses you plan:
 *
 *   mock.planFor(runId, [503, 503, 200])        // in code
 *   POST /__plan { "runId": "…", "statuses": [503, 503, 200] }   // over HTTP
 *
 * A planned 200 with `closed: true` answers like Scallle does for a repeat:
 * 200 { ok: false, reason: "run closed" }.
 *
 * Run it on its own:  node scripts/mock-scallle.mjs   (PORT, default 4010)
 * then point SCALLLE_APP_URL at http://127.0.0.1:4010 and watch the results
 * arrive here. GET /__received lists them. A /__reset puts the keys back too.
 */
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

import { signatureHeaders, TEST_KEY, TEST_ROTATED_KEY } from './test-signing-key.mjs'

const KEYS_PATH = '/.well-known/scallle-job-keys'
const CALLBACK_PATH = /^\/api\/automations\/([^/]+)\/runs\/([^/]+)$/

export async function startMockScallle({ port = 0, quiet = true } = {}) {
  /** @type {{ automationId: string, runId: string, token: string | null, body: any, status: number, at: number }[]} */
  const received = []
  /** @type {Map<string, (number | { status: number, closed?: boolean })[]>} */
  const plans = new Map()
  /** The keys the document lists, the one jobs are signed with, and how the document answers. */
  let published = [TEST_KEY]
  let signingKey = TEST_KEY
  /** @type {'up' | 'down' | 'html'} */
  let keyDocument = 'up'
  /** When each key fetch arrived (ms). */
  const keyFetches = []
  const publish = (key) => {
    if (!published.includes(key)) published = [...published, key]
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    if (req.method === 'GET' && url.pathname === KEYS_PATH) {
      keyFetches.push(Date.now())
      if (!quiet) console.log(`[mock scallle] key document fetched (${keyDocument})`)
      if (keyDocument === 'down') return send(503, { error: 'Scallle can’t publish its job key just now.' })
      if (keyDocument === 'html') {
        res.writeHead(200, { 'content-type': 'text/html' })
        return res.end('<!doctype html><title>Checking your browser…</title>')
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' })
      return res.end(JSON.stringify({ keys: published.map((k) => k.jwk) }))
    }
    if (req.method === 'POST' && url.pathname === '/__keys') {
      const { document, rotate } = JSON.parse(raw || '{}')
      if (document) keyDocument = document
      if (rotate) {
        publish(TEST_ROTATED_KEY)
        signingKey = TEST_ROTATED_KEY
      }
      return send(200, { ok: true, document: keyDocument, kid: signingKey.kid })
    }
    if (req.method === 'GET' && url.pathname === '/__received') return send(200, received)
    if (req.method === 'POST' && url.pathname === '/__plan') {
      const { runId, statuses } = JSON.parse(raw)
      plans.set(runId, statuses)
      return send(200, { ok: true })
    }
    if (req.method === 'POST' && url.pathname === '/__reset') {
      received.length = 0
      plans.clear()
      published = [TEST_KEY]
      signingKey = TEST_KEY
      keyDocument = 'up'
      return send(200, { ok: true })
    }

    const match = CALLBACK_PATH.exec(url.pathname)
    if (req.method !== 'POST' || !match) return send(404, { error: 'not found' })

    const runId = decodeURIComponent(match[2])
    const next = plans.get(runId)?.shift() ?? 200
    const plan = typeof next === 'number' ? { status: next } : next
    let body = null
    try {
      body = JSON.parse(raw)
    } catch {
      body = raw
    }
    received.push({
      automationId: decodeURIComponent(match[1]),
      runId,
      token: url.searchParams.get('token'),
      body,
      status: plan.status,
      at: Date.now(),
    })
    if (!quiet) console.log(`[mock scallle] run ${runId} → answered ${plan.status}`, JSON.stringify(body))
    if (plan.status === 200 && plan.closed) return send(200, { ok: false, reason: 'run closed' })
    if (plan.status >= 200 && plan.status < 300) return send(plan.status, { ok: true })
    if (plan.status >= 300 && plan.status < 400) {
      res.writeHead(plan.status, { location: 'http://example.invalid/elsewhere' })
      return res.end()
    }
    return send(plan.status, { error: `planned ${plan.status}` })
  })

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  const address = server.address()
  const origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : port}`

  return {
    origin,
    received,
    keyFetches,
    /** The headers Scallle sends with this raw body: key id and signature. */
    sign: (raw) => signatureHeaders(raw, signingKey),
    publish,
    /** Sign from now on with this key (publishing it too). */
    signWith: (key) => {
      publish(key)
      signingKey = key
    },
    /** Stop publishing a key. */
    retire: (key) => {
      published = published.filter((k) => k !== key)
    },
    /** @param {'up' | 'down' | 'html'} mode */
    setKeyDocument: (mode) => {
      keyDocument = mode
    },
    /** Callback POSTs for one run, oldest first. */
    forRun: (runId) => received.filter((r) => r.runId === runId),
    planFor: (runId, statuses) => plans.set(runId, [...statuses]),
    reset: () => {
      received.length = 0
      plans.clear()
      keyFetches.length = 0
      published = [TEST_KEY]
      signingKey = TEST_KEY
      keyDocument = 'up'
    },
    close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const mock = await startMockScallle({ port: Number(process.env.PORT ?? 4010), quiet: false })
  console.log(`Mock Scallle listening on ${mock.origin} — set SCALLLE_APP_URL=${mock.origin}`)
  console.log(`It publishes the TEST signing key (kid ${TEST_KEY.kid}); send-test-job.mjs signs with it.`)
}
