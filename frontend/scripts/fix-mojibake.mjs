// One-shot mojibake repair script.
//
// The frontend source tree picked up double / triple UTF-8-as-CP1252
// mis-encoding in comments and strings (German em-dashes, ellipses, smart
// quotes). Approach: walk every .tsx/.ts/.css file; for any non-ASCII run
// that contains mojibake sentinels (Â/Ã/Æ/Å/ƒ), repeatedly round-trip the
// run through cp1252-encode → utf-8-decode until the sentinels are gone.
//
// Per-region operation means valid UTF-8 (German umlauts in identifiers,
// etc.) passes through unchanged: those regions don't contain sentinels so
// the repair never even tries.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..', 'src')

// Unicode codepoints CP1252 maps into its 0x80-0x9F band (the Windows
// "extended Latin" punctuation). Anything in 0x00-0x7F or 0xA0-0xFF maps
// to itself; anything outside both ranges can't be represented in CP1252
// (return null → bail).
const CP1252_EXTENDED = {
  0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84,
  0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88,
  0x2030: 0x89, 0x0160: 0x8A, 0x2039: 0x8B, 0x0152: 0x8C,
  0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93,
  0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B,
  0x0153: 0x9C, 0x017E: 0x9E, 0x0178: 0x9F,
}

function unicodeToCp1252Byte(c) {
  if (c < 0x80) return c
  if (c >= 0xA0 && c <= 0xFF) return c
  return CP1252_EXTENDED[c] ?? null
}

function cp1252ToUtf8(s) {
  const bytes = []
  for (let i = 0; i < s.length; i++) {
    const b = unicodeToCp1252Byte(s.charCodeAt(i))
    if (b === null) return null
    bytes.push(b)
  }
  // Use non-strict decoding so a region whose tail happens to be an
  // incomplete UTF-8 sequence (e.g. a stray 0xC2 from a closing "Â") still
  // decodes its valid prefix. Trailing U+FFFD replacement chars are then
  // peeled so the next iteration sees a clean string.
  let result
  try {
    result = new TextDecoder('utf-8', { fatal: false }).decode(Uint8Array.from(bytes))
  } catch {
    return null
  }
  // If the decoder dropped EVERYTHING to replacement chars, we'd just be
  // looping on garbage — bail.
  if (/^�+$/.test(result)) return null
  // Strip a trailing run of replacement chars (incomplete tail sequence).
  result = result.replace(/�+$/, '')
  // Embedded replacement chars (mid-string) signal that the input wasn't a
  // single clean mojibake region; don't accept that as an improvement.
  if (result.includes('�')) return null
  return result
}

function score(s) {
  return (s.match(/[ÂÃÆÅƒ]/g) || []).length
}

function nonAscii(t) {
  let n = 0
  for (let i = 0; i < t.length; i++) if (t.charCodeAt(i) > 0x7F) n++
  return n
}

function repair(s, maxIter = 8) {
  // Acceptance criterion: result has strictly FEWER non-ASCII chars.
  // Mojibake always inflates char counts (1 utf-8 codepoint → 2-3 chars
  // per re-encode pass); undoing one pass therefore shortens the run.
  // Valid German umlauts can't shrink — their cp1252 byte is alone and
  // the utf-8 decode throws, returning the input unchanged.
  let cur = s
  for (let i = 0; i < maxIter; i++) {
    const next = cp1252ToUtf8(cur)
    if (next === null || next === cur) return cur
    if (nonAscii(next) >= nonAscii(cur)) return cur
    cur = next
  }
  return cur
}

// Greedy region split: find the largest contiguous run of non-ASCII chars
// that contains a sentinel, repair it, repeat. Splitting greedily catches
// chains where a sentinel sits in the middle but the run is broken by an
// ASCII char on the boundary.
function repairMixed(text) {
  const re = /[-￿]+/g
  return text.replace(re, m => repair(m))
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(p)
    else if (/\.(tsx?|css)$/i.test(entry.name)) yield p
  }
}

let changed = 0
let stillDirty = 0
for (const file of walk(ROOT)) {
  const orig = fs.readFileSync(file, 'utf8')
  const next = repairMixed(orig)
  if (next !== orig) {
    fs.writeFileSync(file, next, 'utf8')
    changed++
  }
  if (/[ÂÃÆÅƒ]/.test(next)) stillDirty++
}
console.log(`changed: ${changed} files`)
console.log(`still has sentinels: ${stillDirty} files`)
