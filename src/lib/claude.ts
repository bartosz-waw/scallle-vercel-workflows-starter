import Anthropic from '@anthropic-ai/sdk'
import { FatalError, RetryableError } from 'workflow'

import { anthropicBaseUrlProblem, gatewayBaseUrl, usesOwnAnthropicKey } from './config'
import type { Usage } from './contract'
import { retryDelayMs } from './retry'
import { vercelOidcToken } from './vercel-oidc-token'

/**
 * Calling Claude from an automation. Two ways, decided by ANTHROPIC_API_KEY:
 *
 *   - Not set (the default): through Vercel AI Gateway, signed in as this
 *     project (its Vercel OIDC token) and billed to the business's own
 *     Vercel account. Anthropic only, with zero data retention — the request
 *     says so, and the gateway refuses it rather than route the item
 *     anywhere else. Only the standard Messages fields are sent.
 *   - Set: directly to Anthropic with the business's own key, with
 *     server-side fallback on (`fallbacks: 'default'`): if Claude Opus 5.5's
 *     safety classifiers decline the request, Anthropic re-runs it on its
 *     recommended fallback model within the same call.
 *
 * `askClaude` is a step: once a call has answered, its answer is kept and a
 * later failure never pays for the call again. Retries are the step's, not
 * the SDK's (maxRetries: 0), so every attempt shows in the run's history and
 * waits out the service's Retry-After rather than holding a function open.
 */

/** Claude Opus 5.5 ($4 / $20 per million tokens in / out). */
export const DEFAULT_MODEL = 'claude-opus-5-5'

/** What the gateway is asked for on every call: Anthropic itself, and no
 *  copy of the item kept anywhere. Never loosened to make a call work. */
export const GATEWAY_PROVIDER_OPTIONS = {
  gateway: { order: ['anthropic'], only: ['anthropic'], zeroDataRetention: true },
} as const

/** A whole call — headers and the streamed answer — must finish inside this,
 *  so a stuck call fails cleanly and is retried before Vercel stops the
 *  function (800 s at most on Pro). */
const CALL_DEADLINE_MS = 700_000

