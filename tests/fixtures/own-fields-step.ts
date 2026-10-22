import type { ScallleJob } from '../../src/lib/contract'
import { runForScallle } from '../../src/workflows/run-for-scallle'

/**
 * Test fixture only. A workflow whose own work returns fields — one the job
 * asked it to fill, and others it didn't ask for or that Scallle can't take —
 * to show runForScallle sends back only what the job's `fill` lists.
 */
export async function ownFieldsStep(job: ScallleJob) {
  'use workflow'
  return runForScallle(job, async () => ({
    result: 'Done by the fixture.',
    fields: { follow_up: 'Call back on Monday.', not_asked_for: 'dropped', days: Number.POSITIVE_INFINITY, nested: { a: 1 } },
  }))
}
