/**
 * chatStore — persistent assistant chats, one store per Space.
 *
 * A chat is two records on the server (see backend space/chats.go): a small
 * META record (title, dates, model, usage — listed in bulk for the history
 * menu) and the BODY (the conversation exactly as sent to the API, plus the
 * UI facts about each tool call). The server treats both as opaque bytes.
 *
 * The {@link RecordCodec} is the only thing that differs between Space kinds:
 *
 *   - {@link plainCodec}: UTF-8 JSON, for a plaintext Space.
 *   - {@link sealedCodec}: the same JSON sealed with the Space key (AES-256-GCM
 *     in the key worker), for a zero-knowledge Space. The associated data binds
 *     each record to its chat id AND its role, so a server that swapped two
 *     chats, or served one chat's body as another's title, fails the tag check
 *     instead of being believed.
 *
 * The server refuses a cleartext record on an encrypted Space (409), so a bug
 * here can't silently store a chat in the clear.
 */
import type { BetaMessageParam } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { decryptBlob, encryptBlob } from '../../../shared/crypto/blob'
import { randomBytes, toHex, utf8Decode, utf8Encode } from '../../../shared/crypto/bytes'
import type { KeyHandle } from '../../../shared/crypto/keys'
import { getCSRF } from '../auth'
import type { Effort, UsageTotals } from './models'

/** UI facts about one tool call, keyed by its tool_use id. */
export interface ToolRecord {
  status: 'done' | 'error' | 'rejected' | 'cancelled'
  kind: 'read' | 'list' | 'search' | 'write' | 'edit' | 'move' | 'delete' | 'other'
  /** One line for the collapsed card, e.g. "Edit notes/a.md". */
  summary: string
  path?: string
  to?: string
  /** Unified diff of a change, capped (see diff.ts). */
  diff?: string
  added?: number
  removed?: number
  /** Applied without asking (auto-accept was on). */
  auto?: boolean
  /** The user's note when rejecting, passed on to Claude. */
  note?: string
  /** The user reverted this change afterwards with the undo button. */
  undone?: boolean
  /** Claude has been told about the undo (with the user's next message). */
  undoneReported?: boolean
}

/** A line the UI shows between messages that is not part of the API history. */
export interface Notice {
  /** Index into `messages` the notice follows. */
  after: number
  kind: 'error' | 'stopped' | 'refusal' | 'info'
  text: string
}

export interface ChatMeta {
  v: 1
  id: string
  title: string
  createdAt: string
  updatedAt: string
  model: string
  effort: Effort
  usage: UsageTotals
  /** Input tokens of the most recent request: the conversation's context size. */
  contextTokens: number
  messageCount: number
}

export interface ChatBody {
  v: 1
  /**
   * The system prompt, frozen when the chat started. Re-sending it byte-for-
   * byte keeps the prompt cache warm and keeps earlier thinking blocks valid
   * (the API binds them to the exact prefix they were produced under).
   */
  system: string
  messages: BetaMessageParam[]
  tools: Record<string, ToolRecord>
  notices: Notice[]
  /**
   * Which instruction files are in Claude's context (Claude Code's memory
   * rules, instructions.ts): the mode the Space started in, the files loaded
   * so far — at the start and on demand — and the path-scoped skills already
   * announced. Absent in chats from before it existed.
   */
  memory?: { mode: 'claude' | 'agents'; loaded: string[]; skills?: string[] }
}

export interface Chat {
  meta: ChatMeta
  body: ChatBody
}

export function newChatId(): string {
  return toHex(randomBytes(16))
}

// ── codecs ───────────────────────────────────────────────────────────────────

export interface RecordCodec {
  readonly sealed: boolean
  encode(kind: 'meta' | 'body', chatId: string, value: unknown): Promise<Uint8Array>
  decode(kind: 'meta' | 'body', chatId: string, bytes: Uint8Array): Promise<unknown>
}

export const plainCodec: RecordCodec = {
  sealed: false,
  encode: async (_k, _id, value) => utf8Encode(JSON.stringify(value)),
  decode: async (_k, _id, bytes) => JSON.parse(utf8Decode(bytes)),
}

const chatAad = (kind: 'meta' | 'body', chatId: string) =>
  utf8Encode(`notation:chat:v1\u0000${kind}\u0000${chatId}`)

export function sealedCodec(handle: KeyHandle): RecordCodec {
  return {
    sealed: true,
    encode: (kind, id, value) => encryptBlob(utf8Encode(JSON.stringify(value)), handle, chatAad(kind, id)),
    decode: async (kind, id, bytes) => JSON.parse(utf8Decode(await decryptBlob(bytes, handle, chatAad(kind, id)))),
  }
}

