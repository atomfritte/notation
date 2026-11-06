/**
 * agent — the assistant's turn loop, running in the browser.
 *
 * One user message → stream Claude's reply → run the tool calls it makes
 * (asking the user before any change) → send the results back → repeat until
 * Claude answers without a tool call. The request goes from this tab straight
 * to the Claude API; the notation server only ever stores the finished chat
 * (sealed with the Space key on a zero-knowledge Space).
 *
 * The history is APPEND-ONLY: every response is appended exactly as received
 * (thinking blocks, fallback blocks and all), and the system prompt and tool
 * list are byte-identical on every request. That is what keeps the prompt cache
 * warm across turns and keeps earlier thinking valid — the API binds a thinking
 * block to the exact prefix it was produced under. Volatile context (today's
 * date, the open page) rides in the user message, never in the system prompt.
 */
import Anthropic from '@anthropic-ai/sdk'
import type {
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaToolResultBlockParam,
  BetaToolUseBlock,
  MessageCreateParamsStreaming,
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { Chat, ToolRecord } from './chatStore'
import { DEFAULT_MODEL, addUsage, modelInfo, type Effort } from './models'
import { forgetSessionKey, KeyLockedError, sessionKey } from './settings'
import { adaptiveFor, effortFor } from './modelList'
import { MUTATING_TOOLS, TOOLS, ToolInputError, prepareTool, type ToolContext } from './tools'
import { normalizePath } from './agentFs'
import { folderInstructions, renderInstruction } from './instructions'
import { pathMatcher } from './skillFormat'

/** Marks the context block of a user message; the UI hides it behind a chip. */
export const CONTEXT_TAG = 'notation-context'
/** Marks a skill the user ran with `/name`; the UI shows it as a chip. */
export const SKILL_TAG = 'notation-skill'

const MAX_TOKENS = 64_000
/** Hard stop for runaway tool loops within one user turn. */
const MAX_STEPS = 60

export interface TurnContext {
  /** The page open in the main view, if any. */
  openPage?: string
  /** Today's date, YYYY-MM-DD (for the changelog and "today" questions). */
  today: string
  /** Changes the user reverted with the undo button since the last message. */
  undone?: string[]
  /** A skill the user ran with `/name`, rendered (skills.ts renderSkill). */
  skill?: { name: string; path: string; content: string }
}

export interface PendingApproval {
  toolUseId: string
  name: string
  record: Omit<ToolRecord, 'status'>
}

export type ApprovalDecision =
  | { approve: true; /** Stop asking for the rest of this chat. */ always?: boolean }
  | { approve: false; note?: string }

export interface TurnHooks {
  /** The reply being streamed right now (null when none is). */
  live(snapshot: BetaMessage | null): void
  /** The chat changed (messages appended, a tool finished, a notice added). */
  update(chat: Chat): void
  /** Ask the user about one change. */
  approve(p: PendingApproval): Promise<ApprovalDecision>
  /** Current auto-accept setting (read at each change). */
  autoApprove(): boolean
  /** A change was applied and can be undone with this. */
  registerUndo(toolUseId: string, undo: () => Promise<void>): void
  /** Persist the chat (called after every step). */
  persist(chat: Chat): Promise<void>
}

export interface TurnArgs {
  chat: Chat
  /**
   * The user's new message. Omitted to retry: the loop then re-sends the
   * history as it stands (which must end with a user message).
   */
  text?: string
  context: TurnContext
  model: string
  effort: Effort
  tools: ToolContext
  hooks: TurnHooks
  signal: AbortSignal
}

/** A user-facing failure, ready to show. */
export class AssistantError extends Error {
  constructor(message: string, readonly kind: 'auth' | 'rate' | 'overloaded' | 'network' | 'request' | 'other') {
    super(message)
  }
}

// ── client + optional request features ───────────────────────────────────────

let cached: { key: string; client: Anthropic } | null = null

export async function client(): Promise<Anthropic> {
  const key = await sessionKey()
  if (cached?.key !== key) {
    // The owner's own key, used from the owner's own signed-in session — the
    // case the SDK's browser opt-in exists for. It is never persisted here.
    cached = { key, client: new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true, maxRetries: 2 }) }
  }
  return cached.client
}

