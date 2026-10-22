import { createHook, sleep } from 'workflow'

import { askClaude } from '../../lib/claude'
import type { ScallleJob } from '../../lib/contract'
import { extrasOf, promptFor, readReply } from '../../lib/reply'
import { runForScallle } from '../run-for-scallle'
import { systemPromptFor } from '../draft-with-claude'

/**
 * EXAMPLE ONLY — NOT WIRED UP. The pattern for an automation that must
 * eventually ACT outside (send an email, update a case record): draft first,
 * act only after a person approves the draft in Scallle.
 *
 *   1. Draft, and send the draft to Scallle as this run's result — exactly
 *      like draft-with-claude. A person reviews it there.
 *   2. Wait, without using any compute, for that person's decision (up to 7 days).
 *   3. Only if approved, act — in a step of its own, with an idempotency key,
 *      so a retry can never send twice.
 *
 * On a test run (job.test — Send a test, Execute, the first test after
 * one-press setup) it stops after step 1: the draft goes to Scallle as
 * what it would have done, and nothing waits or acts outside.
 *
 * Before it acts, a workflow that acts outside must also confirm with
 * Scallle through this run's own callback link (its per-run token, on
 * SCALLLE_APP_URL — never an address from the job), and act only on
 * Scallle's yes: Scallle's one signing key serves every business, so a
 * job's signature alone is enough for drafting only (contract §2).
 *
 * Why it isn't wired: contract v1 has no message from Scallle telling this
 * project a draft was approved. To use this pattern, first:
 *
 *   - agree that message, and the confirmation through the run's callback,
 *     in Scallle's automation connector contract;
 *   - add a route (e.g. /api/scallle/approvals) that verifies it exactly as
 *     /api/scallle verifies a job — signature, issued_at, workspace — and
 *     then calls resumeHook(approvalToken(runId), { approved }) from
 *     'workflow/api'. The token alone proves nothing: anyone who can guess a
 *     run id can rebuild it, so the route's own checks are what make an
 *     approval genuine;
 *   - write the real `actOnApprovedDraft` step;
 *   - point WORKFLOW at it (../index.ts).
 *
 * Until then nothing starts it, and nothing outside can reach its hook:
 * hooks made with createHook are only resumed from this project's own code.
 */

export type ApprovalDecision = { approved: boolean }

export function approvalToken(runId: string): string {
  return `scallle-approval:${runId}`
}

export async function draftThenApprove(job: ScallleJob) {
  'use workflow'

  // 1. Draft, and report the draft to Scallle.
  let draft = ''
  const drafted = await runForScallle(job, async () => {
    const answer = await askClaude({
      system: systemPromptFor(job.step, extrasOf(job)),
      prompt: promptFor(job),
    })
    // Only the draft — never the field tags of a job with rows to fill.
    const reply = readReply(answer.text, job.fill)
    draft = reply.result
    return { result: reply.result, fields: reply.fields, usage: answer.usage }
  })
  if (drafted.outcome === 'duplicate') return { acted: false, reason: 'duplicate' as const }

  // A test: the draft is what it would have done. Nothing waits, nothing acts.
  if (job.test) return { acted: false, reason: 'test' as const }

  // 2. Wait for the person's decision. Registered before anything could
  //    resume it; given up on after 7 days.
  const decision = createHook<ApprovalDecision>({ token: approvalToken(job.runId) })
  await decision.getConflict()
  const answer = await Promise.race([decision, sleep('7d').then(() => null)])
  if (!answer) return { acted: false, reason: 'no decision' as const }
  if (!answer.approved) return { acted: false, reason: 'rejected' as const }

  // 3. Act, once.
  await actOnApprovedDraft(job.runId, draft)
  return { acted: true }
}

/**
 * Replace this body with the real action. Use getStepMetadata().stepId (from
 * 'workflow') as the idempotency key the outside system supports, so a retry
 * of this step never acts twice.
 */
async function actOnApprovedDraft(scallleRunId: string, draft: string): Promise<void> {
  'use step'
  console.info(`Example only: the approved draft for Scallle run ${scallleRunId} (${draft.length} characters) would be sent here.`)
}
