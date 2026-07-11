/**
 * Virtual filesystem layer (Phase 1): the logical node model, the op-log types
 * and single-writer replay, the encrypted-op envelope, and the SpaceFS
 * interface both backends will implement later.
 */
export * from './ids'
export * from './nodes'
export * from './ops'
export * from './opCrypto'
export type { SpaceFS } from './spacefs'
