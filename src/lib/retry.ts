import { getStepMetadata } from 'workflow'

/**
 * Retry timing for steps that call other services (Claude, Scallle).
 *
 * A step that throws RetryableError is run again after `retryAfter`; a step
 * that throws FatalError is not run again. Waiting longer each time — 5 s,
 * 10 s, 20 s … up to 5 minutes — gives a busy service room to recover, and a
 * Retry-After header from the service always wins.
 */

const BASE_DELAY_MS = 5_000
const MAX_DELAY_MS = 5 * 60_000

/** Which attempt of the current step this is (1 = first). Outside a workflow
 *  — in a unit test, say — there is no step, so it is always 1. */
export function stepAttempt(): number {
  try {
    return getStepMetadata().attempt
  } catch {
    return 1
  }
}

/** How long to wait before the next attempt, doubling each time. */
export function backoffMs(attempt: number = stepAttempt()): number {
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1))
}

/** A Retry-After header (seconds, or an HTTP date) in milliseconds, capped;
 *  null when there isn't a usable one. */
export function retryAfterHeaderMs(value: string | null | undefined): number | null {
  if (!value) return null
  const seconds = Number(value)
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now()
  if (!Number.isFinite(ms) || ms < 0) return null
  return Math.min(MAX_DELAY_MS, ms)
}

/** The wait before retrying: the service's Retry-After if it sent one,
 *  otherwise the doubling backoff. */
export function retryDelayMs(retryAfterHeader?: string | null): number {
  return retryAfterHeaderMs(retryAfterHeader) ?? backoffMs()
}
