import { createPublicKey, generateKeyPairSync, sign } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { publicKeyFromX, readSignatureHeaders, verifySignature } from '../src/lib/signature'
// @ts-expect-error — a plain .mjs test helper without types
import { signatureHeaders, TEST_KEY, TEST_STRAY_KEY } from '../scripts/test-signing-key.mjs'

const raw = '{"version":1,"run":{"id":"run_1"}}'
const body = new TextEncoder().encode(raw)
const publicKey = publicKeyFromX(TEST_KEY.jwk.x)!

/** The parsed headers Scallle would send with this body (TEST key unless said otherwise). */
function signed(text = raw, key = TEST_KEY) {
  const h = signatureHeaders(text, key) as Record<string, string>
  return readSignatureHeaders(h['X-Scallle-Key-Id'], h['X-Scallle-Signature'])!
}

describe('verifySignature (Ed25519)', () => {
  it('accepts Scallle’s signature of exactly these bytes', () => {
    const s = signed()
    expect(s.kid).toBe(TEST_KEY.kid)
    expect(verifySignature(body, s.signature, publicKey)).toBe(true)
  })

  it('refuses a body changed by one byte', () => {
    const changed = new TextEncoder().encode(raw.replace('run_1', 'run_2'))
    expect(verifySignature(changed, signed().signature, publicKey)).toBe(false)
  })

  it('refuses a signature made with another key', () => {
    expect(verifySignature(body, signed(raw, TEST_STRAY_KEY).signature, publicKey)).toBe(false)
  })

  it('refuses a signature of the wrong length, and a key that is not Ed25519', () => {
    expect(verifySignature(body, signed().signature.subarray(0, 63), publicKey)).toBe(false)
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const rsaSig = sign('sha256', body, rsa.privateKey)
    expect(verifySignature(body, rsaSig.subarray(0, 64), rsa.publicKey)).toBe(false)
  })
})

describe('readSignatureHeaders', () => {
  const good = signatureHeaders(raw, TEST_KEY) as Record<string, string>
  const kid = good['X-Scallle-Key-Id']
  const sig = good['X-Scallle-Signature']

  it('reads a well-formed pair', () => {
    expect(readSignatureHeaders(kid, sig)?.signature).toHaveLength(64)
  })

  it.each([
    ['no key id', null, sig],
    ['an empty key id', '', sig],
    ['a key id with other characters', 'kid with spaces', sig],
    ['a key id over 128 characters', 'k'.repeat(129), sig],
    ['no signature', kid, null],
    ['an empty signature', kid, ''],
    ['a signature without the ed25519= prefix', kid, sig.slice('ed25519='.length)],
    ['another algorithm', kid, sig.replace('ed25519=', 'sha256=')],
    ['an HMAC-style hex signature', kid, `sha256=${'a'.repeat(64)}`],
    ['a signature one character short', kid, sig.slice(0, -1)],
    ['a signature one character long', kid, `${sig}A`],
    ['a padded signature', kid, `${sig.slice(0, -2)}==`],
    ['standard base64 instead of base64url', kid, `ed25519=${'+'.repeat(86)}`],
    ['surrounding spaces', kid, ` ${sig} `],
  ])('refuses %s', (_name, k, s) => {
    expect(readSignatureHeaders(k, s)).toBeNull()
  })

  it('refuses a non-canonical spelling of the same 64 bytes (stray bits in the last character)', () => {
    // The last of 86 characters carries 2 bits; the other 4 must be zero, so
    // the next letter of the alphabet decodes to the same bytes.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    const tweaked = `${sig.slice(0, -1)}${alphabet[alphabet.indexOf(sig.slice(-1)) + 1]}`
    expect(Buffer.from(tweaked.slice(8), 'base64url')).toEqual(Buffer.from(sig.slice(8), 'base64url'))
    expect(readSignatureHeaders(kid, tweaked)).toBeNull()
  })
})

describe('publicKeyFromX', () => {
  it('builds the key from a published x', () => {
    const key = publicKeyFromX(TEST_KEY.jwk.x)
    expect(key?.asymmetricKeyType).toBe('ed25519')
    expect(key?.export({ format: 'jwk' })).toEqual(createPublicKey(TEST_KEY.privateKey).export({ format: 'jwk' }))
  })

  it.each([
    ['not a string', 42],
    ['too short', 'abc'],
    ['not base64url', '!'.repeat(43)],
    ['33 bytes', Buffer.alloc(33, 1).toString('base64url')],
  ])('refuses an x that is %s', (_name, x) => {
    expect(publicKeyFromX(x)).toBeNull()
  })
})