type Feature = 'fallbacks' | 'blockBinding' | 'eager' | 'display' | 'effort' | 'thinking'

/**
 * Features a model turned out not to accept (a 400 naming them). Dropped for the
 * rest of the page session and the request retried, so a model or beta change
 * on the API side degrades the assistant instead of breaking it.
 */
const unsupported = new Map<string, Set<Feature>>()

function has(model: string, f: Feature): boolean {
  if (f === 'fallbacks' && !modelInfo(model).fallback) return false
  return !unsupported.get(model)?.has(f)
}

function featureFromError(message: string): Feature | null {
  const m = message.toLowerCase()
  if (m.includes('fallback')) return 'fallbacks'
  if (m.includes('block_binding') || m.includes('prefix_mismatch') || m.includes('thinking-binding')) return 'blockBinding'
  if (m.includes('eager_input_streaming')) return 'eager'
  if (m.includes('display')) return 'display'
  if (m.includes('effort')) return 'effort'
  if (m.includes('adaptive') || m.includes('thinking')) return 'thinking'
  return null
}

export function buildParams(chat: Chat, model: string, effort: Effort): MessageCreateParamsStreaming {
  const betas: string[] = []
  const fallbacks = has(model, 'fallbacks')
  // What the Models API reported for this model, then what a 400 taught us.
  const thinking = adaptiveFor(model) && has(model, 'thinking')
  const binding = thinking && has(model, 'blockBinding')
  const level = has(model, 'effort') ? effortFor(model, effort) : null
  if (fallbacks) betas.push('server-side-fallback-2026-07-01')
  if (binding) betas.push('thinking-binding-controls-2026-08-01')
  const eager = has(model, 'eager')
  return {
    model,
    max_tokens: MAX_TOKENS,
    stream: true,
    // Explicit breakpoint on the static prefix (tools + system) plus automatic
    // caching for the growing conversation tail.
    system: [{ type: 'text', text: chat.body.system, cache_control: { type: 'ephemeral' } }],
    cache_control: { type: 'ephemeral' },
    messages: chat.body.messages,
    tools: TOOLS.map(t => (eager ? { ...t, eager_input_streaming: true } : t)),
    ...(thinking ? {
      thinking: {
        type: 'adaptive' as const,
        ...(has(model, 'display') ? { display: 'summarized' as const } : {}),
        // A changed prefix (an older chat after an app update changed the tool
        // descriptions) drops the stale thinking instead of failing the request.
        ...(binding ? { block_binding: { prefix_mismatch_behavior: 'drop_block' as const } } : {}),
      },
    } : {}),
    ...(level ? { output_config: { effort: level } } : {}),
    // On a safety decline, re-run on the model Anthropic recommends for that
    // category instead of returning the refusal.
    ...(fallbacks ? { fallbacks: 'default' as const } : {}),
    ...(betas.length ? { betas } : {}),
  }
}

function friendly(err: unknown): AssistantError {
  if (err instanceof KeyLockedError) return new AssistantError(err.message, 'auth')
  if (err instanceof Anthropic.AuthenticationError) {
    forgetSessionKey()
    return new AssistantError('The API key was rejected — it may have been revoked. Replace it in the assistant settings.', 'auth')
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new AssistantError('This API key may not use the selected model.', 'auth')
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new AssistantError('Rate limit reached. Wait a moment and try again.', 'rate')
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new AssistantError('Can’t reach the Claude API. Are you online?', 'network')
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new AssistantError(`The Claude API rejected the request: ${err.message}`, 'request')
  }
  if (err instanceof Anthropic.APIError) {
    if (err.status === 529 || err.status === 503) return new AssistantError('Claude is overloaded right now. Try again in a moment.', 'overloaded')
    return new AssistantError(`Claude API error (${err.status ?? '?'}): ${err.message}`, 'other')
  }
  if (err instanceof AssistantError) return err
  const status = (err as { status?: number })?.status
  if (status === 404) return new AssistantError('No API key is set up. Open the assistant settings.', 'auth')
  return new AssistantError(String((err as Error)?.message ?? err), 'other')
}

