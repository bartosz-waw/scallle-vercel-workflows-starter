import { FatalError, RetryableError } from 'workflow'

import { appOrigin } from './config'
import { CALLBACK_PATH, type CallbackReport } from './contract'
import { retryDelayMs } from './retry'

/**
 * Posting the run's one result back to Scallle (contract §3).
 *
 *   - Any 2xx is delivered — including 200 { ok: false, reason: "run closed" },
 *     Scallle's answer to a repeat or a result for a run it already closed.
 *   - A network error, a timeout, 429 or any 5xx is retried: the result is
 *     still worth delivering, and Scallle may just be busy for a moment.
 *   - Any other answer (a 4xx, or a redirect) is final: the token was refused
 *     or the address is wrong, and sending again won't change that.
 *
 * Redirects are never followed: the body carries the business's data and
 * must only ever reach Scallle's own address.
 */

/** Scallle answers within ~2 s; this leaves plenty of room. */
export const CALLBACK_TIMEOUT_MS = 30_000

export type Delivery = {
  /** Scallle's HTTP status. */
  status: number
  /** True when Scallle said the run was already closed (a repeat). */
  runClosed: boolean
}

/** The result may only go to a run callback on SCALLLE_APP_URL's origin. The
 *  receiver checked this when the job arrived; checked again here so this
 *  step can never be pointed anywhere else. */
function assertScallleCallback(callbackUrl: string): void {
  let ok = false
  try {
    const url = new URL(callbackUrl)
    ok = url.origin === appOrigin() && CALLBACK_PATH.test(url.pathname)
  } catch {
    ok = false
  }
  if (!ok) throw new FatalError("The result wasn't sent: the callback address isn't on Scallle.")
}

/**
 * Send one result to Scallle. A step: when delivery fails it is retried on
 * its own, without re-running the work that produced the result.
 */
export async function sendToScallle(callbackUrl: string, report: CallbackReport): Promise<Delivery> {
  'use step'
  assertScallleCallback(callbackUrl)

  let res: Response
  try {
    res = await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report),
      redirect: 'manual',
      signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
    })
  } catch {
    throw new RetryableError("Couldn't reach Scallle to deliver the result.", {
      retryAfter: retryDelayMs(),
    })
  }

  // Read the answer either way, so the connection is released.
  const answer = await res.text().catch(() => '')

  if (res.status >= 200 && res.status < 300) {
    let runClosed = false
    try {
      runClosed = (JSON.parse(answer) as { ok?: unknown })?.ok === false
    } catch {
      // Not JSON — still delivered.
    }
    return { status: res.status, runClosed }
  }
  if (res.status === 429 || res.status >= 500) {
    throw new RetryableError(`Scallle couldn't take the result just then (HTTP ${res.status}).`, {
      retryAfter: retryDelayMs(res.headers.get('retry-after')),
    })
  }
  throw new FatalError(`Scallle refused the result (HTTP ${res.status}).`)
}

// Up to 9 tries over roughly a quarter of an hour (5 s, 10 s … 5 min apart):
// Scallle waits 20 minutes for a result before handing the step to a person.
sendToScallle.maxRetries = 8
