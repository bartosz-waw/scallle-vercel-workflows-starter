import { afterEach, describe, expect, it, vi } from 'vitest'

import { anthropicBaseUrlProblem, gatewayBaseUrl, NotConfiguredError, readConfig } from '../src/lib/config'

/** ANTHROPIC_BASE_URL may only point at Anthropic, or at the mock while testing locally. */
describe('anthropicBaseUrlProblem', () => {
  afterEach(() => vi.unstubAllEnvs())

  const deployed = (baseUrl: string) => {
    vi.stubEnv('SCALLLE_APP_URL', 'https://app.scallle.com')
    vi.stubEnv('ANTHROPIC_BASE_URL', baseUrl)
    return anthropicBaseUrlProblem()
  }

  it('is fine when unset, or when it is Anthropic’s own HTTPS address', () => {
    expect(deployed('')).toBeNull()
    expect(deployed('https://api.anthropic.com')).toBeNull()
  })

  it('is fine pointing at the local mock while Scallle is local too', () => {
    vi.stubEnv('SCALLLE_APP_URL', 'http://127.0.0.1:4010')
    vi.stubEnv('ANTHROPIC_BASE_URL', 'http://127.0.0.1:4020')
    expect(anthropicBaseUrlProblem()).toBeNull()
  })

  it('refuses a leftover local address, plain HTTP, another host, or nonsense in a real deployment', () => {
    expect(deployed('http://127.0.0.1:4020')).toContain('ANTHROPIC_BASE_URL')
    expect(deployed('http://api.anthropic.com')).toContain('ANTHROPIC_BASE_URL')
    expect(deployed('https://proxy.example.com')).toContain('ANTHROPIC_BASE_URL')
    expect(deployed('https://api.anthropic.com.example.com')).toContain('ANTHROPIC_BASE_URL')
    expect(deployed('not a url')).toContain('ANTHROPIC_BASE_URL')
  })
})

