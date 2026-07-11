/**
 * Resolve a byte-parsing viewer's data source to an ArrayBuffer. Prefers
 * already-decrypted `bytes` (an encrypted space, sourced from the client
 * EncryptedFS) and otherwise fetches the plaintext server `url`. Keeping this in
 * one place lets WordView / SpreadsheetView stay agnostic about encryption —
 * they parse an ArrayBuffer either way.
 */
export async function sourceArrayBuffer(
  url: string | undefined,
  bytes: Uint8Array | undefined,
): Promise<ArrayBuffer> {
  if (bytes) {
    // Copy into a fresh, exactly-sized ArrayBuffer — the Uint8Array may be a
    // subarray view over a larger backing buffer.
    const ab = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(ab).set(bytes)
    return ab
  }
  if (!url) throw new Error('no data source')
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.arrayBuffer()
}
