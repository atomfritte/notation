/**
 * ChatPanel — the Claude assistant, docked on the right of a Space.
 *
 * Everything happens in this tab: the turn loop (lib/ai/agent.ts) calls the
 * Claude API directly and works on the Space through the same SyncSpace port
 * the folder sync uses — the unlocked EncryptedFS on a zero-knowledge Space,
 * the plaintext file API otherwise. The server only stores the finished chats,
 * sealed with the Space key when the Space is encrypted.
 *
 * Loaded lazily: the SDK and the panel cost nothing until the panel opens.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BetaContentBlock, BetaContentBlockParam, BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import {
  ArrowUp, Brain, Check, ChevronDown, ChevronRight, Copy, FileText, History, Loader2, LockKeyhole, ShieldCheck, MessageSquarePlus,
  RotateCcw, Settings2, Sparkles, Square, Trash2, X, Zap, CircleAlert, Info, Ban,
} from 'lucide-react'
import type { KeyHandle } from '../../../shared/crypto/keys'
import type { SyncSpace } from '../../lib/syncSpace'
import { AgentFS } from '../../lib/ai/agentFs'
import { CONTEXT_TAG, client, isApprovingAll, runTurn, setApprovingAll, type ApprovalDecision, type PendingApproval } from '../../lib/ai/agent'
import { HttpChatStore, newChatId, plainCodec, sealedCodec, type Chat, type ChatMeta, type ChatStore, type Notice } from '../../lib/ai/chatStore'
import { DEFAULT_EFFORT, DEFAULT_MODEL, emptyUsage, formatCost, formatTokens, isEffort, modelInfo, type Effort } from '../../lib/ai/models'
import { refreshModels } from '../../lib/ai/modelList'
import { useKeyMemory } from '../../lib/ai/keyMemory'
import { getAISettings, keyState, lockKey, saveAISettings, type AISettings } from '../../lib/ai/settings'
import { collectBrief, type Brief } from '../../lib/ai/skills'
import { buildSystemPrompt } from '../../lib/ai/systemPrompt'
import { AISettingsDialog, AISettingsForm } from './AISettingsDialog'
import { ChatMarkdown } from './ChatMarkdown'
import { ApprovalCard, ToolCard } from './ToolCards'
import { UnlockBar } from './KeyGate'
import { ModelPicker } from './ModelPicker'

export interface ChatPanelProps {
  spaceID: string
  spaceName: string
  encrypted: boolean
  /** How the assistant reads and writes this Space. */
  space: SyncSpace
  /** The unlocked Space key (encrypted Spaces): chats are sealed with it. */
  keyHandle: KeyHandle | null
  /** The page open in the main view ('' for none). */
  openPage: string
  /** Every file path of the Space (link resolution in replies). */
  files: string[]
  isMobile: boolean
  /** The user clicked a page link in the chat. */
  onNavigate: (path: string) => void
  /** Claude asked to show a page (open_page), or a change should be shown. */
  onOpenPage: (path: string) => void
  /** Files changed (refresh the tree / the open page). */
  onChanged: (paths: string[]) => void
  onMoved: (from: string, to: string) => void
  onRemoved: (path: string) => void
  /** Why `path` can't be changed right now, or null. */
  writeGuard: (path: string) => string | null
  onClose: () => void
}

const WIDTH_KEY = 'notation_ai_width'
const AUTO_KEY = 'notation_ai_auto_apply'
const lastChatKey = (spaceID: string) => `notation_ai_last_${spaceID}`

const readLS = (k: string): string | null => { try { return localStorage.getItem(k) } catch { return null } }
const writeLS = (k: string, v: string | null) => {
  try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v) } catch { /* private mode */ }
}

const today = () => new Date().toLocaleDateString('sv-SE') // YYYY-MM-DD, local

/**
 * Unsent drafts per Space survive closing the panel — in memory only, never in
 * browser storage, so nothing typed about an encrypted Space lands on disk.
 */
const drafts = new Map<string, string>()

