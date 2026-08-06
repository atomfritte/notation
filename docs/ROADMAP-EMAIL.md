# Roadmap: Email ↔ Space

Email is where most knowledge work actually happens, and it is the one place notes
never reach: the decision lives in a thread, the note lives in a Space, and nothing
connects them. Every tool that tried to fix this either becomes a mail client
(Hey, Superhuman) or swallows your mail into a cloud SaaS (Notion Mail, Missive).

Notation can do the thing neither does: **treat a mail conversation as a linkable
object inside a git-versioned, self-hosted Space** — without hosting mail, without
an MTA, and without a third party ever seeing the note it belongs to.

Four pillars, in dependency order:

0. **The primitive** — a stable, offline-safe identifier for a conversation
1. **The link** — emails become first-class link targets, like pages
2. **The mirror** — optional ingest of the content, on the user's terms
3. **The conversation** — replies map onto notation's comment thread

Standing principles (same spirit as the TTS rule and `ROADMAP-AI.md`):

- **A link is not a copy.** The reference alone (Phase 1) must be useful with zero
  mail content stored. Mirroring is opt-in per alias, per space.
- **No mail credentials in notation by default.** The recommended ingest path runs
  *outside* the container and pushes in through the existing space-scoped MCP token.
- **Inbound mail is untrusted input** — a new threat class for this codebase. It
  lands in quarantine, never in the tree root, and never as raw HTML.
- **Zero-knowledge stays zero-knowledge.** Server-side ingest is impossible for an
  encrypted Space by construction; those get a client-side path, not an exception.
- **Every ingest is auditable** — a new `mail:<alias-id>` actor alongside
  `admin:` / `guest:` / `mcp:` (`internal/share/audit.go`).

---

## Phase 0 — The primitive: a Message-ID, not a URL

Gmail's visible URLs (`#inbox/<hex>`) are per-account and rotate. The durable handle
is the RFC 5322 **Message-ID**, and Gmail exposes a permanent search entry point for
it, no API and no auth token involved:

```
https://mail.google.com/mail/u/0/#search/rfc822msgid%3A<urlencoded-id>
```

So the entire link is *text in frontmatter* — it survives git, export, the sync
folder and encryption, and it works when notation has no idea Gmail exists:

```yaml
---
title: Rahmenvertrag – Angebot
email:
  msgid: "CADq8xyz@mail.gmail.com"        # this message, angle brackets stripped
  thread_msgid: "CAB1abc@mail.gmail.com"  # first message of the thread = thread handle
  subject: "Re: Rahmenvertrag – Angebot"
  from: "Kunde <kunde@firma.de>"
  to: ["me@example.com"]
  date: 2026-08-04T09:12:00+02:00
  labels: ["notation/kunden"]
  mirror: full                            # full | headers-only
  provenance: untrusted-inbound
---
```

Deliverables: the frontmatter schema above (documented once, parsed in one place),
a `msgid → deep link` helper, and canonicalisation (strip `<>`, encode `+` and `@`).

Known wrinkles to solve here, not later:

- **`u/0` is not everyone's account.** Make the account index configurable
  (`NOTATION_MAIL_ACCOUNT_INDEX`, default `0`); `?authuser=<address>` is the
  alternative when the index is unstable.
- **Provider-agnostic from day one.** `rfc822msgid:` is a Gmail search operator, but
  the stored data is pure RFC 5322. A `mailto:`/IMAP-URL fallback keeps the schema
  honest for anyone not on Gmail.

## Phase 1 — The link (no ingest, no backend)

This is the whole feature for reference-only users, and it is almost entirely
frontend.

- **`mail:` as a link scheme in the markdown renderer.** `MarkdownView.tsx`'s anchor
  renderer already branches on `https?://` / `mailto:` / `#` / `?file=` / `/` / `//`
  / relative (around the `a: ({ href, … })` component). A `mail:` branch slots in
  beside them: `[Angebot](mail:CADq8xyz@mail.gmail.com)` resolves to the mirrored
  page if one exists, otherwise straight to Gmail.
