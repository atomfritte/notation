/**
 * Crockford base32 — a human-friendly alphabet that omits the ambiguous
 * letters I, L, O and U, so a recovery key read off paper is hard to mistype.
 * Decoding is tolerant: case-insensitive, ignores separators (dashes/spaces),
 * and folds the look-alike characters (O→0, I/L→1) back to their digits.
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

const DECODE = new Map<string, number>()
for (let i = 0; i < ALPHABET.length; i++) DECODE.set(ALPHABET[i], i)
// Fold visually-ambiguous characters onto their canonical value.
DECODE.set('O', 0)
DECODE.set('I', 1)
DECODE.set('L', 1)

/** Encode bytes as Crockford base32 (no separators). */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) {
    // Zero-pad the final partial symbol on the low bits.
    out += ALPHABET[(value << (5 - bits)) & 31]
  }
  return out
}

/**
 * Decode Crockford base32 back to bytes. Separators and case are ignored;
 * trailing padding bits (< 8) are dropped. Throws on any character that is not
 * a valid base32 symbol or separator.
 */
export function base32Decode(text: string): Uint8Array {
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const raw of text) {
    if (raw === '-' || raw === ' ' || raw === '\t' || raw === '\n') continue
    const symbol = DECODE.get(raw.toUpperCase())
    if (symbol === undefined) {
      throw new Error(`base32: invalid character ${JSON.stringify(raw)}`)
    }
    value = (value << 5) | symbol
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return new Uint8Array(out)
}
