/**
 * Virtual filesystem layer (Phase 1): the logical node model, the op-log types
 * and single-writer replay, the encrypted-op envelope, and the SpaceFS
 * interface both backends will implement later.
 */
export * from './ids'
export * from './nodes'
export * from './ops'
export * from './crdt'
export * from './opCrypto'
export type { SpaceFS } from './spacefs'
// Phase 3b: the zero-knowledge SpaceFS backend + its store abstraction.
// HttpEncStore lives in ./httpEncStore (deep-import) so this barrel stays free
// of the admin auth/WebAuthn dependency it pulls in.
export * from './encStore'
export * from './encfs'
export * from './commentLog'