- **Reverse resolution via the existing index.** `buildFileIndex` /
  `resolveTarget` (`admin/lib/wikiLinks.ts`) already power wiki-links for both SPAs
  and the encrypted backlinks scanner. Extend the index with a `msgid → path` bucket
  built from frontmatter and `mail:` links resolve exactly like `[[wiki-links]]`.
- **"Open in Gmail" affordance** on any page carrying an `email:` block — plus a
  compact header card (From / Date / Subject) rendered from frontmatter.
- **Backlinks for free.** Because the msgid is plain text, the existing `search` /
  `grep` answers "which pages belong to this conversation?" without a new index.
- **Share-scope rule**: hide the Gmail affordance for guests. A guest cannot open
  that mailbox anyway, and the msgid is metadata that has no business leaving.
  Enforced server-side like every other share feature, not by hiding a button.

## Phase 2 — Ingest (the real fork in the road)

Three paths, and the choice is a security/convenience trade, not a technical one:

| Path | How | Trade |
|---|---|---|
| **Claude + MCP** | Gmail connector reads the thread, notation's MCP server writes the page (`mkdir` + `create_file`) | Works **today, zero code**. Manual, one thread at a time. |
| **Gmail label → Apps Script** *(recommended v1)* | Label `notation/<space>`, timer-triggered Apps Script POSTs MCP JSON-RPC to `NOTATION_MCP_PATH` with a space-scoped Bearer token | No MTA, no IMAP, **no mail credentials in notation**. Token is per-Space by construction (`internal/mcptoken`). Google runs the cron. |
| **Backend IMAP poll** | Backend polls a dedicated mailbox, routes on `space+<token>@…` in `Delivered-To` | Most integrated, works without Google scripting, and IMAP `X-GM-THRID` gives a direct thread link. Costs a credential store and a new inbound trust boundary. |

Regardless of path, the landing shape is the same:

- **Quarantine, not the tree.** Pages land in `_inbox/` — the same convention
  `ROADMAP-AI.md` Phase 3 defines for external agents. One badge, one review flow,
  two producers.
- **One page per thread, replies appended** (not one page per message), keyed on
  `thread_msgid`. Re-ingesting a thread must be idempotent.
- **HTML → markdown server-side.** Never render inbound HTML, not even sanitised;
  convert, then treat the result as ordinary untrusted markdown on the existing
  DOMPurify path.
- **Attachments as sibling files**, filenames sanitised through the existing
  FS-sandbox rules, capped by `NOTATION_MAX_UPLOAD_BYTES`.
- **`mirror: headers-only` is a first-class mode**, not a degraded one: metadata and
  a link, body stays in Gmail. For a lot of threads that is the *correct* privacy
  answer.

## Phase 3 — The mailbox index (no new data model)

A Form folder is already "a folder that renders as structured entries", with entries
stored as sibling markdown files and field types covering `email`, `url`, `date`,
`select`, `multiselect`, `text` (`internal/space/form.go`, `forms_guide`). So the
mailbox view is an authored `_form.md`, not a feature:

- **`Postfach/_form.md`** with From / Date / Thread / Status / Tags → sortable,
  filterable thread list for free, each entry linking its mirrored page.
- **Status as workflow** (`select: neu, wartet, erledigt`) turns the index into a
  lightweight follow-up tracker — the thing people actually keep a separate app for.
- Ingest writes Form entries, so the admin's existing entry edit/delete works
  unchanged.

## Phase 4 — The conversation

The part no note tool has, and notation is one small step from:

- **Replies as comments.** A mirrored page's new replies append to the page's
  *comment* thread (`shared/vfs/commentLog.ts`, anchored, CRDT op-log). A mail
  conversation maps onto notation's comment model nearly 1:1 — including in
  encrypted Spaces, where comments are already encrypted end-to-end.
- **Reply without sending mail.** A Gmail compose deep-link
  (`…/mail/?view=cm&fs=1&to=…&su=…&body=…`) opens a prefilled draft in the user's
  own client. Notation gets a reply button and still never speaks SMTP.
- **Quote a page into a thread.** The inverse direction: attach a Magic Link to a
  reply and record the outbound share on the page, so the trace is bidirectional.

## Phase 5 — Encrypted Spaces & mobile

