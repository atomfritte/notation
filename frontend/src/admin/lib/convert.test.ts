import { describe, expect, it } from 'vitest'
import { InMemoryEncStore } from '../../shared/vfs/encStore'
import { unlockWithRecovery } from '../../shared/crypto/space'
import { encryptSpaceContent, decryptSpaceContent, type PlaintextSink, type PlaintextSource } from './convert'

// A single in-memory bag that plays both the source (encrypt reads it) and the
// sink (decrypt writes it), so a round-trip is a direct map comparison.
class FakeFiles implements PlaintextSource, PlaintextSink {
  files = new Map<string, Uint8Array>()
  set(path: string, data: Uint8Array): void { this.files.set(path, data.slice()) }
  async listFiles(): Promise<string[]> { return [...this.files.keys()] }
  async readBytes(path: string): Promise<Uint8Array> {
    const b = this.files.get(path)
    if (!b) throw new Error(`not found: ${path}`)
    return b.slice()
  }
  async writeBytes(path: string, data: Uint8Array): Promise<void> { this.files.set(path, data.slice()) }
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
const MARKER = 'PLAINTEXT_MARKER_XYZ'

function sampleSource(): FakeFiles {
  const src = new FakeFiles()
  src.set('readme.md', enc(`# Readme\n${MARKER} top level\n`))
  src.set('notes/deep/inner.md', enc(`nested ${MARKER} content\n`))
  src.set('a/b/c/leaf.txt', enc('deeply nested leaf'))
  // A binary-ish file with NUL + high bytes — proves raw-byte (lossless) copy.
  src.set('assets/blob.bin', new Uint8Array([0x00, 0x01, 0xff, 0xfe, 0x42, 0x00, 0x99, 0x7f]))
  return src
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function containsBytes(hay: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return true
  }
  return false
}

describe('convert orchestration', () => {
  it('encrypts then decrypts to a byte-identical file set (lossless round-trip)', async () => {
    const src = sampleSource()
    const store = new InMemoryEncStore()

    const res = await encryptSpaceContent(src, store, 'correct horse battery', { actorId: 'A' })

    // Every file became exactly one content blob; the op-log + key record exist.
    expect(store.blobCount()).toBe(src.files.size)
    expect(store.opCount()).toBeGreaterThan(0)
    expect(await store.getKeyRecord()).not.toBeNull()
    expect(res.fileCount).toBe(src.files.size)

    // Zero-knowledge: no plaintext byte-run reaches the store.
    for (const stored of store.allStoredBytes()) {
      expect(containsBytes(stored, enc(MARKER))).toBe(false)
    }

    // Decrypt into a fresh bag with the SAME session handle.
    const out = new FakeFiles()
    const restored = await decryptSpaceContent(store, res.handle, out, { actorId: 'B' })
    expect(restored.sort()).toEqual([...src.files.keys()].sort())

    // Byte-for-byte identical, including the binary file.
    expect([...out.files.keys()].sort()).toEqual([...src.files.keys()].sort())
    for (const [path, original] of src.files) {
      expect(bytesEqual(out.files.get(path)!, original)).toBe(true)
    }
  })

  it('recovery key from the encrypt run can unlock and decrypt the same content', async () => {
    const src = sampleSource()
    const store = new InMemoryEncStore()
    const res = await encryptSpaceContent(src, store, 'pw-123456', { actorId: 'A' })

    const record = await store.getKeyRecord()
    expect(record).not.toBeNull()
    const recovered = await unlockWithRecovery(record!, res.recoveryDisplay)

    const out = new FakeFiles()
    await decryptSpaceContent(store, recovered, out, { actorId: 'B' })
    for (const [path, original] of src.files) {
      expect(bytesEqual(out.files.get(path)!, original)).toBe(true)
    }
  })

  it('does not mutate the source (encrypt is non-destructive → abort is clean)', async () => {
    const src = sampleSource()
    const before = new Map(src.files) // snapshot
    const store = new InMemoryEncStore()
    await encryptSpaceContent(src, store, 'pw-123456', { actorId: 'A' })

    // The source bag is untouched — if the caller aborts, nothing was lost.
    expect([...src.files.keys()].sort()).toEqual([...before.keys()].sort())
    for (const [path, original] of before) {
      expect(bytesEqual(src.files.get(path)!, original)).toBe(true)
    }
  })

  it('round-trips an empty space (no files) without error', async () => {
    const src = new FakeFiles()
    const store = new InMemoryEncStore()
    const res = await encryptSpaceContent(src, store, 'pw-123456', { actorId: 'A' })
    expect(res.fileCount).toBe(0)
    const out = new FakeFiles()
    const restored = await decryptSpaceContent(store, res.handle, out, { actorId: 'B' })
    expect(restored).toEqual([])
    expect(out.files.size).toBe(0)
  })
})
