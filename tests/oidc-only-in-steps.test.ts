import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * The project's Vercel sign-in may only be fetched inside a step. From
 * workflow code @vercel/oidc resolves to a stand-in returning '' (every run
 * would then fail at AI Gateway), and a token passed into a step is stored in
 * the run's history. `npm run build` checks the workflow bundle for it
 * (scripts/check-workflow-bundle.mjs); this keeps the source honest too.
 */

const SRC = path.join(__dirname, '../src')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === '.well-known' ? [] : sourceFiles(full)
    return /\.tsx?$/.test(entry.name) ? [full] : []
  })
}

const files = sourceFiles(SRC).map((file) => ({ file: path.relative(SRC, file), text: readFileSync(file, 'utf8') }))

describe('the Vercel sign-in is only ever fetched inside a step', () => {
  it('only src/lib/vercel-oidc-token.ts imports @vercel/oidc', () => {
    expect(files.filter((f) => f.text.includes('@vercel/oidc')).map((f) => f.file)).toEqual(['lib/vercel-oidc-token.ts'])
  })

  it('only src/lib/claude.ts uses it', () => {
    expect(files.filter((f) => /from '[^']*\/vercel-oidc-token'/.test(f.text)).map((f) => f.file)).toEqual(['lib/claude.ts'])
  })

  it('in claude.ts, from callThroughGateway, which only askClaude — a step — calls', () => {
    const claude = files.find((f) => f.file === 'lib/claude.ts')!.text
    const functions = claude.split(/\n(?=(?:export )?(?:async )?function )/)
    const calling = (name: string) => functions.filter((fn) => fn.includes(`${name}(`) && !fn.match(new RegExp(`function ${name}\\(`)))
    const tokenCallers = calling('vercelOidcToken')
    expect(tokenCallers).toHaveLength(1)
    expect(tokenCallers[0]).toMatch(/^async function callThroughGateway\(/)
    const gatewayCallers = calling('callThroughGateway')
    expect(gatewayCallers).toHaveLength(1)
    expect(gatewayCallers[0]).toMatch(/^export async function askClaude\([^)]*\)[^{]*\{\n\s*'use step'/)
  })
})
