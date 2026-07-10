# Roadmap: Notation as an AI-native note tool

Notation's unique position: **self-hosted + git-versioned + MCP-native + local AI**.
Notion/Mem/Reflect are cloud-AI (your notes live on their servers). Obsidian is local
but AI is plugin chaos. Nobody combines all four. This roadmap turns that position
into the product.

Three pillars, built on one non-negotiable foundation:

0. **Security & isolation** — spaces are hard security boundaries; sharing is scoped and auditable
1. **AI reads your notes** — semantic search, RAG Q&A with citations
2. **AI writes with you** — editor assistance, auto-linking, capture pipeline
3. **Agents work in your notes** — MCP as a first-class interface, reviewable via git + audit log

Standing principles (mirroring the TTS rule — text never leaves the box without consent):

- **Local by default.** Ollama/ONNX in-container is the recommended setup; cloud
  providers (Anthropic API, OpenAI-compatible) are explicit opt-in per instance.
- **No AI feature without an off switch**, per instance and per space.
- **Every AI/agent action is audit-logged**; every AI edit is a git commit with its
  own author prefix (`ai:` alongside the existing `admin:`/`guest:`/`mcp:`).
- **No silent writes.** AI output lands as a diff/suggestion the human accepts.

---

## Pillar 0 — Security & isolation (continuous, starts now)

Workspace isolation is the product's trust anchor. Everything below ships alongside,
not after, the AI work.

- **Page/folder-scoped shares** *(in progress)*: a magic link can expose a single
  page or subtree instead of the whole space. Scope is enforced server-side on every
  share endpoint (file, tree, search, comments, forms) — not hidden client-side.
- **Recurring adversarial isolation audit**: path traversal on every path-taking
  endpoint, MCP token↔space binding, TTS/service-worker cache scoping, share-token
  resolution, stored-XSS via guest-controlled content (comments, filenames, form
  entries). Findings get fixed before feature work continues.
- **AI-era hardening** (as pillars 1–3 land): embedding indexes stored inside the
  space's `.notation/` (never global), RAG strictly scoped to the token's space —
  a share-scoped "ask" must only retrieve within its scope; prompt-injection
  containment for agent flows (untrusted note content must not steer an agent into
  cross-space calls); AI provider calls logged in the audit chain.

## Phase 1 — Foundation: retrieval

- **AI provider abstraction** (`internal/ai`): one interface for chat + embeddings;
  adapters for Ollama (local, default), Anthropic API, OpenAI-compatible endpoints.
  No provider configured → AI features invisible everywhere (graceful degradation).
- **Real full-text search**: Bleve index (pure Go, fits the single-binary design)
  with ranking, replacing substring-walk as the primary path. Immediate win even
  without AI.
- **Semantic index**: chunking along headings (reuse `map`/`outline` +
  `markdownChunks`), local embeddings, per-space vector store under `.notation/`,
  incremental re-index on the existing save hook.
- **Hybrid search UI**: `Cmd+Shift+F` merges keyword + semantic hits with section
  anchors.

## Phase 2 — "Ask your notes"

- **RAG chat panel** per space: answers always cite page + section (clickable via
  the existing wiki-link resolver + heading anchors). Streaming via SSE.
- **Answer → note**: save any answer as a page or insert into the current page.
- **Share-scoped Q&A**: "Ask this space/page" as a per-share feature toggle next to
  `outline`/`search`/`print`. Guests can query exactly what the share scope exposes —
  nothing more. A capability no cloud competitor offers self-hosted.

## Phase 3 — Agent-native (the moat)

- **MCP expansion**: `semantic_search` + `ask` tools, comments read/write, form
  entries; MCP resources (pages as resources) and MCP prompts, not just tools.
- **Agent review feed**: all `mcp:`/`ai:` edits surface as "agent changed N pages"
  with diff view and one-click revert. Git history, diff UI and audit log already
  exist — this is mostly frontend, and it solves the trust problem of letting
  agents into your notes.
- **Scheduled agent jobs**: daily digest, weekly review, orphaned-notes report —
  generated as pages, provider-agnostic, cron in the backend.
- **Agent inbox convention**: a defined `_inbox/` landing zone for external agents,
  with a UI badge — makes the "notes, files, and AI sessions" claim real.

## Phase 4 — Capture: everything becomes a note

- **Voice → text**: whisper.cpp in-container (same pattern as Piper: local, CPU).
  Record in the PWA, transcript as markdown with the audio attached. Combined with
  read-aloud, Notation becomes fully bidirectional audio.
- **PWA share target**: share URLs/text/images from the phone straight into an
  inbox space. Small change, huge mobile win.
- **Web clipping with AI cleanup**: shared URL fetched server-side, distilled to
  clean markdown, auto-tagged and auto-linked.
- **OCR (Tesseract, local)** for images + index PDF/DOCX text so attachments are
  searchable and RAG-visible.

## Phase 5 — AI in the editor

- **Selection actions** in the existing Monaco selection toolbar: rewrite, shorten,
  translate, change tone, continue — always as a diff preview (Monaco diff exists),
  applied via `executeEdits` (editor stays uncontrolled, see #64).
- **Auto-link suggestions**: on save, the embedding index proposes `[[wiki-links]]`
  to related pages (suggest, never auto-apply).
- **Related-notes panel** next to backlinks: semantically similar pages without an
  explicit link.
- **`/ai` command** in the palette for free-form prompts with page context.

## Phase 6 — Knowledge organization & polish

- **Graph view** (per-page local graph + space graph) from wiki-links + semantic edges.
- **AI gardener** (on-demand): duplicate/merge candidates, generated MOC/overview
  pages, stale-note reports.
- **Templates + daily notes** with AI pre-fill (day starts with the digest).
- Housekeeping: drop the committed 35 MB binary + `dist/` from git, fix README
  drift (Go badge, `replace_in_file` missing from the MCP table), real hero screenshot.
- Quality benchmarks per release: index timings + a fixed Q&A test set for RAG.

## Sequencing

| Step | Why this order | Rough effort |
|---|---|---|
| Page/folder-scoped shares + isolation audit | trust anchor; explicitly requested | ~1 week |
| Provider abstraction (`internal/ai`) | prerequisite for everything | ~1 week |
| Bleve full-text + embeddings + hybrid UI | biggest single lever | 2–3 weeks |
| RAG chat + share-scoped Q&A | the visible "wow" | 2 weeks |
| Agent review feed | unique, cheap (infra exists) | ~1 week |
| Share target + whisper.cpp capture | mobile capture | 1–2 weeks |
| Editor AI | after retrieval is solid | 2 weeks |
| Phase 6 | continuous | — |

## Non-goals

- LLM hosting inside the main container (Ollama stays a sidecar, like Kokoro).
- In-browser LLMs (the vits-web experiment showed why).
- Auto-applied AI edits without review.
- Any feature that sends note content to a third party without explicit opt-in.