export default function ChatPanel(props: ChatPanelProps) {
  const { spaceID, encrypted, keyHandle, isMobile, onClose } = props

  // ── settings ──
  const [settings, setSettings] = useState<AISettings | null>(null)
  const [settingsErr, setSettingsErr] = useState<string | null>(null)
  // true = open on the key section ("Forgot the password?").
  const [settingsOpen, setSettingsOpen] = useState<false | 'all' | 'key'>(false)
  useEffect(() => {
    getAISettings().then(setSettings).catch(e => setSettingsErr((e as Error).message))
  }, [])
  // Re-render on lock/unlock; the key itself never enters React state.
  useKeyMemory()
  const kState = keyState(settings)
  const keyReady = kState === 'ready'
  // Once the key is usable, learn which models it can use (cached for a day).
  useEffect(() => { if (keyReady) void refreshModels(client) }, [keyReady])

  // ── store ──
  const store = useMemo<ChatStore | null>(() => {
    if (encrypted && !keyHandle) return null
    return new HttpChatStore(spaceID, encrypted ? sealedCodec(keyHandle!) : plainCodec)
  }, [spaceID, encrypted, keyHandle])

  const [chats, setChats] = useState<ChatMeta[] | null>(null)
  const [listErr, setListErr] = useState<string | null>(null)
  const chatRef = useRef<Chat | null>(null)
  // The chat object is mutated in place by the turn loop; this counter is what
  // tells React (and the memoised message list) that it changed.
  const [rev, setRev] = useState(0)
  const rerender = useCallback(() => setRev(r => r + 1), [])
  const [loadingChat, setLoadingChat] = useState(false)

  const setChat = useCallback((c: Chat | null) => {
    chatRef.current = c
    writeLS(lastChatKey(spaceID), c?.meta.messageCount ? c.meta.id : null)
    rerender()
  }, [spaceID, rerender])

  useEffect(() => {
    if (!store) return
    let cancelled = false
    store.list().then(async (list) => {
      if (cancelled) return
      setChats(list)
      const last = readLS(lastChatKey(spaceID))
      const meta = last ? list.find(m => m.id === last) : undefined
      if (meta && !chatRef.current) {
        setLoadingChat(true)
        try {
          const c = await store.load(meta)
          if (!cancelled && !chatRef.current) setChat(c)
        } catch { /* fall back to a new chat */ } finally {
          if (!cancelled) setLoadingChat(false)
        }
      }
    }).catch(e => { if (!cancelled) setListErr((e as Error).message) })
    return () => { cancelled = true }
  }, [store, spaceID, setChat])

  // ── brief (instructions + skills), refreshed per new chat ──
  const briefRef = useRef<Promise<Brief> | null>(null)
  const loadBrief = useCallback((fresh = false) => {
    if (!briefRef.current || fresh) {
      briefRef.current = collectBrief(new AgentFS(props.space), {
        librarySpace: settings?.skills_space,
        currentSpace: spaceID,
      })
    }
    return briefRef.current
  }, [props.space, settings?.skills_space, spaceID])
  const [skills, setSkills] = useState<Brief['skills']>([])
  useEffect(() => {
    if (!settings?.configured) return
    let cancelled = false
    loadBrief(true).then(b => { if (!cancelled) setSkills(b.skills) }).catch(() => {})
    return () => { cancelled = true }
  }, [settings?.configured, loadBrief])

  // ── per-turn state ──
  const [running, setRunning] = useState(false)
  const [live, setLive] = useState<{ msg: BetaMessage } | null>(null)
  const [pending, setPending] = useState<{ p: PendingApproval; resolve: (d: ApprovalDecision) => void } | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const undoMap = useRef(new Map<string, () => Promise<void>>())
  const [saveErr, setSaveErr] = useState<string | null>(null)
  const saveChain = useRef<Promise<void>>(Promise.resolve())

  const [autoApply, setAutoApply] = useState(() => readLS(AUTO_KEY) === '1')
  const autoRef = useRef(autoApply)
  useEffect(() => { autoRef.current = autoApply; writeLS(AUTO_KEY, autoApply ? '1' : null) }, [autoApply])

  // Model + effort for the NEXT turn: the chat's own, else the defaults.
  const [pick, setPick] = useState<{ model: string; effort: Effort } | null>(null)
  const chat = chatRef.current
  // `||`, not `??`: an unset default arrives from the server as "".
  const model = pick?.model || chat?.meta.model || settings?.default_model || DEFAULT_MODEL
  const effort = pick?.effort ?? chat?.meta.effort ?? (isEffort(settings?.default_effort) ? settings!.default_effort as Effort : DEFAULT_EFFORT)

  const [draft, setDraftState] = useState(() => drafts.get(spaceID) ?? '')
  const setDraft = useCallback((t: string) => {
    setDraftState(t)
    if (t) drafts.set(spaceID, t)
    else drafts.delete(spaceID)
  }, [spaceID])
  const [includePage, setIncludePage] = useState(true)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { inputRef.current?.focus({ preventScroll: true }) }, [settings?.configured, keyReady])

  const persist = useCallback((c: Chat) => {
    if (!store) return Promise.resolve()
    // Serialise saves: each PUT carries the whole chat, so the last one wins —
    // they just must not overtake each other.
    const next = saveChain.current.then(async () => {
      try {
        await store.save(c)
        setSaveErr(null)
        setChats(prev => {
          const rest = (prev ?? []).filter(m => m.id !== c.meta.id)
          return [{ ...c.meta }, ...rest]
        })
        if (chatRef.current === c && c.meta.messageCount) writeLS(lastChatKey(spaceID), c.meta.id)
      } catch (e) {
        setSaveErr((e as Error).message)
      }
    })
    saveChain.current = next
    return next
  }, [store, spaceID])

  const newChat = useCallback(() => {
    if (running) return
    setChat(null)
    setPick(null)
    setDraft('')
    briefRef.current = null
    loadBrief(true).then(b => setSkills(b.skills)).catch(() => {})
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [running, setChat, setDraft, loadBrief])

  const openChat = useCallback(async (meta: ChatMeta) => {
    if (!store || running) return
    setLoadingChat(true)
    try {
      setChat(await store.load(meta))
      setPick(null)
    } catch (e) {
      setListErr(`Couldn't open that chat: ${(e as Error).message}`)
    } finally {
      setLoadingChat(false)
    }
  }, [store, running, setChat])

  const deleteChat = useCallback(async (meta: ChatMeta) => {
    if (!store) return
    if (!window.confirm(`Delete the chat “${meta.title}”? This can't be undone. (Changes Claude made to pages stay.)`)) return
    try {
      await store.remove(meta.id)
      setChats(prev => (prev ?? []).filter(m => m.id !== meta.id))
      setApprovingAll(meta.id, false)
      if (chatRef.current?.meta.id === meta.id) setChat(null)
    } catch (e) {
      setListErr((e as Error).message)
    }
  }, [store, setChat])

  // ── send ──
  const send = useCallback(async (text?: string) => {
    if (running || !settings?.configured || !store || !keyReady) return
    if (text !== undefined && !text.trim()) return
    setRunning(true)
    setSaveErr(null)
    try {
      let c = chatRef.current
      const brief = await loadBrief(!c)
      if (!c) {
        const now = new Date().toISOString()
        c = {
          meta: { v: 1, id: newChatId(), title: 'New chat', createdAt: now, updatedAt: now, model, effort, usage: emptyUsage(), contextTokens: 0, messageCount: 0 },
          body: {
            v: 1,
            system: buildSystemPrompt({ spaceId: spaceID, spaceName: props.spaceName, encrypted, brief, globalInstructions: settings.instructions ?? '' }),
            messages: [],
            tools: {},
            notices: [],
          },
        }
        setChat(c)
        setSkills(brief.skills)
      }
      if (text !== undefined) setDraft('')
      const ctrl = new AbortController()
      abortRef.current = ctrl
      const fs = new AgentFS(props.space, { onChange: props.onChanged, onMoved: props.onMoved, onRemoved: props.onRemoved, writeGuard: props.writeGuard })
      // Undos since Claude last heard from the user (stored in the chat, so
      // a reload in between doesn't lose them).
      const undone: string[] = []
      if (text !== undefined) {
        for (const r of Object.values(c.body.tools)) {
          if (r.undone && !r.undoneReported) { undone.push(r.summary); r.undoneReported = true }
        }
      }
      const current = c
      await runTurn({
        chat: current,
        text: text?.trim(),
        context: { openPage: includePage && props.openPage ? props.openPage : undefined, today: today(), undone },
        model,
        effort,
        tools: { fs, brief, openPage: props.onOpenPage },
        signal: ctrl.signal,
        hooks: {
          live: (m) => setLive(m ? { msg: m } : null),
          update: () => rerender(),
          approve: (p) => new Promise<ApprovalDecision>((resolve) => setPending({ p, resolve })),
          autoApprove: () => autoRef.current,
          registerUndo: (id, fn) => { undoMap.current.set(id, fn) },
          persist: (ch) => persist(ch),
        },
      }).catch(() => { /* already recorded as a notice in the chat */ })
    } finally {
      abortRef.current = null
      setPending(null)
      setLive(null)
      setRunning(false)
      rerender()
      setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 0)
    }
  }, [running, settings, store, keyReady, loadBrief, model, effort, spaceID, props, encrypted, setChat, setDraft, includePage, persist, rerender])

  const stop = useCallback(() => {
    abortRef.current?.abort()
    setPending(cur => { cur?.resolve({ approve: false }); return null })
  }, [])

  const decide = useCallback((d: ApprovalDecision) => {
    setPending(cur => { cur?.resolve(d); return null })
  }, [])

  const undo = useCallback(async (toolUseId: string) => {
    const c = chatRef.current
    const fn = undoMap.current.get(toolUseId)
    const rec = c?.body.tools[toolUseId]
    if (!c || !fn || !rec) return
    await fn()
    undoMap.current.delete(toolUseId)
    rec.undone = true
    rerender()
    void persist(c)
  }, [persist, rerender])

  // Esc stops a run (when focus is in the panel).
  const panelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape' || !panelRef.current?.contains(document.activeElement)) return
      if (running) { e.preventDefault(); stop() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [running, stop])

  // ── width (desktop) ──
  const [width, setWidth] = useState(() => {
    const n = Number(readLS(WIDTH_KEY))
    return Number.isFinite(n) && n >= 320 && n <= 900 ? n : 420
  })
  function startResize(e: React.MouseEvent) {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    let w = startW
    const move = (ev: MouseEvent) => { w = Math.max(320, Math.min(Math.min(900, window.innerWidth - 360), startW + (startX - ev.clientX))); setWidth(w) }
    const up = () => {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      writeLS(WIDTH_KEY, String(Math.round(w)))
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  // ── auto-scroll ──
  const scrollRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  useEffect(() => {
    const el = scrollRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  })

  const [historyOpen, setHistoryOpen] = useState(false)

  const shell = isMobile
    ? 'fixed inset-0 z-50 flex flex-col bg-[var(--notation-bg-elevated)] text-[var(--notation-fg)]'
    : 'surface-elevated relative border-l border-[var(--notation-border)] bg-[var(--notation-bg-elevated)] flex flex-col flex-shrink-0 animate-in slide-in-from-right-8 duration-200 shadow-xl'

  const lastMsg = chat?.body.messages[chat.body.messages.length - 1]
  const canRetry = !running && !!chat && lastMsg?.role === 'user' && chat.body.notices.some(n => n.after === chat.body.messages.length - 1 && (n.kind === 'error' || n.kind === 'stopped'))

  return (
    <aside
      ref={panelRef}
      className={shell}
      style={isMobile ? undefined : { width }}
      aria-label="Claude assistant"
    >
      {!isMobile && (
        <div
          onMouseDown={startResize}
          className="absolute left-0 top-0 bottom-0 w-1.5 -ml-0.5 cursor-col-resize hover:bg-[color:var(--notation-accent-30)] z-10"
          aria-hidden
        />
      )}

      {/* header */}
      <div className="flex items-center gap-1 px-2.5 py-2 border-b border-[var(--notation-border)] min-h-[44px]">
        <Sparkles size={15} className="text-[color:var(--notation-accent)] flex-shrink-0 ml-0.5" />
        <div className="relative flex-1 min-w-0">
          <button
            className="flex items-center gap-1 max-w-full px-1.5 py-1 rounded-md hover:bg-[var(--notation-bg-alt)] text-[13px] font-semibold"
            onClick={() => setHistoryOpen(v => !v)}
            aria-haspopup="menu"
            aria-expanded={historyOpen}
            title="Chat history"
          >
            <span className="truncate">{chat?.meta.messageCount ? chat.meta.title : 'New chat'}</span>
            <ChevronDown size={13} className="flex-shrink-0 text-[var(--notation-fg-muted)]" />
          </button>
          {historyOpen && (
            <HistoryMenu
              chats={chats}
              currentId={chat?.meta.id}
              disabled={running}
              onPick={(m) => { setHistoryOpen(false); void openChat(m) }}
              onDelete={(m) => void deleteChat(m)}
              onClose={() => setHistoryOpen(false)}
            />
          )}
        </div>
        {encrypted && (
          <span className="p-1 text-[var(--notation-success)]" title="Encrypted Space: this chat is stored sealed with the Space key. The server can't read it.">
            <ShieldCheck size={14} />
          </span>
        )}
        <IconBtn label="New chat" onClick={newChat} disabled={running}><MessageSquarePlus size={16} /></IconBtn>
        <IconBtn label="Chat history" onClick={() => setHistoryOpen(v => !v)}><History size={16} /></IconBtn>
        {settings?.key_source === 'sealed' && keyReady && (
          <IconBtn label="Lock the assistant (forget the API key in this tab)" onClick={() => { stop(); lockKey() }}><LockKeyhole size={16} /></IconBtn>
        )}
        <IconBtn label="Assistant settings" onClick={() => setSettingsOpen('all')} disabled={!settings}><Settings2 size={16} /></IconBtn>
        <IconBtn label="Close assistant" onClick={onClose}><X size={16} /></IconBtn>
      </div>

      {/* body */}
      {settingsErr ? (
        <div className="p-4 text-[13px] text-[var(--notation-danger)]">Couldn't load the assistant settings: {settingsErr}</div>
      ) : !settings ? (
        <div className="flex-1 flex items-center justify-center text-[var(--notation-fg-muted)]"><Loader2 size={18} className="animate-spin" /></div>
      ) : !settings.configured ? (
        <div className="flex-1 overflow-y-auto p-4">
          <div className="mb-4">
            <div className="text-[15px] font-semibold mb-1">Chat with Claude about this Space</div>
            <p className="text-[12.5px] text-[var(--notation-fg-muted)] leading-relaxed">
              Claude can read, search and edit the pages here — on encrypted Spaces too, because everything runs in this browser tab.
              Add your Claude API key and choose a chat password to start. Usage is billed to that key.
            </p>
          </div>
          <AISettingsForm settings={settings} onSaved={setSettings} firstRun />
        </div>
      ) : !store ? (
        <div className="p-4 text-[13px] text-[var(--notation-fg-muted)]">Unlock the Space to use the assistant.</div>
      ) : (
        <>
          <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto px-3 py-3"
            onScroll={(e) => {
              const el = e.currentTarget
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
            }}
          >
            {listErr && <Banner kind="error" onDismiss={() => setListErr(null)}>{listErr}</Banner>}
            {loadingChat ? (
              <div className="flex justify-center py-8 text-[var(--notation-fg-muted)]"><Loader2 size={18} className="animate-spin" /></div>
            ) : !chat || chat.body.messages.length === 0 ? (
              <EmptyState
                openPage={props.openPage}
                encrypted={encrypted}
                skills={skills}
                onPrompt={(t, sendNow) => {
                  if (sendNow) void send(t)
                  else { setDraft(t); setTimeout(() => { const el = inputRef.current; if (el) { el.focus(); el.setSelectionRange(t.length, t.length) } }, 0) }
                }}
              />
            ) : (
              <Messages
                chat={chat}
                rev={rev}
                files={props.files}
                running={running}
                pendingId={pending?.p.toolUseId}
                pendingRecord={pending?.p.record}
                undoable={undoMap.current}
                onDecide={decide}
                onUndo={undo}
                onNavigate={props.onNavigate}
              />
            )}
            {live && <LiveMessage msg={live.msg} files={props.files} onNavigate={props.onNavigate} />}
            {running && !live && !pending && (
              <div className="flex items-center gap-2 text-[12px] text-[var(--notation-fg-muted)] py-2"><Loader2 size={13} className="animate-spin" /> Claude is working…</div>
            )}
            {canRetry && (
              <button onClick={() => void send()} className="mt-1 flex items-center gap-1.5 text-[12px] px-2.5 py-1 rounded-md border border-[var(--notation-border)] hover:bg-[var(--notation-bg-alt)]">
                <RotateCcw size={12} /> Retry
              </button>
            )}
          </div>

          {saveErr && <Banner kind="error" onDismiss={() => setSaveErr(null)} className="mx-3 mb-1">Couldn't save this chat: {saveErr}</Banner>}

          {kState === 'locked' || kState === 'legacy' ? (
            <UnlockBar
              state={kState}
              hint={settings.key_hint}
              onDone={(s) => { if (s) setSettings(s) }}
              onForgot={() => setSettingsOpen('key')}
            />
          ) : (
          <Composer
            inputRef={inputRef}
            draft={draft}
            setDraft={setDraft}
            running={running}
            onSend={() => void send(draft)}
            onStop={stop}
            openPage={props.openPage}
            includePage={includePage}
            setIncludePage={setIncludePage}
            picker={
              <ModelPicker
                model={model}
                effort={effort}
                disabled={running}
                onChange={(m, e) => setPick({ model: m, effort: e })}
                isDefault={model === (settings.default_model || DEFAULT_MODEL) && effort === (isEffort(settings.default_effort) ? settings.default_effort : DEFAULT_EFFORT)}
                onMakeDefault={async () => setSettings(await saveAISettings({ default_model: model, default_effort: effort }))}
                onRefresh={keyReady ? () => refreshModels(client, true) : undefined}
              />
            }
            autoApply={autoApply}
            setAutoApply={setAutoApply}
            approvingAll={chat ? isApprovingAll(chat.meta.id) : false}
            onStopApprovingAll={() => { if (chat) { setApprovingAll(chat.meta.id, false); rerender() } }}
            chat={chat}
          />
          )}
        </>
      )}

      {settingsOpen && settings && (
        <AISettingsDialog
          settings={settings}
          focusKey={settingsOpen === 'key'}
          onClose={() => setSettingsOpen(false)}
          onSaved={(s) => { setSettings(s); briefRef.current = null }}
        />
      )}
    </aside>
  )
}

// ── pieces ───────────────────────────────────────────────────────────────────

function IconBtn({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="p-1.5 rounded-md text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:bg-[var(--notation-bg-alt)] disabled:opacity-40 disabled:pointer-events-none"
    >
      {children}
    </button>
  )
}

function Banner({ kind, children, onDismiss, className = '' }: { kind: 'error' | 'info'; children: React.ReactNode; onDismiss?: () => void; className?: string }) {
  return (
    <div className={`flex items-start gap-2 rounded-md px-2.5 py-2 text-[12px] mb-2 ${kind === 'error' ? 'bg-[color-mix(in_srgb,var(--notation-danger)_12%,transparent)] text-[var(--notation-danger)]' : 'bg-[var(--notation-bg-alt)] text-[var(--notation-fg-muted)]'} ${className}`}>
      <span className="flex-1 min-w-0 break-words">{children}</span>
      {onDismiss && <button onClick={onDismiss} aria-label="Dismiss" className="opacity-70 hover:opacity-100"><X size={12} /></button>}
    </div>
  )
}

function relTime(iso: string): string {
  const d = new Date(iso)
  const diff = (Date.now() - d.getTime()) / 1000
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`
  if (diff < 7 * 86400) return d.toLocaleDateString(undefined, { weekday: 'short' })
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })
}

function HistoryMenu({
  chats, currentId, disabled, onPick, onDelete, onClose,
}: {
  chats: ChatMeta[] | null
  currentId?: string
  disabled: boolean
  onPick: (m: ChatMeta) => void
  onDelete: (m: ChatMeta) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [q, setQ] = useState('')
  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [onClose])
  const shown = (chats ?? []).filter(m => m.messageCount > 0 && (!q || m.title.toLowerCase().includes(q.toLowerCase())))
  return (
    <div ref={ref} role="menu" className="absolute left-0 top-full mt-1 w-[min(340px,85vw)] max-h-[60vh] flex flex-col bg-[var(--notation-bg-elevated)] border border-[var(--notation-border)] rounded-lg shadow-xl z-50 overflow-hidden">
      {(chats?.length ?? 0) > 6 && (
        <input
          autoFocus
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search chats…"
          className="m-2 mb-1 px-2 py-1 text-[12.5px] rounded-md border border-[var(--notation-border)] bg-[var(--notation-bg)] outline-none"
        />
      )}
      <div className="overflow-y-auto py-1">
        {chats === null ? (
          <div className="px-3 py-2 text-[12px] text-[var(--notation-fg-muted)]">Loading…</div>
        ) : shown.length === 0 ? (
          <div className="px-3 py-2 text-[12px] text-[var(--notation-fg-muted)]">{q ? 'No match.' : 'No chats in this Space yet.'}</div>
        ) : shown.map(m => (
          <div key={m.id} className={`group flex items-center gap-1 px-1.5 ${m.id === currentId ? 'bg-[var(--notation-accent-10)]' : ''}`}>
            <button
              disabled={disabled}
              onClick={() => onPick(m)}
              className="flex-1 min-w-0 text-left px-1.5 py-1.5 rounded-md hover:bg-[var(--notation-bg-alt)] disabled:opacity-50"
            >
              <div className="text-[12.5px] truncate">{m.title}</div>
              <div className="text-[10.5px] text-[var(--notation-fg-muted)]">
                {relTime(m.updatedAt)} · {modelInfo(m.model).label.replace('Claude ', '')} · ≈{formatCost(m.usage?.cost ?? 0)}
              </div>
            </button>
            <button
              onClick={() => onDelete(m)}
              className="p-1 rounded opacity-0 group-hover:opacity-100 focus:opacity-100 text-[var(--notation-fg-muted)] hover:text-[var(--notation-danger)]"
              aria-label={`Delete chat ${m.title}`}
              title="Delete chat"
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function EmptyState({
  openPage, encrypted, skills, onPrompt,
}: {
  openPage: string
  encrypted: boolean
  skills: Brief['skills']
  onPrompt: (text: string, sendNow: boolean) => void
}) {
  const page = openPage ? openPage.split('/').pop() : ''
  const ideas: { label: string; text: string; send: boolean }[] = []
  if (openPage) {
    ideas.push({ label: `Summarize ${page}`, text: 'Summarize this page in a few bullet points.', send: true })
    ideas.push({ label: 'Link related pages', text: 'Find pages in this Space that relate to this page and add wiki-links between them where it helps.', send: false })
    ideas.push({ label: 'Proofread this page', text: 'Proofread this page: fix spelling, grammar and unclear sentences, without changing its meaning or structure.', send: false })
  }
  ideas.push({ label: 'Overview of this Space', text: 'Give me a short overview of this Space: what is in it and how it is organised.', send: true })
  ideas.push({ label: 'Draft a new page…', text: 'Create a new page about ', send: false })
  return (
    <div className="flex flex-col gap-3 py-2">
      <div>
        <div className="text-[14px] font-semibold flex items-center gap-1.5"><Sparkles size={14} className="text-[color:var(--notation-accent)]" /> What can Claude do here?</div>
        <p className="text-[12.5px] text-[var(--notation-fg-muted)] mt-1 leading-relaxed">
          Ask about the pages, or have Claude write and reorganise them. You see every change as a diff before it is applied, and can undo it afterwards.
          {encrypted && ' This Space is encrypted: the conversation goes from this tab to Claude directly and is stored sealed.'}
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        {ideas.map(i => (
          <button
            key={i.label}
            onClick={() => onPrompt(i.text, i.send)}
            className="text-left text-[12.5px] px-2.5 py-1.5 rounded-md border border-[var(--notation-border)] hover:border-[color:var(--notation-accent-50)] hover:bg-[var(--notation-bg-alt)] truncate"
          >
            {i.label}
          </button>
        ))}
      </div>
      {skills.length > 0 && (
        <div>
          <div className="text-[11px] uppercase tracking-wide text-[var(--notation-fg-muted)] mb-1">Skills</div>
          <div className="flex flex-wrap gap-1.5">
            {skills.map(s => (
              <button
                key={s.source + s.path}
                onClick={() => onPrompt(`Use the skill “${s.name}” to `, false)}
                title={s.description}
                className="text-[12px] px-2 py-0.5 rounded-full bg-[var(--notation-accent-10)] hover:bg-[var(--notation-accent-20)]"
              >
                {s.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── messages ─────────────────────────────────────────────────────────────────

type AnyBlock = BetaContentBlock | BetaContentBlockParam

function blocksOf(content: string | AnyBlock[]): AnyBlock[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content
}

const isContextBlock = (b: AnyBlock) => b.type === 'text' && b.text.startsWith(`<${CONTEXT_TAG}>`)

function pageFromContext(b: AnyBlock | undefined): string | null {
  if (!b || b.type !== 'text') return null
  const m = /^Open page: (.+)$/m.exec(b.text)
  return m ? m[1] : null
}

const Messages = memo(function Messages({
  chat, files, running, pendingId, pendingRecord, undoable, onDecide, onUndo, onNavigate,
}: {
  chat: Chat
  /** Changes whenever the chat (mutated in place) does; drives the memo. */
  rev: number
  files: string[]
  running: boolean
  pendingId?: string
  pendingRecord?: PendingApproval['record']
  undoable: Map<string, () => Promise<void>>
  onDecide: (d: ApprovalDecision) => void
  onUndo: (id: string) => Promise<void>
  onNavigate: (path: string) => void
}) {
  const { messages, tools, notices } = chat.body
  const out: React.ReactNode[] = []
  messages.forEach((m, i) => {
    const blocks = blocksOf(m.content as string | AnyBlock[])
    if (m.role === 'user') {
      blocks.forEach((b, j) => {
        if (b.type !== 'text' || isContextBlock(b)) return
        const page = pageFromContext(blocks[j + 1])
        out.push(<UserBubble key={`${i}.${j}`} text={b.text} page={page} onNavigate={onNavigate} />)
      })
    } else {
      blocks.forEach((b, j) => {
        const key = `${i}.${j}`
        if (b.type === 'text') {
          if (b.text.trim()) out.push(<AssistantText key={key} text={b.text} files={files} onNavigate={onNavigate} />)
        } else if (b.type === 'thinking') {
          if (b.thinking.trim()) out.push(<Thinking key={key} text={b.thinking} />)
        } else if (b.type === 'tool_use') {
          if (b.id === pendingId && pendingRecord) {
            out.push(<ApprovalCard key={key} record={pendingRecord} onDecide={onDecide} />)
          } else {
            out.push(
              <ToolCard
                key={key}
                name={b.name}
                record={tools[b.id]}
                running={running}
                canUndo={!running && undoable.has(b.id)}
                onUndo={() => onUndo(b.id)}
                onOpen={onNavigate}
              />,
            )
          }
        } else if (b.type === 'fallback') {
          const to = (b as { to?: { model?: string } }).to?.model
          out.push(<div key={key} className="text-[11px] text-[var(--notation-fg-muted)] italic py-0.5">Answered by {to ? modelInfo(to).label : 'another model'} (fallback)</div>)
        }
      })
    }
    for (const [k, n] of notices.entries()) {
      if (n.after === i) out.push(<NoticeLine key={`n${k}`} n={n} />)
    }
  })
  return <div className="flex flex-col gap-1.5">{out}</div>
})

function UserBubble({ text, page, onNavigate }: { text: string; page: string | null; onNavigate: (p: string) => void }) {
  return (
    <div className="flex flex-col items-end gap-0.5 my-1.5">
      <div className="max-w-[88%] rounded-2xl rounded-br-md px-3 py-2 bg-[var(--notation-accent-15)] text-[13px] whitespace-pre-wrap break-words">{text}</div>
      {page && (
        <button onClick={() => onNavigate(page)} className="flex items-center gap-1 text-[10.5px] text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] max-w-[88%]" title={`Sent while ${page} was open`}>
          <FileText size={10} /> <span className="truncate">{page}</span>
        </button>
      )}
    </div>
  )
}

function AssistantText({ text, files, onNavigate }: { text: string; files: string[]; onNavigate: (p: string) => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="group relative">
      <ChatMarkdown text={text} files={files} onOpenPage={onNavigate} />
      <button
        onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200) }) }}
        className="absolute -top-1 right-0 p-1 rounded opacity-0 group-hover:opacity-100 focus:opacity-100 text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] bg-[var(--notation-bg-elevated)]"
        title="Copy as Markdown"
        aria-label="Copy reply"
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
    </div>
  )
}

function Thinking({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="text-[12px] text-[var(--notation-fg-muted)]">
      <button onClick={() => setOpen(v => !v)} className="flex items-center gap-1 hover:text-[var(--notation-fg)] py-0.5" aria-expanded={open}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Brain size={12} /> {streaming ? 'Thinking…' : 'Thought process'}
      </button>
      {open && <div className="ml-4 pl-2 border-l border-[var(--notation-border)] whitespace-pre-wrap break-words py-1 leading-relaxed">{text}</div>}
    </div>
  )
}

function NoticeLine({ n }: { n: Notice }) {
  const icon = n.kind === 'error' ? <CircleAlert size={13} /> : n.kind === 'refusal' ? <Ban size={13} /> : n.kind === 'stopped' ? <Square size={11} /> : <Info size={13} />
  const tone = n.kind === 'error' ? 'text-[var(--notation-danger)]' : 'text-[var(--notation-fg-muted)]'
  return <div className={`flex items-start gap-1.5 text-[12px] py-1 ${tone}`}><span className="mt-0.5 flex-shrink-0">{icon}</span><span className="break-words">{n.text}</span></div>
}

function LiveMessage({ msg, files, onNavigate }: { msg: BetaMessage; files: string[]; onNavigate: (p: string) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      {msg.content.map((b, i) => {
        if (b.type === 'text') return b.text ? <ChatMarkdown key={i} text={b.text} files={files} onOpenPage={onNavigate} /> : null
        if (b.type === 'thinking') return <Thinking key={i} text={b.thinking} streaming />
        if (b.type === 'tool_use') {
          const input = (b.input ?? {}) as { path?: unknown; from?: unknown; pattern?: unknown }
          const what = typeof input.path === 'string' ? input.path : typeof input.from === 'string' ? input.from : typeof input.pattern === 'string' ? `“${input.pattern}”` : ''
          return (
            <div key={i} className="flex items-center gap-1.5 text-[12px] text-[var(--notation-fg-muted)] py-0.5 min-w-0">
              <Loader2 size={13} className="animate-spin flex-shrink-0" />
              <span className="truncate">{liveVerb(b.name)}{what ? ` ${what}` : ''}</span>
            </div>
          )
        }
        return null
      })}
    </div>
  )
}

function liveVerb(name: string): string {
  switch (name) {
    case 'write_file': return 'Writing'
    case 'edit_file': return 'Editing'
    case 'read_file': return 'Reading'
    case 'search': return 'Searching'
    case 'move_file': return 'Moving'
    case 'delete_file': return 'Deleting'
    case 'list_files': case 'space_map': return 'Listing'
    case 'load_skill': return 'Loading skill'
    default: return name
  }
}

// ── composer ─────────────────────────────────────────────────────────────────

function Composer({
  inputRef, draft, setDraft, running, onSend, onStop, openPage, includePage, setIncludePage,
  picker, autoApply, setAutoApply, approvingAll, onStopApprovingAll, chat,
}: {
  inputRef: React.RefObject<HTMLTextAreaElement | null>
  draft: string
  setDraft: (s: string) => void
  running: boolean
  onSend: () => void
  onStop: () => void
  openPage: string
  includePage: boolean
  setIncludePage: (v: boolean) => void
  picker: React.ReactNode
  autoApply: boolean
  setAutoApply: (v: boolean) => void
  approvingAll: boolean
  onStopApprovingAll: () => void
  chat: Chat | null
}) {
  // Grow with the text up to ~10 lines.
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [draft, inputRef])

  const usage = chat?.meta.usage
  const ctx = chat?.meta.contextTokens ?? 0
  return (
    <div className="border-t border-[var(--notation-border)] px-2.5 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] flex flex-col gap-1.5">
      {(openPage || approvingAll) && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {openPage && (
            <button
              onClick={() => setIncludePage(!includePage)}
              className={`flex items-center gap-1 max-w-full text-[11px] px-2 py-0.5 rounded-full border ${includePage ? 'border-[color:var(--notation-accent-30)] bg-[var(--notation-accent-10)]' : 'border-[var(--notation-border)] text-[var(--notation-fg-muted)] line-through'}`}
              title={includePage ? 'Claude is told which page you have open. Click to leave it out.' : 'Click to tell Claude which page you have open.'}
            >
              <FileText size={10} className="flex-shrink-0" />
              <span className="truncate">{openPage}</span>
            </button>
          )}
          {approvingAll && (
            <button onClick={onStopApprovingAll} className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-[color-mix(in_srgb,var(--notation-warning)_18%,transparent)]" title="Click to ask again before each change">
              <Zap size={10} /> Applying all changes in this chat <X size={10} />
            </button>
          )}
        </div>
      )}
      <div className="flex items-end gap-1.5 rounded-xl border border-[var(--notation-border)] bg-[var(--notation-bg)] focus-within:border-[color:var(--notation-accent-50)] px-2 py-1.5">
        <textarea
          ref={inputRef}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              if (!running) onSend()
            }
          }}
          rows={1}
          placeholder={running ? 'Claude is working… (Esc to stop)' : chat?.body.messages.length ? 'Reply…' : 'Ask Claude about this Space…'}
          className="flex-1 min-w-0 resize-none bg-transparent outline-none text-[13.5px] leading-[1.45] py-1 max-h-[220px]"
          aria-label="Message to Claude"
        />
        {running ? (
          <button onClick={onStop} className="p-1.5 rounded-lg bg-[var(--notation-fg)] text-[var(--notation-bg)] hover:opacity-85" title="Stop (Esc)" aria-label="Stop">
            <Square size={14} fill="currentColor" />
          </button>
        ) : (
          <button onClick={onSend} disabled={!draft.trim()} className="p-1.5 rounded-lg bg-[color:var(--notation-accent)] text-[var(--notation-fg-on-accent,#fff)] disabled:opacity-35 hover:opacity-90" title="Send (Enter)" aria-label="Send">
            <ArrowUp size={15} />
          </button>
        )}
      </div>
      <div className="flex items-center gap-1 text-[11px] text-[var(--notation-fg-muted)] flex-wrap">
        {picker}
        <label className="flex items-center gap-1 px-1 cursor-pointer hover:text-[var(--notation-fg)]" title="Apply Claude's changes right away instead of asking each time. Every change can still be undone.">
          <input type="checkbox" checked={autoApply} onChange={e => setAutoApply(e.target.checked)} className="accent-[color:var(--notation-accent)]" />
          Auto-apply
        </label>
        {usage && usage.cost > 0 && (
          <span
            className={`ml-auto tabular-nums ${ctx > 200_000 ? 'text-[var(--notation-warning)]' : ''}`}
            title={`Estimated cost of this chat (the Claude Console has the exact figure).\nInput ${formatTokens(usage.input)} · cache read ${formatTokens(usage.cacheRead)} · cache write ${formatTokens(usage.cacheWrite)} · output ${formatTokens(usage.output)}\nContext now: ${formatTokens(ctx)} tokens${ctx > 200_000 ? ' — a long chat costs more per message; consider starting a new one.' : ''}`}
          >
            ≈{formatCost(usage.cost)} · {formatTokens(ctx)}
          </span>
        )}
      </div>
    </div>
  )
}