// ── the loop ─────────────────────────────────────────────────────────────────

function userMessage(text: string, ctx: TurnContext): BetaMessageParam {
  const lines = [`Today: ${ctx.today}`]
  lines.push(ctx.openPage ? `Open page: ${ctx.openPage}` : 'No page is open.')
  if (ctx.undone?.length) {
    lines.push('Since your last reply, the user reverted these changes of yours with the undo button (the files are back as they were before):')
    for (const u of ctx.undone) lines.push(`- ${u}`)
  }
  const content: BetaContentBlockParam[] = [
    { type: 'text', text },
    { type: 'text', text: `<${CONTEXT_TAG}>\n${lines.join('\n')}\n</${CONTEXT_TAG}>` },
  ]
  // Claude Code puts a skill run with `/name` into the conversation as part of
  // the user's turn; so do we, right after the message that ran it.
  if (ctx.skill) {
    const s = ctx.skill
    content.push({ type: 'text', text: `<${SKILL_TAG} name="${s.name}" path="${s.path}">\n${s.content}\n</${SKILL_TAG}>` })
  }
  return { role: 'user', content }
}

/** The files a tool call reads or writes — what brings folder instructions into play. */
function touchedBy(call: BetaToolUseBlock): { path: string; op: 'read' | 'write' }[] {
  const input = (call.input ?? {}) as Record<string, unknown>
  const one = (key: string, op: 'read' | 'write') => {
    try { return [{ path: normalizePath(input[key]), op }] } catch { return [] }
  }
  switch (call.name) {
    case 'read_file': return one('path', 'read')
    case 'write_file':
    case 'edit_file': return one('path', 'write')
    case 'move_file': return one('to', 'write')
    default: return []
  }
}

/**
 * What a successful tool call brings into play, Claude Code style: the
 * CLAUDE.md (or AGENTS.md) of each folder Claude just worked in, the first
 * time, and path-scoped skills whose files it touched. Appended to the tool
 * result; recorded in the chat so nothing is announced twice.
 */
async function followUps(call: BetaToolUseBlock, a: TurnArgs): Promise<string> {
  const mem = a.chat.body.memory
  const touched = touchedBy(call)
  if (!mem || !touched.length) return ''
  const parts: string[] = []
  try {
    const fs = a.tools.fs
    const loaded = new Set(mem.loaded)
    const found = await folderInstructions({ files: await fs.files(), read: (p) => fs.tryReadText(p) }, touched, loaded, mem.mode)
    mem.loaded = [...loaded]
    for (const f of found) parts.push(renderInstruction(f))
  } catch { /* the tool result stands on its own */ }
  const announced = new Set(mem.skills ?? [])
  for (const s of a.tools.brief.skills) {
    if (!s.paths || !s.modelInvocable || announced.has(s.name)) continue
    const match = pathMatcher(s.paths)
    if (!touched.some(t => match(t.path))) continue
    announced.add(s.name)
    parts.push(`The skill "${s.name}" applies to the file you just worked on — ${s.description || 'no description'}. Call load_skill with its name before you continue.`)
  }
  mem.skills = [...announced]
  if (!parts.length) return ''
  return `\n\n<system-reminder>\n${parts.join('\n\n')}\n</system-reminder>`
}

function titleFrom(text: string): string {
  const line = text.split('\n').map(s => s.trim()).find(Boolean) ?? 'New chat'
  return line.length > 70 ? line.slice(0, 67).trimEnd() + '…' : line
}

/** Per-chat "don't ask again" — in memory only, so a reload asks again. */
const approveAll = new Set<string>()

export function isApprovingAll(chatId: string): boolean {
  return approveAll.has(chatId)
}

