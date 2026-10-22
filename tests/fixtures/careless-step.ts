import type { ScallleJob } from '../../src/lib/contract'
import { runForScallle } from '../../src/workflows/run-for-scallle'

/**
 * Test fixture only — never copy this. A custom step written carelessly: it
 * fails with a plain Error whose message quotes the item, and is retried
 * once. When it runs out of retries the Workflow runtime wraps that message
 * in a FatalError of its own, which must still never reach Scallle.
 *
 * Lives under tests/, so `next build` never compiles it into the app (only
 * files the app's routes import are); the workflow tests' build scans the
 * whole project and picks it up.
 */
async function readNotes(notes: string): Promise<string> {
  'use step'
  throw new Error(`Couldn't read the notes: ${notes}`)
}
readNotes.maxRetries = 1

export async function carelessStep(job: ScallleJob) {
  'use workflow'
  return runForScallle(job, async () => {
    const result = await readNotes(String(job.item.notes ?? ''))
    return { result }
  })
}
