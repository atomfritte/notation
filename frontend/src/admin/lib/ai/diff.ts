/**
 * A small line diff for the assistant's change cards: shows what a write or an
 * edit does to a page before (or after) it is applied.
 *
 * Myers' O((N+M)·D) algorithm over lines, after trimming the common prefix and
 * suffix — an assistant edit usually touches a few lines of a long page, so the
 * middle is small. A pathological rewrite (D beyond {@link MAX_D}) degrades to
 * "the whole middle was replaced", which is still a correct diff.
 */

export type DiffLine = { op: ' ' | '-' | '+'; text: string }

export interface DiffResult {
  /** Unified-style text: `@@` hunk headers, then ' ', '-', '+' lines. */
  text: string
  added: number
  removed: number
  /** True when the rendered text was cut to stay small. */
  truncated: boolean
}

const MAX_D = 4000
const CONTEXT = 3
const MAX_LINES = 400
const MAX_CHARS = 40_000

function splitLines(s: string): string[] {
  if (s === '') return []
  const lines = s.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

function myers(a: string[], b: string[]): DiffLine[] {
  const n = a.length
  const m = b.length
  const max = n + m
  if (max === 0) return []
  const offset = max
  const v = new Int32Array(2 * max + 2)
  const trace: Int32Array[] = []
  let found = false
  for (let d = 0; d <= Math.min(max, MAX_D); d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1]
      else x = v[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) { x++; y++ }
      v[offset + k] = x
      if (x >= n && y >= m) { found = true; break }
    }
    if (found) break
  }
  if (!found) {
    return [...a.map(text => ({ op: '-' as const, text })), ...b.map(text => ({ op: '+' as const, text }))]
  }
  // Backtrack through the saved V arrays.
  const out: DiffLine[] = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d]
    const k = x - y
    let prevK: number
    if (k === -d || (k !== d && vd[offset + k - 1] < vd[offset + k + 1])) prevK = k + 1
    else prevK = k - 1
    const prevX = vd[offset + prevK]
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) { out.push({ op: ' ', text: a[x - 1] }); x--; y-- }
    if (d > 0) {
      if (x === prevX) out.push({ op: '+', text: b[y - 1] })
      else out.push({ op: '-', text: a[x - 1] })
    }
    x = prevX
    y = prevY
  }
  return out.reverse()
}

/** Full line diff of two texts (common prefix/suffix kept as context lines). */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before)
  const b = splitLines(after)
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const mid = myers(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf))
  return [
    ...a.slice(0, pre).map(text => ({ op: ' ' as const, text })),
    ...mid,
    ...a.slice(a.length - suf).map(text => ({ op: ' ' as const, text })),
  ]
}

/** Unified diff with {@link CONTEXT} lines around each change, size-capped. */
export function unifiedDiff(before: string, after: string): DiffResult {
  const lines = diffLines(before, after)
  let added = 0
  let removed = 0
  for (const l of lines) {
    if (l.op === '+') added++
    else if (l.op === '-') removed++
  }
  // Mark which lines fall within CONTEXT of a change.
  const keep = new Uint8Array(lines.length)
  lines.forEach((l, i) => {
    if (l.op === ' ') return
    for (let j = Math.max(0, i - CONTEXT); j <= Math.min(lines.length - 1, i + CONTEXT); j++) keep[j] = 1
  })
  const out: string[] = []
  let aLine = 1
  let bLine = 1
  let truncated = false
  let chars = 0
  let i = 0
  while (i < lines.length) {
    if (!keep[i]) {
      if (lines[i].op !== '+') aLine++
      if (lines[i].op !== '-') bLine++
      i++
      continue
    }
    // A hunk: a maximal run of kept lines.
    let j = i
    let aCount = 0
    let bCount = 0
    while (j < lines.length && keep[j]) {
      if (lines[j].op !== '+') aCount++
      if (lines[j].op !== '-') bCount++
      j++
    }
    out.push(`@@ -${aLine},${aCount} +${bLine},${bCount} @@`)
    for (let k = i; k < j; k++) {
      const line = `${lines[k].op}${lines[k].text}`
      if (out.length >= MAX_LINES || chars + line.length > MAX_CHARS) { truncated = true; break }
      out.push(line)
      chars += line.length + 1
    }
    if (truncated) break
    aLine += aCount
    bLine += bCount
    i = j
  }
  return { text: out.join('\n'), added, removed, truncated }
}