export function setApprovingAll(chatId: string, on: boolean): void {
  if (on) approveAll.add(chatId)
  else approveAll.delete(chatId)
}

/** Run one user turn to completion (or until stopped). Throws {@link AssistantError}. */
export async function runTurn(args: TurnArgs): Promise<void> {
  const a: TurnArgs = { ...args, model: args.model || DEFAULT_MODEL }
  const { chat, hooks, signal } = a
  const body = chat.body
  const meta = chat.meta

  if (a.text !== undefined) {
    const msg = userMessage(a.text, a.context)
    const last = body.messages[body.messages.length - 1]
    if (last?.role === 'user') {
      // The previous turn ended without a reply (stopped or failed). Append to
      // that user message rather than sending two user turns in a row; the
      // prefix before it is untouched, so the cache and thinking stay valid.
      const prev = typeof last.content === 'string' ? [{ type: 'text' as const, text: last.content }] : last.content
      last.content = [...prev, ...(msg.content as BetaContentBlockParam[])]
    } else {
      body.messages.push(msg)
    }
    if (meta.messageCount === 0) meta.title = titleFrom(a.text)
  } else if (body.messages[body.messages.length - 1]?.role !== 'user') {
    return // nothing to retry
  }
  meta.model = a.model
  meta.effort = a.effort
  touch(chat)
  hooks.update(chat)

  const note = (kind: 'error' | 'stopped' | 'refusal' | 'info', text: string) => {
    body.notices.push({ after: body.messages.length - 1, kind, text })
    hooks.update(chat)
  }

  let jsonRetries = 0
  for (let step = 0; step < MAX_STEPS; step++) {
    if (signal.aborted) { note('stopped', 'Stopped.'); break }
    let message: BetaMessage
    try {
      const c = await client()
      const stream = c.beta.messages.stream(buildParams(chat, a.model, a.effort), { signal })
      let frame = 0
      stream.on('streamEvent', (_e, snapshot) => {
        if (frame) return
        frame = requestAnimationFrame(() => { frame = 0; hooks.live(snapshot) })
      })
      try {
        message = await stream.finalMessage()
      } finally {
        if (frame) cancelAnimationFrame(frame)
        hooks.live(null)
      }
      jsonRetries = 0
    } catch (err) {
      hooks.live(null)
      if (signal.aborted || err instanceof Anthropic.APIUserAbortError) {
        note('stopped', 'Stopped. The unfinished reply was discarded.')
        break
      }
      if (err instanceof Anthropic.BadRequestError) {
        const f = featureFromError(err.message)
        if (f && has(a.model, f)) {
          const set = unsupported.get(a.model) ?? new Set<Feature>()
          set.add(f)
          unsupported.set(a.model, set)
          step--
          continue
        }
      }
      // With eager input streaming, a tool input the SDK cannot parse at all
      // rejects the stream with a plain (non-API) error: re-issue the turn.
      if (!(err instanceof Anthropic.APIError) && !(err instanceof AssistantError) && jsonRetries < 2 && !(err as { status?: number })?.status) {
        jsonRetries++
        step--
        continue
      }
      const e = friendly(err)
      note('error', e.message)
      await hooks.persist(chat).catch(() => {})
      throw e
    }

    meta.usage = addUsage(meta.usage, message.usage, message.model ?? a.model)
    const u = message.usage
    meta.contextTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)

    if (message.stop_reason === 'refusal') {
      // Even the fallback chain declined. The partial reply is discarded.
      const cat = message.stop_details && 'category' in message.stop_details ? message.stop_details.category : null
      note('refusal', `Claude declined this request${cat ? ` (${cat})` : ''}. Rephrase it or start a new chat.`)
      break
    }

    body.messages.push({ role: 'assistant', content: message.content as BetaContentBlockParam[] })
    meta.messageCount++
    touch(chat)
    hooks.update(chat)

    const calls = message.content.filter((b): b is BetaToolUseBlock => b.type === 'tool_use')
    if (message.stop_reason === 'pause_turn') { await hooks.persist(chat); continue }
    if (calls.length === 0) {
      if (message.stop_reason === 'max_tokens') note('info', 'The reply hit the length limit and was cut off. Say “continue” to pick up where it stopped.')
      await hooks.persist(chat)
      break
    }

    const results: BetaToolResultBlockParam[] = []
    for (const call of calls) {
      results.push(await runCall(call, message.stop_reason === 'max_tokens', a))
    }
    body.messages.push({ role: 'user', content: results })
    touch(chat)
    hooks.update(chat)
    await hooks.persist(chat)
    if (signal.aborted) { note('stopped', 'Stopped.'); await hooks.persist(chat); break }
    if (step === MAX_STEPS - 1) note('info', 'That took a lot of steps, so the run paused here. Say “continue” to let Claude carry on.')
  }
  await hooks.persist(chat).catch(() => {})
}

