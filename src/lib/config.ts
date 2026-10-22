/**
 * This deployment's settings, read from the environment.
 *
 * Each automation gets its OWN copy of this project — its own repository and
 * Vercel project, in the business's own GitHub and Vercel — so one deployment
 * serves exactly one automation of one business:
 *
 *   SCALLLE_WORKSPACE_ID    the business's workspace id in Scallle (a UUID).
 *                           A job for any other workspace is refused. Scallle
 *                           signs every business's jobs with the same key, so
 *                           this is the wall between businesses: it must be
 *                           set, and must be a UUID, before anything runs.
 *   SCALLLE_AUTOMATION_ID   the one automation in Scallle this project runs
 *                           (a UUID). A job for any other automation is
 *                           refused, so this project's keys (to the
 *                           business's SharePoint, Outlook and the like) are
 *                           only ever used for its own automation. While it
 *                           isn't set every job is refused, naming the job's
 *                           own automation id as the value to set
 *                           (check-job.ts); set but not a UUID, every job is
 *                           refused.
 *   SCALLLE_APP_URL         where Scallle lives (https://app.scallle.com).
 *                           Scallle's public job keys are fetched only from
 *                           this origin, and results are only ever posted
 *                           back to it.
 *   ANTHROPIC_API_KEY       optional: the business's own Anthropic key. When
 *                           it is set Claude is called directly with it;
 *                           otherwise through Vercel AI Gateway on the
 *                           business's own Vercel account (claude.ts).
 *   ANTHROPIC_BASE_URL      local testing only: points Claude calls at the
 *                           mock. Refused anywhere else (see below).
 *
 * There is no secret to set: Scallle signs each job with its own key and
 * publishes the public half (signature.ts, scallle-keys.ts).
 *
 * Read when a request arrives, never at import: `next build` imports the
 * route, and a build must not fail because a runtime secret isn't there.
 */

export type Config = {
  /** Lower-case, as Scallle sends it. */
  workspaceId: string
  /** The one automation this project runs (SCALLLE_AUTOMATION_ID), lower-case —
   *  null while it isn't set: every job is then refused, naming its own
   *  automation id as the value to set (check-job.ts). */
  automationId: string | null
  /** The origin of SCALLLE_APP_URL, e.g. "https://app.scallle.com". */
  appOrigin: string
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Where Claude calls go when there is no ANTHROPIC_API_KEY. */
export const AI_GATEWAY_BASE_URL = 'https://ai-gateway.vercel.sh'

/** Thrown when the deployment isn't set up; its message names what's missing. */
export class NotConfiguredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotConfiguredError'
  }
}

/**
 * Scallle's origin from SCALLLE_APP_URL. It must be HTTPS — a result carries
 * the business's data and the run's token — except on this machine, where the
 * local mocks run over plain HTTP.
 */
export function appOrigin(): string {
  const raw = (process.env.SCALLLE_APP_URL ?? '').trim()
  if (!raw) throw new NotConfiguredError('SCALLLE_APP_URL is not set.')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new NotConfiguredError('SCALLLE_APP_URL is not a valid web address.')
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))) {
    throw new NotConfiguredError('SCALLLE_APP_URL must start with https://.')
  }
  return url.origin
}

export function isLocal(raw: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(raw).hostname)
  } catch {
    return false
  }
}

/**
 * ANTHROPIC_BASE_URL sends every Claude call — the item included — to another
 * address instead of Anthropic. It exists for the local mock. If it were left
 * in a deployment (copied over from .env.local, say), items would go wherever
 * it points, so it is only accepted when it is Anthropic's own HTTPS address,
 * or when both it and SCALLLE_APP_URL are on this machine (local testing).
 * Returns what's wrong, or null when all is well.
 */
export function anthropicBaseUrlProblem(): string | null {
  const raw = (process.env.ANTHROPIC_BASE_URL ?? '').trim()
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'ANTHROPIC_BASE_URL is not a valid web address. It is for local testing only: remove it.'
  }
  const anthropic = url.hostname === 'anthropic.com' || url.hostname.endsWith('.anthropic.com')
  if (url.protocol === 'https:' && anthropic) return null
  if (isLocal(raw) && isLocal(process.env.SCALLLE_APP_URL ?? '')) return null
  return (
    'ANTHROPIC_BASE_URL would send Claude calls somewhere other than Anthropic. ' +
    "It is for local testing only: remove it from this project's environment variables."
  )
}

/**
 * Where Claude calls go in AI Gateway mode: always Vercel's AI Gateway, except
 * while testing on this machine — ANTHROPIC_BASE_URL and SCALLLE_APP_URL both
 * local — when they go to the mock. Never an anthropic.com override: the
 * request carries this project's Vercel sign-in, which is for the gateway only.
 */
export function gatewayBaseUrl(): string {
  const raw = (process.env.ANTHROPIC_BASE_URL ?? '').trim()
  if (raw && isLocal(raw) && isLocal(process.env.SCALLLE_APP_URL ?? '')) return raw
  return AI_GATEWAY_BASE_URL
}

/** True when the business's own Anthropic key is set: Claude is then called directly with it. */
export function usesOwnAnthropicKey(): boolean {
  return (process.env.ANTHROPIC_API_KEY ?? '').trim() !== ''
}

/** Everything the receiver needs. Throws NotConfiguredError naming every
 *  missing setting, so the fix is one look at the Vercel project. A missing
 *  SCALLLE_AUTOMATION_ID alone doesn't throw: it comes back null, and each job
 *  is then refused naming its own automation id as the value to set. */
export function readConfig(): Config {
  const workspaceId = (process.env.SCALLLE_WORKSPACE_ID ?? '').trim()
  const automationId = (process.env.SCALLLE_AUTOMATION_ID ?? '').trim()
  const appUrlMissing = !(process.env.SCALLLE_APP_URL ?? '').trim()
  if (!workspaceId || appUrlMissing) {
    const missing: string[] = []
    if (!workspaceId) missing.push('SCALLLE_WORKSPACE_ID')
    if (!automationId) missing.push('SCALLLE_AUTOMATION_ID')
    if (appUrlMissing) missing.push('SCALLLE_APP_URL')
    throw new NotConfiguredError(
      `This project isn't set up yet: ${missing.join(', ')} missing from its environment variables.`
    )
  }
  if (!UUID.test(workspaceId)) {
    throw new NotConfiguredError(
      'SCALLLE_WORKSPACE_ID isn’t a workspace id. It must be the business’s workspace id in Scallle, a UUID like 11111111-1111-4111-8111-111111111111.'
    )
  }
  if (automationId && !UUID.test(automationId)) {
    throw new NotConfiguredError(
      'SCALLLE_AUTOMATION_ID isn’t an automation id. It must be the step’s automation id in Scallle, a UUID like 33333333-3333-4333-8333-333333333333.'
    )
  }
  const baseUrlProblem = anthropicBaseUrlProblem()
  if (baseUrlProblem) throw new NotConfiguredError(baseUrlProblem)
  return {
    workspaceId: workspaceId.toLowerCase(),
    automationId: automationId ? automationId.toLowerCase() : null,
    appOrigin: appOrigin(),
  }
}
