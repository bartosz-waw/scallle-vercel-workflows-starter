import { createPublicKey, verify, type KeyObject } from 'node:crypto'

/**
 * How a job proves it came from Scallle (contract §2, Vercel Workflows projects).
 *
 *   X-Scallle-Key-Id:    <kid>  — which of Scallle's published keys signed it
 *   X-Scallle-Signature: ed25519=<base64url, no padding, of the 64-byte Ed25519 signature>
 *
 * The signature covers the exact raw body bytes as they arrived — parsing and
 * re-serialising the JSON would change them — and nothing else (issued_at,
 * the business, the run, the address and the callback are all inside the
 * body). There is no secret to keep: Scallle signs with its own private key
 * and publishes the public half (scallle-keys.ts). Ed25519 only — no other
 * algorithm is accepted, and there is no fallback.
 */

export const KEY_ID_HEADER = 'x-scallle-key-id'
export const SIGNATURE_HEADER = 'x-scallle-signature'

const KEY_ID_FORMAT = /^[A-Za-z0-9_-]{1,128}$/
/** 64 bytes in base64url without padding is exactly 86 characters. */
const SIGNATURE_FORMAT = /^ed25519=([A-Za-z0-9_-]{86})$/

export type SignedHeaders = { kid: string; signature: Buffer }

/**
 * The key id and signature, when both headers are there and well formed;
 * otherwise null. Checked before any key is looked up, so unsigned noise
 * never makes this project fetch anything.
 */
export function readSignatureHeaders(kid: string | null, signature: string | null): SignedHeaders | null {
  if (!kid || !signature || !KEY_ID_FORMAT.test(kid)) return null
  const match = SIGNATURE_FORMAT.exec(signature)
  if (!match) return null
  const bytes = Buffer.from(match[1], 'base64url')
  // Only the one canonical spelling of 64 bytes is accepted.
  if (bytes.length !== 64 || bytes.toString('base64url') !== match[1]) return null
  return { kid, signature: bytes }
}

/** An Ed25519 public key from a published JWK's `x` (base64url of 32 bytes); null if it isn't one. */
export function publicKeyFromX(x: unknown): KeyObject | null {
  if (typeof x !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(x)) return null
  const bytes = Buffer.from(x, 'base64url')
  if (bytes.length !== 32 || bytes.toString('base64url') !== x) return null
  try {
    return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' })
  } catch {
    return null
  }
}

/** True only when `signature` is this key's Ed25519 signature of exactly these bytes. */
export function verifySignature(rawBody: Uint8Array, signature: Uint8Array, publicKey: KeyObject): boolean {
  if (publicKey.asymmetricKeyType !== 'ed25519' || signature.length !== 64) return false
  try {
    // Ed25519 takes no digest: the algorithm argument must be null.
    return verify(null, rawBody, publicKey, signature)
  } catch {
    return false
  }
}
