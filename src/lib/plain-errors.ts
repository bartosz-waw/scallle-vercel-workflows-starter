import { FatalError, RetryableError } from 'workflow'

/**
 * What a failed run tells Scallle. Contract §5: error messages carry no
 * personal data — they land in Scallle and in run histories.
 *
 * The rule that makes this safe: every FatalError and RetryableError in this
 * project is thrown with a message written in the code (never built from the
 * item, the procedure or a reply from another service), so those messages are
 * passed on. Anything else — a bug, an unexpected library error — could say
 * anything, so Scallle only gets a general sentence.
 *
 * One catch: when a step runs out of retries, the Workflow runtime wraps the
 * step's last error in a NEW FatalError whose message repeats the original
 * one ('Step "…" failed after 5 retries: <original message>'), and keeps the
 * original as its `cause`. A FatalError never carries a cause otherwise (its
 * constructor takes only a message), so such an error is judged by its cause.
 */

export const UNEXPECTED_ERROR_MESSAGE =
  "The automation stopped on an unexpected error. The project's logs in Vercel have the details."

const MAX_LENGTH = 300

/** The runtime only ever wraps once; the limit just stops a cycle. */
const MAX_CAUSE_DEPTH = 5

function causeOf(err: unknown): unknown {
  return err && typeof err === 'object' ? (err as { cause?: unknown }).cause : undefined
}

/** A step's error after the runtime gave up retrying it: judge the original. */
function isOutOfRetries(err: unknown): boolean {
  return FatalError.is(err) && causeOf(err) !== undefined
}

/** The error that actually stopped the run, under any out-of-retries wrapper. */
export function rootError(err: unknown): unknown {
  let current = err
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && isOutOfRetries(current); depth++) {
    current = causeOf(current)
  }
  return current
}

export function reportableMessage(err: unknown): string {
  const root = rootError(err)
  if (isOutOfRetries(root)) return UNEXPECTED_ERROR_MESSAGE // a cycle; never pass a wrapper's message on
  if ((FatalError.is(root) || RetryableError.is(root)) && root.message.trim()) {
    const message = root.message.trim()
    return message.length > MAX_LENGTH ? `${message.slice(0, MAX_LENGTH - 1)}…` : message
  }
  return UNEXPECTED_ERROR_MESSAGE
}

/** For the project's own logs: what kind of error stopped the run — its
 *  name only, never its message (which may quote the item). */
export function errorKind(err: unknown): string {
  const root = rootError(err)
  const name = (root && typeof root === 'object' && (root as { name?: unknown }).name) || 'Error'
  return root === err ? String(name) : `${String(name)}, after the step ran out of retries`
}