- **Client-side `.eml` import.** For an encrypted Space the server cannot ingest —
  it only ever holds ciphertext. Parsing must happen in the browser: drop an `.eml`
  (or a `.mbox`) onto the Space, parse and encrypt client-side, write through the
  VFS. Same code path serves plaintext Spaces as a no-credentials manual import.
- **`.eml` in the universal viewer.** A new `viewers/EmailView.tsx` beside
  `WordView` / `SpreadsheetView` in `FileViewer.tsx`'s extension dispatch: headers,
  collapsed quoted text, inline attachments. Makes an archived `.eml` readable
  instead of a download link — and gives the sync folder a lossless archive format.
- **Local fetcher → sync folder.** The laziest ingest of all: a small local script
  drops `.eml` files into a synced folder, push handles the rest. No server change,
  encryption-compatible, and the 3-way manifest already prevents double-imports.
- **PWA share target** (`ROADMAP-AI.md` Phase 4) as the mobile capture path — with
  the honest caveat that the Gmail app shares subject and text, usually *not* a
  Message-ID, so mobile capture degrades to `headers-only` plus a manual link.

## Security model

Inbound mail is the first *unauthenticated, attacker-chosen* input this codebase
would accept. That deserves its own review, not a footnote:

- **The ingest address is a credential.** High-entropy per-space alias
  (`space+<token>@…`), revocable, rate-limited per alias, with a total-size cap and
  an optional sender allowlist. Anyone who learns it can write into that Space.
- **Prompt injection is the sharp edge.** An email is the ideal vector to steer an
  agent that later reads the Space. `provenance: untrusted-inbound` must be visible
  to agent flows, and `ROADMAP-AI.md`'s prompt-injection containment must treat
  mail-sourced content as hostile by default — an ingested page must never be able
  to talk an agent into a cross-space call.
- **Stored XSS**: HTML mail, display names, subjects and attachment filenames are
  all guest-controlled strings landing in the same sinks the isolation audit already
  covers for comments and form entries. Add them to that audit's checklist.
- **Credentials, if we ever hold them**: IMAP secrets belong in the existing
  `authstore` pattern, never in a Space, never in git. The Apps Script path exists
  specifically so v1 holds none.
- **Audit + git**: every ingest is a commit by `mail:<alias-id>` and an audit entry,
  so "what did the mailbox write into my notes?" is answerable and revertible.

## Sequencing

| Step | Why this order | Rough effort |
|---|---|---|
| Frontmatter schema + msgid canonicalisation | the primitive everything else reads | ~1 day |
| `mail:` scheme + resolver + "Open in Gmail" | 80 % of the value, frontend-only | 2–3 days |
| Apps Script ingest into `_inbox/` | no credentials, no backend | 2–3 days |
| `Postfach` Form template + docs | zero new code, pure authoring | ~1 day |
| `.eml` viewer + client-side import | unblocks encrypted Spaces | ~1 week |
| Replies as comments | the unique part; needs stable ingest first | 1–2 weeks |
| Backend IMAP ingest | only if the Apps Script path proves too fiddly | 1–2 weeks |

## Non-goals

- **Notation is not a mail client.** No unified inbox, no folder management, no
  read/unread sync.
- **No SMTP, no MTA in the container.** Sending stays a compose deep-link into the
  user's own client.
- No OAuth-scope creep: read-only access to the labelled subset, never full mailbox
  read as a convenience.
- No automatic ingest of an entire mailbox — labels/aliases mean the user chooses
  what crosses the boundary, one thread at a time.
- No mail content leaving the box (the TTS rule applies unchanged: an ingested
  thread is note content, and third-party AI stays opt-in).

## Open questions

- **One page per thread vs. one per message** — the roadmap assumes per-thread, but
  long threads with distinct decisions may want per-message pages plus an index page.
- **Does `thread_msgid` survive forwarding chains?** A forwarded thread starts a new
  Message-ID lineage; Gmail's `X-GM-THRID` (IMAP-only) is more reliable and is an
  argument for the IMAP path.
- **Attachment dedup** across re-ingest and across threads — content-hash naming, or
  accept duplicates?
