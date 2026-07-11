import { describe, expect, it } from 'vitest'
import { unzipSync } from 'fflate'
import { generateDEK, importContentKey } from '../../shared/crypto/keys'
import { InMemoryEncStore } from '../../shared/vfs/encStore'
import { EncryptedFS } from '../../shared/vfs/encfs'
import { buildDecryptedZip, listZipNodes } from './spaceZip'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)
const dec = (b: Uint8Array): string => new TextDecoder().decode(b)
const newFs = async (): Promise<EncryptedFS> =>
  EncryptedFS.open(new InMemoryEncStore(), await importContentKey(generateDEK()), 'A')

/** Byte-for-byte equality of two Uint8Arrays. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

describe('buildDecryptedZip', () => {
  it('packs every file under its logical path with byte-identical decrypted content', async () => {
    const fs = await newFs()

    // A nested folder structure + a text file + a binary file.
    await fs.write('readme.md', enc('# Top level\n\nhello'))
    await fs.write('docs/intro.md', enc('# Intro\n\nnested page'))
    await fs.write('docs/guides/setup.md', enc('# Setup\n\ndeep page'))
    // A binary file with the full byte range 0..255 (would corrupt under any
    // text round-trip) — proves the zip carries raw decrypted bytes.
    const binary = new Uint8Array(256)
    for (let i = 0; i < 256; i++) binary[i] = i
    await fs.write('assets/logo.bin', binary)

    const zipped = await buildDecryptedZip(fs)
    const out = unzipSync(zipped)

    // Every logical path is present.
    expect(Object.keys(out).sort()).toEqual(
      expect.arrayContaining([
        'readme.md',
        'docs/intro.md',
        'docs/guides/setup.md',
        'assets/logo.bin',
      ]),
    )

    // Text content is byte-identical to what was written.
    expect(dec(out['readme.md'])).toBe('# Top level\n\nhello')
    expect(dec(out['docs/intro.md'])).toBe('# Intro\n\nnested page')
    expect(dec(out['docs/guides/setup.md'])).toBe('# Setup\n\ndeep page')

    // Binary is intact, byte for byte.
    expect(out['assets/logo.bin'].length).toBe(256)
    expect(bytesEqual(out['assets/logo.bin'], binary)).toBe(true)
  })

  it('preserves the folder structure including an empty directory', async () => {
    const fs = await newFs()
    await fs.write('a/b/c.txt', enc('deep'))
    await fs.mkdir('empty/folder') // no files inside

    const out = unzipSync(await buildDecryptedZip(fs))

    // The file's nested path survived.
    expect(dec(out['a/b/c.txt'])).toBe('deep')
    // Empty directories are emitted as explicit `dir/` entries.
    const dirEntries = Object.keys(out).filter(k => k.endsWith('/'))
    expect(dirEntries).toEqual(expect.arrayContaining(['empty/', 'empty/folder/']))
  })

  it('excludes soft-deleted (trashed) files from the archive', async () => {
    const fs = await newFs()
    await fs.write('keep.md', enc('keep'))
    await fs.write('drop.md', enc('drop'))
    await fs.remove('drop.md')

    const paths = listZipNodes(fs).map(n => n.path)
    expect(paths).toContain('keep.md')
    expect(paths).not.toContain('drop.md')

    const out = unzipSync(await buildDecryptedZip(fs))
    expect(out['keep.md']).toBeDefined()
    expect(out['drop.md']).toBeUndefined()
  })
})
