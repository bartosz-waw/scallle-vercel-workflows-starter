import { createHash, type KeyObject } from 'node:crypto'

import { publicKeyFromX } from './signature'

/**
 * Scallle's public job keys, fetched from Scallle itself (contract §2).
 *
 *   GET <origin of SCALLLE_APP_URL>/.well-known/scallle-job-keys
 *   → { "keys": [{ "kty": "OKP", "crv": "Ed25519", "x": "…", "kid": "…", "alg": "EdDSA", "use": "sig" }, …] }
 *
 * Only ever from SCALLLE_APP_URL's origin — never from an address in the job
 * or a header — so a deployed project trusts exactly the Scallle it was set
 * up for. Each key's kid is recomputed (the RFC 7638 thumbprint of its
 * crv, kty and x) and an entry whose kid doesn't match, or that isn't an
 * Ed25519 key, is ignored.
 *
 * Kept in memory, per origin:
 *   - a fetched document is fresh for 5 minutes;
 *   - a kid it doesn't hold forces one refetch — at most every 30 s after a
 *     fetch that worked (every request can carry a made-up kid, and this
 *     project must not become a way to hammer Scallle), or after about 1 s
 *     when the last fetch failed (so Scallle's quick resends get a real try);
 *   - when Scallle can't be reached, the last document stays usable for up
 *     to an hour after it was fetched.
 * Nothing is fetched at import or build time — only when a signed job arrives.
 *
 * Anything but a 200 with a JSON document of at most 16 KB counts as "can't
 * fetch" (the receiver answers 503 and Scallle sends the job again) — never
 * as a reason to refuse the job for good.
 */

export const KEYS_PATH = '/.well-known/scallle-job-keys'

export const FRESH_MS = 5 * 60_000
export const STALE_MS = 60 * 60_000
export const REFETCH_AFTER_SUCCESS_MS = 30_000
export const REFETCH_AFTER_FAILURE_MS = 1_000
export const FETCH_TIMEOUT_MS = 3_000
export const MAX_DOCUMENT_BYTES = 16 * 1024
export const MAX_KEYS = 10

export type KeyLookup =
  | { ok: true; key: KeyObject }
  /** unknown: Scallle's current document doesn't publish this kid.
   *  unavailable: the document couldn't be fetched, so nothing can be said. */
  | { ok: false; reason: 'unknown' | 'unavailable' }

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

type OriginState = {
  keys: Map<string, KeyObject>
  /** When the document now held was fetched; null before the first success. */
  fetchedAt: number | null
  lastAttemptAt: number | null
  lastAttemptOk: boolean
  inflight: Promise<void> | null
}

/** RFC 7638 thumbprint of an Ed25519 public JWK: base64url(SHA-256 of its required members, in order). */
export function jwkThumbprint(x: string): string {
  return createHash('sha256').update(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`, 'utf8').digest('base64url')
}

/** The keys a document publishes, by kid. Null when it isn't a key document at all. */
export function parseKeyDocument(doc: unknown): Map<string, KeyObject> | null {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null
  const entries = (doc as { keys?: unknown }).keys
  if (!Array.isArray(entries)) return null
  const keys = new Map<string, KeyObject>()
  for (const entry of entries.slice(0, MAX_KEYS)) {
    if (!entry || typeof entry !== 'object') continue
    const { kty, crv, x, kid } = entry as Record<string, unknown>
    if (kty !== 'OKP' || crv !== 'Ed25519' || typeof x !== 'string' || typeof kid !== 'string') continue
    if (kid !== jwkThumbprint(x)) continue
    const key = publicKeyFromX(x)
    if (key) keys.set(kid, key)
  }
  return keys
}

/** The response body as text, refusing anything over the limit without reading it all. */
async function readCapped(res: Response): Promise<string | null> {
  if (Number(res.headers.get('content-length') ?? 0) > MAX_DOCUMENT_BYTES) return null
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_DOCUMENT_BYTES) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function createKeyStore({
  fetch: fetchImpl = (url, init) => fetch(url, init),
  now = () => Date.now(),
}: { fetch?: FetchLike; now?: () => number } = {}) {
  const origins = new Map<string, OriginState>()

  function stateFor(origin: string): OriginState {
    let state = origins.get(origin)
    if (!state) {
      state = { keys: new Map(), fetchedAt: null, lastAttemptAt: null, lastAttemptOk: false, inflight: null }
      origins.set(origin, state)
    }
    return state
  }

  async function fetchDocument(origin: string): Promise<Map<string, KeyObject> | null> {
    try {
      const res = await fetchImpl(`${origin}${KEYS_PATH}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => {})
        return null
      }
      const text = await readCapped(res)
      if (text === null) return null
      return parseKeyDocument(JSON.parse(text))
    } catch {
      return null
    }
  }

  /** One fetch at a time per origin; callers arriving meanwhile share it. */
  function refresh(origin: string, state: OriginState): Promise<void> {
    state.inflight ??= (async () => {
      state.lastAttemptAt = now()
      const keys = await fetchDocument(origin)
      state.lastAttemptOk = keys !== null
      if (keys) {
        state.keys = keys
        state.fetchedAt = now()
      } else {
        console.warn(`Couldn't fetch Scallle's public keys from ${origin}.`)
      }
    })().finally(() => {
      state.inflight = null
    })
    return state.inflight
  }

  function mayFetch(state: OriginState): boolean {
    if (state.lastAttemptAt === null) return true
    const wait = state.lastAttemptOk ? REFETCH_AFTER_SUCCESS_MS : REFETCH_AFTER_FAILURE_MS
    return now() - state.lastAttemptAt >= wait
  }

  /** The public key for `kid`, from `origin`'s key document. */
  async function keyFor(origin: string, kid: string): Promise<KeyLookup> {
    const state = stateFor(origin)
    if (state.inflight) await state.inflight

    const fresh = state.fetchedAt !== null && now() - state.fetchedAt < FRESH_MS
    const cached = state.keys.get(kid)
    if (fresh && cached) return { ok: true, key: cached }

    if (mayFetch(state)) await refresh(origin, state)
    else if (state.inflight) await state.inflight

    const usable = state.fetchedAt !== null && now() - state.fetchedAt < STALE_MS
    const key = usable ? state.keys.get(kid) : undefined
    if (key) return { ok: true, key }
    // Only a document fetched just now (or within the throttle after a fetch
    // that worked) can say a kid isn't Scallle's.
    if (state.lastAttemptOk && state.fetchedAt !== null && now() - state.fetchedAt < FRESH_MS) {
      return { ok: false, reason: 'unknown' }
    }
    return { ok: false, reason: 'unavailable' }
  }

  return {
    keyFor,
    /** Forget every fetched document (tests and local tools). */
    forget: () => origins.clear(),
  }
}

const defaultStore = createKeyStore()

/** The public key for `kid`, from Scallle at `origin` (this process's shared cache). */
export function scallleKeyFor(origin: string, kid: string): Promise<KeyLookup> {
  return defaultStore.keyFor(origin, kid)
}

/** Forget every fetched key document. For tests and local tools. */
export function forgetScallleKeys(): void {
  defaultStore.forget()
}
