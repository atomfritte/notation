import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadDecryptedFile, makeDecryptedObjectURL } from './decryptedFile'
import type { EncryptedFS } from '../../shared/vfs/encfs'

// jsdom does not implement the object-URL APIs, so we install stubs and assert
// the create/revoke lifecycle against them.
let created: Blob[]
beforeEach(() => {
  created = []
  URL.createObjectURL = vi.fn((blob: Blob) => {
    created.push(blob)
    return `blob:mock/${created.length}`
  }) as unknown as typeof URL.createObjectURL
  URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('makeDecryptedObjectURL', () => {
  it('builds a blob URL tagged with the path MIME and revokes it exactly once', () => {
    const { url, revoke } = makeDecryptedObjectURL(new Uint8Array([1, 2, 3]), 'a/b/pic.png')

    expect(url).toBe('blob:mock/1')
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
    expect(created[0]).toBeInstanceOf(Blob)
    expect(created[0].type).toBe('image/png')
    expect(created[0].size).toBe(3)

    // Idempotent revoke — a second call is a no-op.
    revoke()
    revoke()
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock/1')
  })

  it('defaults an unknown extension to a generic binary blob', () => {
    makeDecryptedObjectURL(new Uint8Array([0]), 'mystery.bin')
    expect(created[0].type).toBe('application/octet-stream')
  })
})

describe('downloadDecryptedFile', () => {
  it('decrypts via the FS and triggers a named download, revoking on a timer', async () => {
    vi.useFakeTimers()
    const bytes = new Uint8Array([9, 8, 7])
    const fs = { read: vi.fn(async () => bytes) } as unknown as EncryptedFS

    let anchor: HTMLAnchorElement | null = null
    const realCreate = document.createElement.bind(document)
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreate(tag as 'a')
      if (tag === 'a') anchor = el as HTMLAnchorElement
      return el
    })
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {})

    await downloadDecryptedFile(fs, 'reports/q3 summary.pdf')

    expect(fs.read).toHaveBeenCalledWith('reports/q3 summary.pdf')
    expect(created[0].type).toBe('application/pdf')
    expect(clickSpy).toHaveBeenCalledTimes(1)
    expect(anchor).not.toBeNull()
    expect(anchor!.download).toBe('q3 summary.pdf')
    expect(anchor!.getAttribute('href')).toBe('blob:mock/1')

    // The URL stays alive until the deferred revoke fires.
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    vi.advanceTimersByTime(60_000)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock/1')

    vi.useRealTimers()
  })
})
