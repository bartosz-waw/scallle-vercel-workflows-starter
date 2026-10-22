import { describe, expect, it } from 'vitest'
import { FatalError, RetryableError } from 'workflow'

import { errorKind, reportableMessage, UNEXPECTED_ERROR_MESSAGE } from '../src/lib/plain-errors'

describe('reportableMessage — what a failed run tells Scallle', () => {
  it('passes on the messages this project writes', () => {
    expect(reportableMessage(new FatalError('Claude declined to do this step (cyber).'))).toBe(
      'Claude declined to do this step (cyber).'
    )
    expect(reportableMessage(new RetryableError("Couldn't reach Claude."))).toBe("Couldn't reach Claude.")
  })

  it('recognises them after they have crossed a step boundary (name kept, class lost)', () => {
    const crossed = Object.assign(new Error('Scallle refused the result (HTTP 404).'), { name: 'FatalError' })
    expect(reportableMessage(crossed)).toBe('Scallle refused the result (HTTP 404).')
  })

  it('never passes on anything else, which could say anything', () => {
    expect(reportableMessage(new TypeError("Cannot read properties of undefined (reading 'Jane Doe')"))).toBe(
      UNEXPECTED_ERROR_MESSAGE
    )
    expect(reportableMessage('a string')).toBe(UNEXPECTED_ERROR_MESSAGE)
    expect(reportableMessage(undefined)).toBe(UNEXPECTED_ERROR_MESSAGE)
  })

  // When a step runs out of retries, the runtime throws a NEW FatalError that
  // repeats the step's last message and keeps the original as `cause`.
  const outOfRetries = (cause: unknown) =>
    Object.assign(new FatalError(`Step "step//./src/x//readNotes" failed after 1 retry: ${String((cause as Error)?.message)}`), { cause })

  it('judges a step that ran out of retries by its original error, never by the wrapper’s message', () => {
    expect(reportableMessage(outOfRetries(new Error("Couldn't read the notes: Jane Doe, 12 Acacia Avenue")))).toBe(
      UNEXPECTED_ERROR_MESSAGE
    )
    expect(reportableMessage(outOfRetries(new RetryableError('Claude was too busy or unwell to answer (HTTP 529).')))).toBe(
      'Claude was too busy or unwell to answer (HTTP 529).'
    )
    // As it arrives in the workflow: plain objects carrying the names.
    const hydrated = Object.assign(new Error('Step "…" failed after 5 retries: Unexpected token \'J\', "Jane Doe, "…'), {
      name: 'FatalError',
      cause: Object.assign(new Error('Unexpected token \'J\', "Jane Doe, "…'), { name: 'SyntaxError' }),
    })
    expect(reportableMessage(hydrated)).toBe(UNEXPECTED_ERROR_MESSAGE)
  })

  it('never passes on a wrapper’s message, even if its causes loop', () => {
    const a = new FatalError('Step "x" failed after 1 retry: Jane Doe') as FatalError & { cause?: unknown }
    a.cause = a
    expect(reportableMessage(a)).toBe(UNEXPECTED_ERROR_MESSAGE)
  })

  it('names the kind of error for the logs, never its message', () => {
    expect(errorKind(new FatalError('Claude declined to do this step (cyber).'))).toBe('FatalError')
    expect(errorKind(outOfRetries(new SyntaxError('Unexpected token J in "Jane Doe"')))).toBe(
      'SyntaxError, after the step ran out of retries'
    )
    expect(errorKind('a string')).toBe('Error')
  })

  it('keeps messages short', () => {
    expect(reportableMessage(new FatalError('x'.repeat(1000))).length).toBeLessThanOrEqual(300)
  })
})