export type AskClaudeInput = {
  /** Instructions: the step's procedure and the rules. Never item data. */
  system: string
  /** The unit of work — the item. Data only. */
  prompt: string
  /** Anthropic's id, e.g. 'claude-opus-5-5' (turned into the gateway's
   *  'anthropic/claude-opus-5.5' when the call goes through AI Gateway). */
  model?: string
  /** How hard Claude thinks. Opus 5.5 always thinks; effort sets how much. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  maxTokens?: number
}

export type AskClaudeResult = { text: string; usage: Usage }

type Mode = 'own-key' | 'gateway'

type AnyMessage = Anthropic.Messages.Message | Anthropic.Beta.Messages.BetaMessage
type AnyContentBlock = Anthropic.Messages.ContentBlock | Anthropic.Beta.Messages.BetaContentBlock

/** Own-key mode: one client, reading ANTHROPIC_API_KEY. */
let client: Anthropic | null = null
function anthropic(): Anthropic {
  client ??= new Anthropic({ maxRetries: 0 })
  return client
}

/** AI Gateway's name for an Anthropic model: 'claude-opus-5-5' → 'anthropic/claude-opus-5.5'. */
export function gatewayModelId(model: string): string {
  if (model.includes('/')) return model
  return `anthropic/${model.replace(/-(\d+)-(\d{1,2})$/, '-$1.$2')}`
}

/** Anthropic's own spelling, which Scallle prices: 'anthropic/claude-opus-5.5' → 'claude-opus-5-5'. */
export function nativeModelId(model: string): string {
  return model.replace(/^anthropic\//, '').replace(/\./g, '-')
}

/** Own key: the call as it has always been made. */
function callWithOwnKey(input: AskClaudeInput): Promise<AnyMessage> {
  return anthropic()
    .beta.messages.stream(
      {
        model: input.model ?? DEFAULT_MODEL,
        max_tokens: input.maxTokens ?? 16_000,
        system: input.system,
        messages: [{ role: 'user', content: input.prompt }],
        output_config: { effort: input.effort ?? 'medium' },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      },
      { signal: AbortSignal.timeout(CALL_DEADLINE_MS) }
    )
    .finalMessage()
}

/**
 * AI Gateway: a client made for this one call, holding this invocation's
 * token. The key and the address are passed explicitly, so no stray
 * ANTHROPIC_AUTH_TOKEN or ANTHROPIC_BASE_URL can add a header or send the
 * item (or the token) anywhere else.
 */
async function callThroughGateway(input: AskClaudeInput): Promise<AnyMessage> {
  let token = ''
  try {
    token = (await vercelOidcToken()).trim()
  } catch {
    token = ''
  }
  if (!token) throw new FatalError(NO_VERCEL_SIGN_IN)

  const gateway = new Anthropic({ apiKey: token, authToken: null, baseURL: gatewayBaseUrl(), maxRetries: 0 })
  const params = {
    model: gatewayModelId(input.model ?? DEFAULT_MODEL),
    max_tokens: input.maxTokens ?? 16_000,
    system: input.system,
    messages: [{ role: 'user' as const, content: input.prompt }],
    output_config: { effort: input.effort ?? 'medium' },
    providerOptions: GATEWAY_PROVIDER_OPTIONS,
  }
  return gateway.messages.stream(params, { signal: AbortSignal.timeout(CALL_DEADLINE_MS) }).finalMessage()
}

const NO_VERCEL_SIGN_IN =
  'This project couldn’t get its Vercel sign-in for AI Gateway. Check it runs on Vercel with ' +
  'System Environment Variables exposed and OIDC turned on, or add ANTHROPIC_API_KEY and redeploy.'

export async function askClaude(input: AskClaudeInput): Promise<AskClaudeResult> {
  'use step'
  // The receiver refuses jobs while this is wrong; checked again here because
  // this is where the item leaves for Claude, whoever started the run.
  const baseUrlProblem = anthropicBaseUrlProblem()
  if (baseUrlProblem) throw new FatalError(baseUrlProblem)

  const mode: Mode = usesOwnAnthropicKey() ? 'own-key' : 'gateway'
  let message: AnyMessage
  try {
    message = mode === 'own-key' ? await callWithOwnKey(input) : await callThroughGateway(input)
  } catch (err) {
    throw asStepError(err, mode)
  }

  // Check why Claude stopped BEFORE reading the answer.
  if (message.stop_reason === 'refusal') {
    const category = message.stop_details?.category
    throw new FatalError(`Claude declined to do this step${category ? ` (${category})` : ''}.`)
  }
  if (message.stop_reason === 'max_tokens') {
    throw new FatalError("Claude's answer was cut off before it finished. Raise maxTokens for this automation.")
  }
  if (message.stop_reason === 'model_context_window_exceeded') {
    throw new FatalError('The item is too long for Claude to read in one go.')
  }

  const text = answerText(message.content)
  if (!text) throw new FatalError('Claude returned an empty answer.')
  return { text, usage: usageOf(message) }
}

// Up to 6 tries, 5 s to 80 s apart (or as long as the service's Retry-After asks).
askClaude.maxRetries = 5

/**
 * The answer's text. If a fallback model took over part-way through, the
 * declined model's partial text comes before the last `fallback` block and is
 * not part of the answer — only the text after it is.
 */
export function answerText(content: AnyContentBlock[]): string {
  let start = 0
  content.forEach((block, i) => {
    if (block.type === 'fallback') start = i + 1
  })
  return content
    .slice(start)
    .flatMap((block) => (block.type === 'text' && 'text' in block ? [block.text] : []))
    .join('')
    .trim()
}

/**
 * Tokens for the whole call, so Scallle can cost the run. When a fallback
 * model finished the answer, top-level usage covers only its attempt; the
 * declined attempt (billed too) is in usage.iterations, so the 'message' and
 * 'fallback_message' entries are added up. Cache reads and writes count as
 * input — Scallle prices input at one rate, so a cache-heavy call is
 * over-counted a little, never under. The model is the one that answered,
 * in Anthropic's own spelling (AI Gateway's 'anthropic/claude-opus-5.5' is
 * reported as 'claude-opus-5-5') so Scallle can price it.
 */
export function usageOf(message: AnyMessage): Usage {
  const u = message.usage
  const iterations = 'iterations' in u ? (u.iterations ?? []) : []
  const attempts = iterations.filter(
    (it) => it.type === 'message' || it.type === 'fallback_message'
  )
  const counted = attempts.length > 0 ? attempts : [u]
  let input = 0
  let output = 0
  for (const a of counted) {
    input += a.input_tokens + (a.cache_read_input_tokens ?? 0) + (a.cache_creation_input_tokens ?? 0)
    output += a.output_tokens
  }
  return { model: nativeModelId(message.model), input_tokens: input, output_tokens: output }
}

/** Add up usage across several Claude calls in one run. */
export function addUsage(a: Usage | null, b: Usage): Usage {
  if (!a) return b
  return {
    model: b.model,
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
  }
}

/** Error types Anthropic sends mid-stream that are worth another try. */
const RETRYABLE_STREAM_ERRORS = new Set(['overloaded_error', 'api_error', 'rate_limit_error'])

/** AI Gateway's error types for "no credit" or "this model isn't on your plan". */
const GATEWAY_NOT_AVAILABLE = /credit|fund|billing|payment|quota|eligib|plan|tier/i

const GATEWAY_NOT_AVAILABLE_MESSAGE =
  'Claude isn’t available on this Vercel account’s AI Gateway yet. Add AI Gateway credit in Vercel ' +
  '(AI Gateway → Credits), or add ANTHROPIC_API_KEY and redeploy.'

/**
 * Turn an SDK error into what the step should do. The messages are written
 * here, never copied from the API, so nothing from the request (the item)
 * can leak into an error that goes to Scallle. They name the right account:
 * the Anthropic key in own-key mode, the Vercel account through AI Gateway.
 */
export function asStepError(err: unknown, mode: Mode = 'own-key'): Error {
  // Abort and connection errors are APIErrors too, so they come first.
  if (err instanceof Anthropic.APIUserAbortError) {
    return new RetryableError('Claude took too long to answer.', { retryAfter: retryDelayMs() })
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new RetryableError("Couldn't reach Claude.", { retryAfter: retryDelayMs() })
  }
  if (mode === 'gateway' && err instanceof Anthropic.APIError && err.status !== undefined) {
    const gatewayError = asGatewayError(err)
    if (gatewayError) return gatewayError
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new RetryableError('Claude kept rate-limiting this Anthropic key (429).', {
      retryAfter: retryDelayMs(err.headers.get('retry-after')),
    })
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return new FatalError('The Anthropic API key was refused. Check ANTHROPIC_API_KEY in the Vercel project.')
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new FatalError("This Anthropic key isn't allowed to use this model or feature.")
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new FatalError("Claude doesn't recognise the model this automation asks for.")
  }
  if (err instanceof Anthropic.InternalServerError) {
    return new RetryableError(`Claude was too busy or unwell to answer (HTTP ${err.status}).`, {
      retryAfter: retryDelayMs(err.headers.get('retry-after')),
    })
  }
  if (err instanceof Anthropic.APIError) {
    // An error sent part-way through the stream has no HTTP status.
    if (err.status === undefined && err.type && RETRYABLE_STREAM_ERRORS.has(err.type)) {
      return new RetryableError(`Claude stopped part-way with ${err.type}.`, { retryAfter: retryDelayMs() })
    }
    if (err.status === 408) {
      return new RetryableError('Claude took too long to answer (HTTP 408).', { retryAfter: retryDelayMs() })
    }
    const what = err.status ? `HTTP ${err.status}` : (err.type ?? 'an unknown error')
    return new FatalError(`Claude couldn't accept this request (${what}).`)
  }
  // Anything else is a bug or an unexpected failure: retried as usual, and
  // reported to Scallle in general terms only.
  return err instanceof Error ? err : new Error(String(err))
}

/** The answers only AI Gateway gives, judged by status AND the gateway's
 *  error type. Null for anything that reads the same in both modes. */
function asGatewayError(err: InstanceType<typeof Anthropic.APIError>): Error | null {
  const type = gatewayErrorType(err)
  if (err.status === 401) {
    return new FatalError(
      'AI Gateway refused this project’s Vercel sign-in. Check the project was deployed on Vercel with System Environment Variables exposed.'
    )
  }
  if (err.status === 402 || err.status === 403 || GATEWAY_NOT_AVAILABLE.test(type)) {
    return new FatalError(GATEWAY_NOT_AVAILABLE_MESSAGE)
  }
  if (err.status === 400 && type === 'no_providers_available') {
    return new FatalError('AI Gateway refused zero data retention for this request. It needs a Vercel Pro plan.')
  }
  if (err.status === 429) {
    return new RetryableError('Claude couldn’t be called just then: AI Gateway is rate-limiting this Vercel account (429).', {
      retryAfter: retryDelayMs(err.headers?.get('retry-after')),
    })
  }
  if (err.status === 404) {
    return new FatalError('AI Gateway doesn’t offer the model this automation asks for.')
  }
  return null
}

/** The machine-readable error type: `error.type`, or `error.code` where the gateway uses that. */
function gatewayErrorType(err: InstanceType<typeof Anthropic.APIError>): string {
  const inner = (err.error as { error?: { type?: unknown; code?: unknown } } | undefined)?.error
  for (const value of [err.type, inner?.type, inner?.code]) {
    if (typeof value === 'string' && value) return value
  }
  return ''
}