function touch(chat: Chat): void {
  chat.meta.updatedAt = new Date().toISOString()
}

async function runCall(call: BetaToolUseBlock, truncated: boolean, a: TurnArgs): Promise<BetaToolResultBlockParam> {
  const { chat, hooks, signal } = a
  const tools = chat.body.tools
  const result = (content: string, isError = false): BetaToolResultBlockParam => ({
    type: 'tool_result',
    tool_use_id: call.id,
    content,
    ...(isError ? { is_error: true } : {}),
  })
  const fail = (record: Omit<ToolRecord, 'status'>, status: ToolRecord['status'], msg: string, extra: Partial<ToolRecord> = {}) => {
    tools[call.id] = { ...record, ...extra, status }
    hooks.update(chat)
    return result(msg, true)
  }
  const fallbackRecord: Omit<ToolRecord, 'status'> = { kind: MUTATING_TOOLS.has(call.name) ? 'write' : 'other', summary: call.name }

  if (signal.aborted) return fail(fallbackRecord, 'cancelled', 'The user stopped the run before this tool call ran.')
  if (truncated) {
    // A tool input cut off at max_tokens can still parse as a valid partial
    // object; never act on it.
    return fail(fallbackRecord, 'error', 'This tool call was cut off by the output limit and was NOT run. Split large writes into several smaller edit_file calls.')
  }

  let prepared
  try {
    prepared = await prepareTool(call.name, call.input, a.tools)
  } catch (e) {
    const msg = e instanceof ToolInputError ? e.message : `Tool failed: ${(e as Error).message}`
    return fail(fallbackRecord, 'error', msg, { summary: `${call.name}: ${msg.slice(0, 120)}` })
  }
  const record = prepared.record

  if (prepared.mutating) {
    const auto = hooks.autoApprove() || isApprovingAll(chat.meta.id)
    if (!auto) {
      // No record yet: while it is pending, the UI shows the approval card.
      const decision = await hooks.approve({ toolUseId: call.id, name: call.name, record })
      if (signal.aborted) return fail(record, 'cancelled', 'The user stopped the run before this change was applied.')
      if (!decision.approve) {
        const n = decision.note?.trim()
        return fail(record, 'rejected', `The user rejected this change${n ? ` and said: ${n}` : '.'} Nothing was changed.`, { note: n })
      }
      if (decision.always) setApprovingAll(chat.meta.id, true)
    }
    try {
      const text = await prepared.run()
      tools[call.id] = { ...record, status: 'done', auto: auto || undefined }
      if (prepared.undo) hooks.registerUndo(call.id, prepared.undo)
      hooks.update(chat)
      return result(text + (await followUps(call, a)))
    } catch (e) {
      return fail(record, 'error', `The change failed: ${(e as Error).message}`)
    }
  }

  try {
    const text = await prepared.run()
    tools[call.id] = { ...record, status: 'done' }
    hooks.update(chat)
    return result(text + (await followUps(call, a)))
  } catch (e) {
    return fail(record, 'error', (e as Error).message)
  }
}
