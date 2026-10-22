#!/usr/bin/env node
/**
 * Runs after `next build` (npm run build): fails the build if the workflow
 * code reaches @vercel/oidc.
 *
 * The Vercel sign-in that AI Gateway takes may only be fetched inside a step
 * (src/lib/vercel-oidc-token.ts). Workflow code is bundled for the Workflow
 * runtime's sandbox, where @vercel/oidc resolves to a stand-in that returns an
 * empty token — so a call from workflow code would build fine and then fail
 * every run with a refused sign-in. Its traces in the workflow bundle are what
 * gives that away.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const BUNDLE = join(process.cwd(), 'src/app/.well-known/workflow/v1/flow/route.js')

if (!existsSync(BUNDLE)) {
  console.warn(`check-workflow-bundle: ${BUNDLE} wasn't found, so it wasn't checked.`)
  process.exit(0)
}
if (/getVercelOidcToken|@vercel\/oidc/.test(readFileSync(BUNDLE, 'utf8'))) {
  console.error(
    'Build stopped: workflow code reaches @vercel/oidc. Call vercelOidcToken() only inside a step ' +
      "('use step'), as askClaude does — never from a 'use workflow' function."
  )
  process.exit(1)
}
console.log('check-workflow-bundle: workflow code never reaches @vercel/oidc.')
