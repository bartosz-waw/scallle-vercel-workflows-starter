import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createKeyStore,
  FRESH_MS,
  jwkThumbprint,
  KEYS_PATH,
  parseKeyDocument,
  REFETCH_AFTER_FAILURE_MS,
  REFETCH_AFTER_SUCCESS_MS,
  STALE_MS,
} from '../src/lib/scallle-keys'
// @ts-expect-error — a plain .mjs test helper without types
import { TEST_KEY, TEST_ROTATED_KEY, TEST_STRAY_KEY } from '../scripts/test-signing-key.mjs'

const ORIGIN = 'https://app.scallle.test'

type Answer = { status?: number; body?: string; contentType?: string } | 'network-error'

/** A stand-in for fetch: answers from a queue (the last answer repeats), recording each call. */
function fakeScallle(...answers: Answer[]) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const queue = [...answers]
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const answer = queue.length > 1 ? queue.shift()! : queue[0]
    if (answer === 'network-error') throw new TypeError('fetch failed')
    return new Response(answer.body ?? '', {
      status: answer.status ?? 200,
      headers: { 'content-type': answer.contentType ?? 'application/json' },
    })
  })
  return { fetch, calls }
}

const doc = (...keys: Array<{ jwk: Record<string, unknown> }>) => ({ body: JSON.stringify({ keys: keys.map((k) => k.jwk) }) })

let clock = 0
const now = () => clock

