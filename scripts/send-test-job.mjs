#!/usr/bin/env node
/**
 * Send this project a signed test job, exactly as Scallle would — signed with
 * the TEST key that the mock Scallle publishes (test-signing-key.mjs), so it
 * is only accepted while SCALLLE_APP_URL points at the mock.
 *
 *   node scripts/send-test-job.mjs                        # a valid job (202)
 *   node scripts/send-test-job.mjs --test                 # a valid job for a test run (run.test: true)
 *   node scripts/send-test-job.mjs --bad-signature        # signed by another key under the same key id (401)
 *   node scripts/send-test-job.mjs --unknown-kid          # signed with a key Scallle doesn't publish (401)
 *   node scripts/send-test-job.mjs --old                  # issued 10 minutes ago (401)
 *   node scripts/send-test-job.mjs --other-workspace      # another business (403)
 *   node scripts/send-test-job.mjs --other-automation     # an automation this project doesn't run (400)
 *   node scripts/send-test-job.mjs --wrong-to             # addressed to another project (400)
 *   node scripts/send-test-job.mjs --foreign-callback     # callback not on Scallle (400)
 *   node scripts/send-test-job.mjs --mismatched-callback  # callback for another run (400)
 *   node scripts/send-test-job.mjs --fill                 # a valid job with everything a job can describe:
 *                                                         #   about this run, each field, a send-back note and
 *                                                         #   rows to fill (the result then fills them)
 *
 * Reads SCALLLE_WORKSPACE_ID, SCALLLE_AUTOMATION_ID and SCALLLE_APP_URL from
 * the environment (e.g. `node --env-file=.env.local scripts/send-test-job.mjs`)
 * and posts to TARGET_URL (default http://localhost:3010/api/scallle).
 *
 * Use made-up item data only — never a real person's details.
 */
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

import { signatureHeaders, TEST_KEY, TEST_STRAY_KEY } from './test-signing-key.mjs'

/** Test workspace ids (TEST ONLY): this business, and another one. */
export const TEST_WORKSPACE_ID = '11111111-1111-4111-8111-111111111111'
export const OTHER_WORKSPACE_ID = '22222222-2222-4222-8222-222222222222'

/** Test automation ids (TEST ONLY): the one this project runs (as in the
 *  signed-job fixture), and another one. */
export const TEST_AUTOMATION_ID = '33333333-3333-4333-8333-333333333333'
export const OTHER_AUTOMATION_ID = '55555555-5555-4555-8555-555555555555'

/** Made-up parts for a job that describes everything (--fill): about this
 *  run, what each item field is, a send-back note and rows to fill. */
export const SAMPLE_EXTRAS = {
  sentBackNote: 'Too formal — make it warmer, and say when we will call.',
  context: { today: '2026-10-21', system_name: 'Referrals', done_by: 'Test Person' },
  fields: [
    { name: 'referrer_name', label: 'Referrer’s name', type: 'text', required: true },
    { name: 'referral_reason', label: 'Why they were referred', type: 'text', required: false },
  ],
  fill: [
    { name: 'follow_up', label: 'Follow-up email', type: 'text', required: true },
    { name: 'call_back_in_days', label: 'Call back in (days)', type: 'number', required: false },
  ],
}

/**
 * A contract-v1 job, its keys in the order Scallle sends them. Pass overrides
 * to change any part of it. `context`, `fields`, `fill` and `sentBackNote`
 * (step.sent_back_note) are only in the job when given, so by default it is
 * the shape a Scallle from before 21 Oct 2026 sends.
 */
export function buildJob({
  appUrl,
  to,
  workspaceId = TEST_WORKSPACE_ID,
  runId = `run_${randomUUID()}`,
  automationId = TEST_AUTOMATION_ID,
  test = false,
  issuedAt = new Date(),
  title = 'Acknowledge the referral',
  procedure = 'Write a short, warm acknowledgement to the referrer. Say we will be in touch within two working days.',
  item = { scenario: 'manual', referrer_name: 'Sam Example', referral_reason: 'Needs supported housing' },
  callbackUrl,
  version = 1,
  context,
  fields,
  fill,
  sentBackNote,
} = {}) {
  return {
    version,
    connection_id: 'conn_test',
    to,
    issued_at: issuedAt.toISOString(),
    run: { id: runId, automation_id: automationId, workspace_id: workspaceId, test },
    step: { title, procedure, ...(sentBackNote === undefined ? {} : { sent_back_note: sentBackNote }) },
    ...(context === undefined ? {} : { context }),
    item,
    ...(fields === undefined ? {} : { fields }),
    ...(fill === undefined ? {} : { fill }),
    callback: {
      url:
        callbackUrl ??
        `${appUrl}/api/automations/${encodeURIComponent(automationId)}/runs/${encodeURIComponent(runId)}?token=test-token-${runId}`,
    },
  }
}

/**
 * POST a job; returns { status, body, ms }. Signed with `key` (the TEST key
 * by default) under `kid` (that key's own by default); `headers: null` sends
 * it unsigned, and `headers` replaces the signature headers outright.
 */
export async function postJob(targetUrl, job, { key = TEST_KEY, kid, headers } = {}) {
  const raw = JSON.stringify(job)
  const signed = headers === undefined ? signatureHeaders(raw, key, kid ?? key.kid) : (headers ?? {})
  const started = Date.now()
  const res = await fetch(targetUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...signed },
    body: raw,
  })
  const text = await res.text()
  let body = text
  try {
    body = JSON.parse(text)
  } catch {
    // leave as text
  }
  return { status: res.status, body, ms: Date.now() - started }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const flags = new Set(process.argv.slice(2))
  const workspaceId = (process.env.SCALLLE_WORKSPACE_ID ?? '').trim()
  const automationId = (process.env.SCALLLE_AUTOMATION_ID ?? '').trim()
  const appUrl = new URL(process.env.SCALLLE_APP_URL ?? 'https://app.scallle.com').origin
  const target = process.env.TARGET_URL ?? 'http://localhost:3010/api/scallle'
  if (!workspaceId || !automationId) {
    console.error('Set SCALLLE_WORKSPACE_ID and SCALLLE_AUTOMATION_ID first (see .env.example).')
    process.exit(1)
  }

  const job = buildJob({
    appUrl,
    to: flags.has('--wrong-to') ? 'https://another-project.example/api/scallle' : target,
    workspaceId: flags.has('--other-workspace') ? OTHER_WORKSPACE_ID : workspaceId,
    automationId: flags.has('--other-automation') ? OTHER_AUTOMATION_ID : automationId,
    issuedAt: flags.has('--old') ? new Date(Date.now() - 10 * 60_000) : new Date(),
    test: flags.has('--test'),
    ...(flags.has('--fill') ? SAMPLE_EXTRAS : {}),
  })
  const auto = encodeURIComponent(job.run.automation_id)
  if (flags.has('--foreign-callback')) job.callback.url = `https://example.com/api/automations/${auto}/runs/${job.run.id}`
  if (flags.has('--mismatched-callback')) job.callback.url = `${appUrl}/api/automations/${auto}/runs/run_other`

  const result = await postJob(target, job, {
    // Another key under the published key's id: the signature can't verify.
    ...(flags.has('--bad-signature') ? { key: TEST_STRAY_KEY, kid: TEST_KEY.kid } : {}),
    // A key the mock doesn't publish, under its own id.
    ...(flags.has('--unknown-kid') ? { key: TEST_STRAY_KEY } : {}),
  })
  console.log(`run ${job.run.id} → HTTP ${result.status} in ${result.ms} ms`, result.body)
}
