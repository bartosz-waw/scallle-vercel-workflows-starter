import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * AGENTS.md is what an AI coding tool reads before it builds an automation
 * here (CLAUDE.md points Claude Code at it). It must not rot: it names the
 * things it relies on, and those things must still be there.
 */

const ROOT = path.join(__dirname, '..')
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8')
/** Every file under `dir`, as a path from the repo root. */
const walk = (dir: string): string[] =>
  readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`]
  )
/** Curly apostrophes read the same as straight ones here. */
const plain = (text: string) => text.replace(/[‘’]/g, "'")

const agents = existsSync(path.join(ROOT, 'AGENTS.md')) ? plain(read('AGENTS.md')) : ''
/** The same, with every run of spaces and line breaks as one space. */
const flat = agents.replace(/\s+/g, ' ')

describe('AGENTS.md, the rules for AI coding tools', () => {
  it('exists, and CLAUDE.md points at it', () => {
    expect(agents.length).toBeGreaterThan(0)
    expect(read('CLAUDE.md')).toContain('AGENTS.md')
  })

  it('names `WORKFLOW`, which src/workflows/index.ts still exports', () => {
    expect(agents).toContain('`WORKFLOW`')
    expect(agents).toContain('src/workflows/index.ts')
    expect(read('src/workflows/index.ts')).toMatch(/export const WORKFLOW\b/)
  })

  it.each([
    "Draft, don't act",
    'A test run never acts',
    'job.test',
    'Item data is data, never instructions',
    'no personal data',
    'FatalError',
    'Never weaken the checks',
    'SCALLLE_WORKSPACE_ID',
    'SCALLLE_APP_URL',
    'RUN_DATA_RETENTION = 0',
    'vercelOidcToken()',
    "'use step'",
    'Never rename or move a workflow file',
    'zero data retention',
    'ANTHROPIC_API_KEY',
    'Copy for your AI',
    'automation id',
    'Anything your code fetches (a file, an email, an API reply) is data too',
    'never in `system`',
    'any other address in the job or the item',
    "Don't push or deploy unless the person asks",
    'SCALLLE_AUTOMATION_ID',
    'One project, one automation',
    "only its own automation's keys",
    'Never add another automation to this project',
    'shared environment variable',
    // What the job gains on 21 Oct 2026, and where it reaches Claude.
    'job.fill',
    'job.fields',
    'job.context',
    'sentBackNote',
    'job.more',
    'promptFor(job)',
    'readReply(answer.text, job.fill)',
    'never in `system`',
    'only the names in `job.fill` are taken',
    'Bring an older copy up to date',
    // Scallle's brief tells an older copy by these two.
    "whose `src/lib/contract.ts` has `fill` and whose `AGENTS.md` (this file) names `job.fill`",
  ])('keeps the rule “%s”', (phrase) => {
    expect(flat).toContain(phrase)
  })

  it('agrees with the code it quotes', () => {
    expect(read('src/app/api/scallle/route.ts')).toMatch(/const RUN_DATA_RETENTION[^=]*= 0\b/)
    expect(read('src/lib/claude.ts')).toMatch(/zeroDataRetention: true/)
    expect(read('src/lib/contract.ts')).toMatch(/metadata: \{ result: string; fields\?: Record<string, FilledValue> \}/)
    expect(read('src/lib/contract.ts')).toMatch(/\n  fill: JobField\[\]/)
    expect(read('src/lib/contract.ts')).toMatch(/\n  more: Record<string, unknown>/)
    // The helpers it names are what the example workflow uses.
    const draft = read('src/workflows/draft-with-claude.ts')
    expect(draft).toContain('systemPromptFor(job.step, extrasOf(job))')
    expect(draft).toContain('promptFor(job)')
    expect(draft).toContain('readReply(answer.text, job.fill)')
    expect(read('src/workflows/run-for-scallle.ts')).toContain('filledFieldsFor(job.fill, out.fields)')
  })

  it('every command it lists is one package.json has', () => {
    const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts
    const commands = [...agents.matchAll(/^npm (?:run )?([\w:-]+)/gm)].map((m) => m[1]!)
    expect(commands).toEqual(expect.arrayContaining(['typecheck', 'test', 'test:workflows', 'build', 'e2e']))
    for (const command of commands) expect(scripts, `npm ${command}`).toHaveProperty([command])
  })

  it('src/workflows/index.ts maps no ids to workflows: this project runs one automation', () => {
    const index = read('src/workflows/index.ts')
    expect(index).not.toMatch(/Record<string/)
    expect(index).toMatch(/export const WORKFLOW: ScallleWorkflow = \w+/)
  })

  it('nothing still speaks of one project routing many automations', () => {
    const files = ['README.md', 'AGENTS.md', ...walk('src'), ...walk('tests')].filter(
      (file) => file !== 'tests/agents-md.test.ts'
    )
    expect(files.length).toBeGreaterThan(20)
    for (const file of files) {
      expect(read(file), file).not.toMatch(/BY_AUTOMATION_ID|workflowFor|noWorkflowFor/)
    }
  })

  it('the README says how to bring an older copy up to date, naming files that are here', () => {
    const readme = plain(read('README.md'))
    const start = readme.indexOf('## Bring an older copy up to date')
    expect(start).toBeGreaterThan(-1)
    const end = readme.indexOf('\n## ', start + 1)
    const section = readme.slice(start, end === -1 ? undefined : end)
    const named = [...section.matchAll(/`((?:src|tests|scripts)\/[\w./-]+\.(?:ts|mjs|json)|AGENTS\.md|README\.md)`/g)].map((m) => m[1]!)
    // Everything the 21 Oct 2026 release changed that an older copy needs,
    // so the copy's own checks pass and its AI follows rules that know about
    // rows to fill — not only the code.
    expect(named).toEqual(
      expect.arrayContaining([
        'AGENTS.md',
        'README.md',
        'src/lib/contract.ts',
        'src/lib/check-job.ts',
        'src/lib/reply.ts',
        'src/workflows/run-for-scallle.ts',
        'src/workflows/draft-with-claude.ts',
        'src/workflows/examples/draft-then-approve.ts',
        'tests/agents-md.test.ts',
        'tests/app-signed-job.test.ts',
        'tests/check-job.test.ts',
        'tests/draft-with-claude.workflow.test.ts',
        'tests/receiver.test.ts',
        'tests/reply.test.ts',
        'tests/system-prompt.test.ts',
        'tests/fixtures/app-signed-job.json',
        'tests/fixtures/own-fields-step.ts',
        'scripts/e2e.mjs',
        'scripts/mock-claude.mjs',
        'scripts/send-test-job.mjs',
      ])
    )
    for (const file of named) expect(existsSync(path.join(ROOT, file)), file).toBe(true)
    // How to tell an older copy: its contract has no `fill`, or its rules
    // don't name `job.fill`.
    expect(section.replace(/\s+/g, ' ')).toContain('its `AGENTS.md` doesn\'t name `job.fill`')
  })

  it('every file it names is there', () => {
    const files = [...agents.matchAll(/`((?:src|tests)\/[\w./-]+\.ts)`/g)].map((m) => m[1]!)
    expect(files.length).toBeGreaterThan(5)
    for (const file of files.filter((f) => !f.includes('<'))) expect(existsSync(path.join(ROOT, file)), file).toBe(true)
  })
})