beforeEach(() => {
  clock = 1_000_000
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => vi.restoreAllMocks())

describe('the key document', () => {
  it('kid is the RFC 7638 thumbprint of crv, kty and x', () => {
    expect(jwkThumbprint(TEST_KEY.jwk.x)).toBe(TEST_KEY.kid)
  })

  it('keeps Ed25519 keys whose kid is their thumbprint, and ignores everything else', () => {
    const keys = parseKeyDocument({
      keys: [
        TEST_KEY.jwk,
        { ...TEST_ROTATED_KEY.jwk, kid: TEST_KEY.kid }, // a kid that isn't its own thumbprint
        { ...TEST_STRAY_KEY.jwk, crv: 'X25519' },
        { kty: 'RSA', n: 'abc', e: 'AQAB', kid: 'rsa' },
        { kty: 'OKP', crv: 'Ed25519', x: 'too-short', kid: jwkThumbprint('too-short') },
        null,
        'junk',
      ],
    })
    expect([...keys!.keys()]).toEqual([TEST_KEY.kid])
  })

  it('reads at most 10 entries', () => {
    const filler = Array.from({ length: 10 }, () => ({ kty: 'RSA' }))
    expect(parseKeyDocument({ keys: [...filler, TEST_KEY.jwk] })!.size).toBe(0)
  })

  it('is not a key document unless it is an object with a keys array', () => {
    expect(parseKeyDocument(null)).toBeNull()
    expect(parseKeyDocument([TEST_KEY.jwk])).toBeNull()
    expect(parseKeyDocument({ error: 'nope' })).toBeNull()
  })
})

describe('createKeyStore — fetching', () => {
  it('fetches only from <origin>/.well-known/scallle-job-keys: no redirects, no cache, a time limit', async () => {
    const scallle = fakeScallle(doc(TEST_KEY))
    const store = createKeyStore({ fetch: scallle.fetch, now })
    const found = await store.keyFor(ORIGIN, TEST_KEY.kid)
    expect(found.ok).toBe(true)
    expect(scallle.calls).toHaveLength(1)
    expect(scallle.calls[0].url).toBe(`${ORIGIN}${KEYS_PATH}`)
    expect(scallle.calls[0].init).toMatchObject({ method: 'GET', redirect: 'error', cache: 'no-store' })
    expect(scallle.calls[0].init.signal).toBeInstanceOf(AbortSignal)
  })

  it('keeps a fetched document for 5 minutes, then fetches again', async () => {
    const scallle = fakeScallle(doc(TEST_KEY))
    const store = createKeyStore({ fetch: scallle.fetch, now })
    await store.keyFor(ORIGIN, TEST_KEY.kid)
    clock += FRESH_MS - 1
    await store.keyFor(ORIGIN, TEST_KEY.kid)
    expect(scallle.calls).toHaveLength(1)
    clock += 1
    await store.keyFor(ORIGIN, TEST_KEY.kid)
    expect(scallle.calls).toHaveLength(2)
  })

  it('keeps each origin apart', async () => {
    const scallle = fakeScallle(doc(TEST_KEY))
    const store = createKeyStore({ fetch: scallle.fetch, now })
    await store.keyFor(ORIGIN, TEST_KEY.kid)
    await store.keyFor('https://other.scallle.test', TEST_KEY.kid)
    expect(scallle.calls.map((c) => c.url)).toEqual([`${ORIGIN}${KEYS_PATH}`, `https://other.scallle.test${KEYS_PATH}`])
  })

  it('shares one fetch between jobs arriving together', async () => {
    const scallle = fakeScallle(doc(TEST_KEY))
    const store = createKeyStore({ fetch: scallle.fetch, now })
    const all = await Promise.all([1, 2, 3].map(() => store.keyFor(ORIGIN, TEST_KEY.kid)))
    expect(all.every((r) => r.ok)).toBe(true)
    expect(scallle.calls).toHaveLength(1)
  })
})

describe('createKeyStore — a kid it doesn’t hold', () => {
  it('refetches once for a new kid (a rotation), and finds it', async () => {
    const scallle = fakeScallle(doc(TEST_KEY), doc(TEST_KEY, TEST_ROTATED_KEY))
    const store = createKeyStore({ fetch: scallle.fetch, now })
    await store.keyFor(ORIGIN, TEST_KEY.kid)
    clock += REFETCH_AFTER_SUCCESS_MS
    expect((await store.keyFor(ORIGIN, TEST_ROTATED_KEY.kid)).ok).toBe(true)
    expect(scallle.calls).toHaveLength(2)
  })

  it('says unknown when Scallle’s current document doesn’t publish it', async () => {
    const scallle = fakeScallle(doc(TEST_KEY))
    const store = createKeyStore({ fetch: scallle.fetch, now })
    expect(await store.keyFor(ORIGIN, TEST_STRAY_KEY.kid)).toEqual({ ok: false, reason: 'unknown' })
  })

  it('refetches for made-up kids at most once every 30 s after a fetch that worked', async () => {
    const scallle = fakeScallle(doc(TEST_KEY))
    const store = createKeyStore({ fetch: scallle.fetch, now })
    await store.keyFor(ORIGIN, TEST_KEY.kid)
    for (let i = 0; i < 20; i++) {
      clock += 1_000
      expect(await store.keyFor(ORIGIN, `made-up-${i}`)).toEqual({ ok: false, reason: 'unknown' })
    }
    // 20 s of made-up kids: no refetch yet. At 30 s, one.
    expect(scallle.calls).toHaveLength(1)
    clock += 10_000
    await store.keyFor(ORIGIN, 'made-up-again')
    expect(scallle.calls).toHaveLength(2)
    await store.keyFor(ORIGIN, 'and-again')
    expect(scallle.calls).toHaveLength(2)
  })
})

describe('createKeyStore — when Scallle can’t be fetched', () => {
  it('is unavailable when nothing was ever fetched', async () => {
    const store = createKeyStore({ fetch: fakeScallle('network-error').fetch, now })
    expect(await store.keyFor(ORIGIN, TEST_KEY.kid)).toEqual({ ok: false, reason: 'unavailable' })
  })

  it.each<[string, Answer]>([
    ['a 503', { status: 503, body: '{"error":"down"}' }],
    ['a 404', { status: 404, body: 'not found' }],
    ['a redirect', { status: 302, body: '' }],
    ['an HTML page with 200 (a firewall challenge)', { status: 200, body: '<!doctype html><title>Checking…</title>', contentType: 'text/html' }],
    ['JSON that isn’t a key document', { status: 200, body: '{"error":"nope"}' }],
    ['a document over 16 KB', { status: 200, body: JSON.stringify({ keys: [TEST_KEY.jwk], pad: 'x'.repeat(17_000) }) }],
  ])('treats %s as can’t fetch (unavailable), never as unknown', async (_name, answer) => {
    const store = createKeyStore({ fetch: fakeScallle(answer).fetch, now })
    expect(await store.keyFor(ORIGIN, TEST_KEY.kid)).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('tries again after about 1 s when the last fetch failed — so Scallle’s quick resends get a real try', async () => {
    const scallle = fakeScallle('network-error', doc(TEST_KEY))
    const store = createKeyStore({ fetch: scallle.fetch, now })
    expect((await store.keyFor(ORIGIN, TEST_KEY.kid)).ok).toBe(false)
    clock += REFETCH_AFTER_FAILURE_MS - 1
    expect(await store.keyFor(ORIGIN, TEST_KEY.kid)).toEqual({ ok: false, reason: 'unavailable' })
    expect(scallle.calls).toHaveLength(1)
    clock += 1
    expect((await store.keyFor(ORIGIN, TEST_KEY.kid)).ok).toBe(true)
    expect(scallle.calls).toHaveLength(2)
  })

  it('keeps using the last document for up to an hour after it was fetched', async () => {
    const scallle = fakeScallle(doc(TEST_KEY), 'network-error')
    const store = createKeyStore({ fetch: scallle.fetch, now })
    await store.keyFor(ORIGIN, TEST_KEY.kid)
    clock += STALE_MS - 1
    expect((await store.keyFor(ORIGIN, TEST_KEY.kid)).ok).toBe(true)
    clock += 1
    expect(await store.keyFor(ORIGIN, TEST_KEY.kid)).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('says unavailable (not unknown) for a kid it doesn’t hold while the refetch fails', async () => {
    const scallle = fakeScallle(doc(TEST_KEY), 'network-error')
    const store = createKeyStore({ fetch: scallle.fetch, now })
    await store.keyFor(ORIGIN, TEST_KEY.kid)
    clock += REFETCH_AFTER_SUCCESS_MS
    expect(await store.keyFor(ORIGIN, TEST_ROTATED_KEY.kid)).toEqual({ ok: false, reason: 'unavailable' })
    // …and straight after that failure, too.
    expect(await store.keyFor(ORIGIN, TEST_ROTATED_KEY.kid)).toEqual({ ok: false, reason: 'unavailable' })
  })
})
