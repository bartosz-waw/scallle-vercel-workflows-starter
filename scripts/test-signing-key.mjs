/**
 * TEST ONLY — never used anywhere real.
 *
 * Fixed Ed25519 keys for local testing, so the mock Scallle (which publishes
 * the public half) and the test-job sender (which signs with the private
 * half) agree without talking to each other. They are in this public file on
 * purpose: they prove nothing. A deployed project only ever trusts keys it
 * fetches from its own SCALLLE_APP_URL, never these.
 *
 *   TEST_KEY          the key the mock publishes and signs with
 *   TEST_ROTATED_KEY  a second key, for trying a rotation
 *   TEST_STRAY_KEY    never published — what a test copy of Scallle would sign with
 */
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'

/** PKCS#8 DER header of an Ed25519 private key; the 32-byte seed follows it. */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

/** RFC 7638 thumbprint of an Ed25519 public JWK. */
export function jwkThumbprint(x) {
  return createHash('sha256').update(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`, 'utf8').digest('base64url')
}

/** An Ed25519 key from a 32-byte seed: { privateKey, jwk (public, with kid), kid }. */
export function keyFromSeed(seedHex) {
  const seed = Buffer.from(seedHex, 'hex')
  if (seed.length !== 32) throw new Error('A test seed is 32 bytes.')
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' })
  const { x } = createPublicKey(privateKey).export({ format: 'jwk' })
  const kid = jwkThumbprint(x)
  return { privateKey, kid, jwk: { kty: 'OKP', crv: 'Ed25519', x, kid, alg: 'EdDSA', use: 'sig' } }
}

// TEST ONLY seeds — made up for this file.
export const TEST_KEY = keyFromSeed('5ca11e00000000000000000000000000000000000000000000000000000000a1')
export const TEST_ROTATED_KEY = keyFromSeed('5ca11e00000000000000000000000000000000000000000000000000000000b2')
export const TEST_STRAY_KEY = keyFromSeed('5ca11e00000000000000000000000000000000000000000000000000000000c3')

/** The two headers Scallle sends with a job: the key id and the Ed25519 signature of the raw body. */
export function signatureHeaders(raw, key = TEST_KEY, kid = key.kid) {
  const signature = sign(null, Buffer.from(raw, 'utf8'), key.privateKey).toString('base64url')
  return { 'X-Scallle-Key-Id': kid, 'X-Scallle-Signature': `ed25519=${signature}` }
}