describe('readConfig', () => {
  afterEach(() => vi.unstubAllEnvs())

  const AUTOMATION = '33333333-3333-4333-8333-333333333333'

  const configWith = (workspaceId: string, automationId: string = AUTOMATION) => {
    vi.stubEnv('SCALLLE_APP_URL', 'https://app.scallle.com')
    vi.stubEnv('SCALLLE_WORKSPACE_ID', workspaceId)
    vi.stubEnv('SCALLLE_AUTOMATION_ID', automationId)
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    vi.stubEnv('ANTHROPIC_BASE_URL', '')
    return readConfig()
  }

  it('needs only SCALLLE_WORKSPACE_ID, SCALLLE_AUTOMATION_ID and SCALLLE_APP_URL — no secret, no Anthropic key', () => {
    expect(configWith('11111111-1111-4111-8111-111111111111')).toEqual({
      workspaceId: '11111111-1111-4111-8111-111111111111',
      automationId: AUTOMATION,
      appOrigin: 'https://app.scallle.com',
    })
  })

  it('takes a pasted automation id with spaces or capitals as the same id', () => {
    expect(configWith('11111111-1111-4111-8111-111111111111', '  33333333-AAAA-4333-8333-333333333333 ').automationId).toBe(
      '33333333-aaaa-4333-8333-333333333333'
    )
  })

  it('without SCALLLE_AUTOMATION_ID, doesn’t throw: the automation is null (each job is then refused, naming its id)', () => {
    expect(configWith('11111111-1111-4111-8111-111111111111', '')).toEqual({
      workspaceId: '11111111-1111-4111-8111-111111111111',
      automationId: null,
      appOrigin: 'https://app.scallle.com',
    })
    expect(configWith('11111111-1111-4111-8111-111111111111', '   ').automationId).toBeNull()
  })

  it.each([
    ['not a UUID', 'auto_1'],
    ['a UUID with trailing junk', '33333333-3333-4333-8333-333333333333x'],
    ['a UUID missing a part', '33333333-3333-4333-333333333333'],
  ])('refuses a SCALLLE_AUTOMATION_ID that is %s, naming it', (_name, value) => {
    expect(() => configWith('11111111-1111-4111-8111-111111111111', value)).toThrow(NotConfiguredError)
    expect(() => configWith('11111111-1111-4111-8111-111111111111', value)).toThrow(
      'SCALLLE_AUTOMATION_ID isn’t an automation id. It must be the step’s automation id in Scallle, a UUID like 33333333-3333-4333-8333-333333333333.'
    )
  })

  it('when the workspace id is missing too, names both, in order, with SCALLLE_APP_URL last when it is missing', () => {
    expect(() => configWith('', '')).toThrow(
      "This project isn't set up yet: SCALLLE_WORKSPACE_ID, SCALLLE_AUTOMATION_ID missing from its environment variables."
    )
    vi.stubEnv('SCALLLE_APP_URL', '')
    expect(() => readConfig()).toThrow(
      "This project isn't set up yet: SCALLLE_WORKSPACE_ID, SCALLLE_AUTOMATION_ID, SCALLLE_APP_URL missing from its environment variables."
    )
  })

  it('names SCALLLE_AUTOMATION_ID among the missing only when it is missing', () => {
    expect(() => configWith('')).toThrow(
      "This project isn't set up yet: SCALLLE_WORKSPACE_ID missing from its environment variables."
    )
  })

  it('takes a pasted workspace id with spaces or capitals as the same id', () => {
    expect(configWith('  11111111-AAAA-4111-8111-111111111111 ').workspaceId).toBe('11111111-aaaa-4111-8111-111111111111')
  })

  it.each([
    ['empty', ''],
    ['not a UUID', 'ws_x'],
    ['a UUID with trailing junk', '11111111-1111-4111-8111-111111111111x'],
    ['a UUID with more after a space', '11111111-1111-4111-8111-111111111111 22222222'],
    ['a UUID missing a part', '11111111-1111-4111-111111111111'],
  ])('refuses a SCALLLE_WORKSPACE_ID that is %s, naming it', (_name, value) => {
    expect(() => configWith(value)).toThrow(NotConfiguredError)
    expect(() => configWith(value)).toThrow(/SCALLLE_WORKSPACE_ID/)
  })
})

/** Where Claude calls go without ANTHROPIC_API_KEY: the gateway, or the local mock — never anywhere else. */
describe('gatewayBaseUrl', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('is Vercel’s AI Gateway when nothing says otherwise', () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', '')
    vi.stubEnv('SCALLLE_APP_URL', 'https://app.scallle.com')
    expect(gatewayBaseUrl()).toBe('https://ai-gateway.vercel.sh')
  })

  it('is the local mock only while Scallle is local too', () => {
    vi.stubEnv('SCALLLE_APP_URL', 'http://127.0.0.1:4010')
    vi.stubEnv('ANTHROPIC_BASE_URL', 'http://127.0.0.1:4020')
    expect(gatewayBaseUrl()).toBe('http://127.0.0.1:4020')
  })

  it('never follows an anthropic.com override (the request carries this project’s Vercel sign-in)', () => {
    vi.stubEnv('SCALLLE_APP_URL', 'https://app.scallle.com')
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://api.anthropic.com')
    expect(gatewayBaseUrl()).toBe('https://ai-gateway.vercel.sh')
    vi.stubEnv('SCALLLE_APP_URL', 'http://127.0.0.1:4010')
    expect(gatewayBaseUrl()).toBe('https://ai-gateway.vercel.sh')
  })

  it('never follows a local override in a real deployment', () => {
    vi.stubEnv('SCALLLE_APP_URL', 'https://app.scallle.com')
    vi.stubEnv('ANTHROPIC_BASE_URL', 'http://127.0.0.1:4020')
    expect(gatewayBaseUrl()).toBe('https://ai-gateway.vercel.sh')
  })
})
