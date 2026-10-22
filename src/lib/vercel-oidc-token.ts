import { getVercelOidcToken } from '@vercel/oidc'

/**
 * This project's Vercel sign-in (an OIDC token), which AI Gateway accepts in
 * place of an API key. On Vercel it arrives with each request; locally,
 * `vercel env pull` puts one in .env.local for 12 hours.
 *
 * ONLY call this inside a step ('use step'). Workflow code is bundled for the
 * Workflow runtime's sandbox, where @vercel/oidc doesn't work and the build
 * breaks; and a token fetched in workflow code would be stored in the run's
 * history when passed to a step. A module of its own so tests can stand in
 * for it — a real call on a machine linked to Vercel could mint a real token.
 */
export async function vercelOidcToken(): Promise<string> {
  return getVercelOidcToken()
}
