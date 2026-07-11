import { describe, expect, it } from 'vitest'
import { generateDEK, importContentKey } from '../crypto/keys'
import { ROOT_ID } from './nodes'
import type { CreateOp, Op } from './ops'
import { buildTree } from './ops'
import { decodeOp, encodeOp, openOp, sealOp } from './opCrypto'

const mkCreate = (opId: string, nodeId: string, parentId: string, name: string, lamport: number): CreateOp => ({
  type: 'create', opId, nodeId, parentId, name, nodeType: 'dir', lamport, actorId: 'device-1',
})

describe('op serialization', () => {
  it('round-trips an op through encode/decode', () => {
    const op: Op = mkCreate('op1', 'n1', ROOT_ID, 'docs', 1)
    expect(decodeOp(encodeOp(op))).toEqual(op)
  })
})

describe('encrypted op envelope', () => {
  it('seals and opens an op, exposing only ordering metadata in the clear', async () => {
    const key = await importContentKey(generateDEK())
    const op: Op = mkCreate('op1', 'n1', ROOT_ID, 'secret-name', 7)

    const env = await sealOp(op, key)
    expect(env).toMatchObject({ opId: 'op1', lamport: 7, actorId: 'device-1' })
    // The name must not leak into the cleartext envelope bytes.
    expect(new TextDecoder().decode(env.ciphertext)).not.toContain('secret-name')

    expect(await openOp(env, key)).toEqual(op)
  })

  it('fails to open a tampered ciphertext', async () => {
    const key = await importContentKey(generateDEK())
    const env = await sealOp(mkCreate('op1', 'n1', ROOT_ID, 'x', 1), key)
    env.ciphertext[env.ciphertext.length - 1] ^= 0x01
    await expect(openOp(env, key)).rejects.toThrow()
  })

  it('fails to open when cleartext metadata is swapped (bound as AAD)', async () => {
    const key = await importContentKey(generateDEK())
    const env = await sealOp(mkCreate('op1', 'n1', ROOT_ID, 'x', 1), key)
    await expect(openOp({ ...env, lamport: 999 }, key)).rejects.toThrow()
  })

  it('fails to open with the wrong key', async () => {
    const env = await sealOp(mkCreate('op1', 'n1', ROOT_ID, 'x', 1), await importContentKey(generateDEK()))
    await expect(openOp(env, await importContentKey(generateDEK()))).rejects.toThrow()
  })

  it('integrates: seal a log, open it, replay into the expected tree', async () => {
    const key = await importContentKey(generateDEK())
    const log: Op[] = [
      mkCreate('op1', 'd1', ROOT_ID, 'root-dir', 1),
      mkCreate('op2', 'd2', 'd1', 'child-dir', 2),
    ]
    const sealed = await Promise.all(log.map((op) => sealOp(op, key)))
    const opened = await Promise.all(sealed.map((env) => openOp(env, key)))

    const nodes = new Map(buildTree(opened).map((n) => [n.nodeId, n]))
    expect(nodes.get('d1')?.name).toBe('root-dir')
    expect(nodes.get('d2')?.parentId).toBe('d1')
  })
})
