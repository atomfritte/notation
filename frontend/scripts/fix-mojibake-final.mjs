// Explicit-replacement final pass for the few mojibake patterns the
// iterative repair script couldn't resolve — typically because they end
// on an incomplete UTF-8 sequence in cp1252 byte form. We just hand-map
// each remaining pattern to the character it was meant to be.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..', 'src')

const PAIRS = [
  // Triple-encoded em-dash chains (Editor.tsx etc.)
  [/ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â/g, '—'],
  [/ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¬/g, '—'],
  // Double-encoded em-dash
  [/ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â/g, '—'],
  // Double-encoded ellipsis
  [/ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦/g, '…'],
  // Double-encoded left double quote
  [/ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œ/g, '“'],
  // Double-encoded right double quote
  [/ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â/g, '”'],
  // Single-encoded em-dash
  [/Ã¢â‚¬â€/g, '—'],
  // Single-encoded en-dash
  [/Ã¢â‚¬â€œ/g, '–'],
  // Single-encoded ellipsis
  [/Ã¢â‚¬Â¦/g, '…'],
  // Single-encoded left/right double quotes
  [/Ã¢â‚¬Å"/g, '“'],
  [/Ã¢â‚¬œ/g, '“'],
  [/Ã¢â‚¬Â/g, '”'],
  // Single-encoded apostrophes
  [/Ã¢â‚¬â„¢/g, '’'],
  [/Ã¢â‚¬Ëœ/g, '‘'],
  // Single-encoded bullet
  [/Ã¢â‚¬Â¢/g, '•'],
  // Common single-encoded German umlauts (when paired with other mojibake)
  [/Ã¤/g, 'ä'],
  [/Ã¶/g, 'ö'],
  [/Ã¼/g, 'ü'],
  [/ÃŸ/g, 'ß'],
  [/Ã„/g, 'Ä'],
  [/Ã–/g, 'Ö'],
  [/Ãœ/g, 'Ü'],
]

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(p)
    else if (/\.(tsx?|css)$/i.test(entry.name)) yield p
  }
}

let changed = 0
for (const file of walk(ROOT)) {
  const orig = fs.readFileSync(file, 'utf8')
  let next = orig
  for (const [from, to] of PAIRS) {
    next = next.replace(from, to)
  }
  if (next !== orig) {
    fs.writeFileSync(file, next, 'utf8')
    changed++
  }
}
console.log(`changed: ${changed} files`)
