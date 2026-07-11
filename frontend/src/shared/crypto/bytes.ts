/** Small byte-buffer helpers shared across the crypto core. */

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** UTF-8 encode a string to bytes. */
export function utf8Encode(text: string): Uint8Array {
  return encoder.encode(text)
}

/** UTF-8 decode bytes to a string. */
export function utf8Decode(bytes: Uint8Array): string {
  return decoder.decode(bytes)
}

/** Cryptographically-strong random bytes via WebCrypto. */
export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length)
  crypto.getRandomValues(out)
  return out
}

/** Concatenate byte arrays into a single fresh buffer. */
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const part of parts) total += part.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** Lowercase-hex encode. */
export function toHex(bytes: Uint8Array): string {
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex
}

/** Decode lowercase/uppercase hex into bytes. Throws on malformed input. */
export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('bytes: hex length must be even')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(byte)) throw new Error('bytes: invalid hex digit')
    out[i] = byte
  }
  return out
}

/** Constant-time byte equality (length leak only). */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}