// ── transport ────────────────────────────────────────────────────────────────

export function bytesToBase64(bytes: Uint8Array): string {
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(s)
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

interface ListItem {
  id: string
  sealed: boolean
  modified: string
  size: number
  meta: string
}

async function req(url: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers)
  if ((init?.method ?? 'GET') !== 'GET') {
    const csrf = getCSRF()
    if (csrf) headers.set('X-CSRF-Token', csrf)
  }
  const r = await fetch(url, { ...init, headers, credentials: 'same-origin', cache: 'no-store' })
  if (r.status === 401) window.dispatchEvent(new CustomEvent('notation:auth-expired'))
  if (!r.ok) {
    let msg = `HTTP ${r.status}`
    try {
      const j = await r.json()
      if (j?.error) msg = j.error
    } catch { /* not JSON */ }
    throw Object.assign(new Error(msg), { status: r.status })
  }
  return r
}

/** The store the chat panel uses. */
export interface ChatStore {
  readonly sealed: boolean
  list(): Promise<ChatMeta[]>
  load(meta: ChatMeta): Promise<Chat>
  save(chat: Chat): Promise<void>
  remove(id: string): Promise<void>
}

export class HttpChatStore implements ChatStore {
  private readonly base: string

  constructor(spaceID: string, private readonly codec: RecordCodec) {
    this.base = `/api/admin/spaces/${encodeURIComponent(spaceID)}/chats`
  }

  get sealed(): boolean {
    return this.codec.sealed
  }

  async list(): Promise<ChatMeta[]> {
    const items = (await (await req(this.base)).json()) as ListItem[]
    const metas = await Promise.all(
      items
        // Mid-conversion the server lists both formats; this store reads its own.
        .filter(it => it.sealed === this.codec.sealed)
        .map(async (it) => {
          try {
            const meta = (await this.codec.decode('meta', it.id, base64ToBytes(it.meta))) as ChatMeta
            return meta && meta.v === 1 && meta.id === it.id ? meta : null
          } catch {
            return null // unreadable (wrong key, tampered): skip rather than break the list
          }
        }),
    )
    return metas
      .filter((m): m is ChatMeta => m !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async load(meta: ChatMeta): Promise<Chat> {
    const id = meta.id
    const r = await req(`${this.base}/${id}?sealed=${this.codec.sealed ? 1 : 0}`)
    const body = (await this.codec.decode('body', id, new Uint8Array(await r.arrayBuffer()))) as ChatBody
    if (!body || body.v !== 1 || !Array.isArray(body.messages)) throw new Error('chat record is corrupt')
    body.tools ??= {}
    body.notices ??= []
    return { meta, body }
  }

  async save(chat: Chat): Promise<void> {
    const id = chat.meta.id
    const [meta, body] = await Promise.all([
      this.codec.encode('meta', id, chat.meta),
      this.codec.encode('body', id, chat.body),
    ])
    await req(`${this.base}/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meta: bytesToBase64(meta), body: bytesToBase64(body) }),
    })
  }

  async remove(id: string): Promise<void> {
    await req(`${this.base}/${id}`, { method: 'DELETE' })
  }
}

/**
 * Re-write every chat of a Space from one format into the other — the chat half
 * of a Space conversion. Runs while the server's conversion marker is set (so it
 * accepts the TARGET format) and BEFORE finalize, which then drops the source
 * format; an abort drops what this staged. Returns how many chats were copied.
 */
export async function migrateChats(spaceID: string, from: RecordCodec, to: RecordCodec): Promise<number> {
  const base = `/api/admin/spaces/${encodeURIComponent(spaceID)}/chats`
  const items = ((await (await req(base)).json()) as ListItem[]).filter(it => it.sealed === from.sealed)
  let n = 0
  for (const it of items) {
    let meta: unknown
    let body: unknown
    try {
      meta = await from.decode('meta', it.id, base64ToBytes(it.meta))
      const r = await req(`${base}/${it.id}?sealed=${from.sealed ? 1 : 0}`)
      body = await from.decode('body', it.id, new Uint8Array(await r.arrayBuffer()))
    } catch {
      continue // unreadable source record: nothing to carry over
    }
    const [m, b] = await Promise.all([to.encode('meta', it.id, meta), to.encode('body', it.id, body)])
    await req(`${base}/${it.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meta: bytesToBase64(m), body: bytesToBase64(b) }),
    })
    n++
  }
  return n
}
