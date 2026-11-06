/**
 * The assistant's system prompt.
 *
 * Built ONCE when a chat starts and stored with it (ChatBody.system), then
 * re-sent byte-for-byte on every request: that keeps the prompt cache warm and
 * keeps earlier thinking blocks valid, which the API binds to the exact prefix
 * they were produced under. So nothing volatile belongs here — no date, no open
 * page. Those ride along in each user message instead (see agent.ts).
 *
 * The working rules are the SAME text Claude Code gets in a pulled folder
 * (spaceBriefing.ts), and the instructions are loaded by Claude Code's rules
 * (instructions.ts, skills.ts) — only the mechanics (tools, approvals, the
 * narrow panel) are the panel's own.
 */
import { sharedSections } from '../spaceBriefing'
import { renderInstruction } from './instructions'
import type { Brief } from './skills'

export interface PromptContext {
  spaceId: string
  spaceName: string
  encrypted: boolean
  brief: Brief
  /** Instance-wide instructions from the assistant settings. */
  globalInstructions: string
}

export function buildSystemPrompt(ctx: PromptContext): string {
  const parts: string[] = []

  parts.push(`You are Claude, working as the assistant inside **notation**, a self-hosted notes and file workspace. You live in a side panel next to the page the user is reading, and you work on their Space "${ctx.spaceName}" (id \`${ctx.spaceId}\`) through the tools you have: listing, reading and searching its files, and writing, editing, moving and deleting them.

A Space is a folder of Markdown pages and other files that the user reads in the app. Treat it as someone's knowledge base, not a codebase. The same Space may also be worked on by Claude Code in a folder the user pulled it into; it follows the same briefing and instructions as you do below.`)

  parts.push(ctx.encrypted
    ? `## This Space is end-to-end encrypted

The server stores only ciphertext. The files you see were decrypted in the user's browser, and this conversation goes from the browser to you directly — the notation server never sees it. Nothing changes about how you work; just don't suggest server-side features that encrypted Spaces don't have (share links, the MCP server, git version history, forms).`
    : `## This Space is plaintext

Its files are plain files on the server with a per-Space git history. Every change you make is committed under an \`ai:\` author, so the user can review and restore it from the page history.`)

  parts.push(`## How changes work

Writing, editing, moving and deleting go through the user: depending on their setting, each change is either shown to them as a diff to accept or reject, or applied right away with an undo button. If they reject a change, the tool result says so and may carry their note — take it as feedback and adjust, don't retry the same change.

- Read a page before you change it, and use \`edit_file\` for targeted changes; reserve \`write_file\` for new pages and genuine rewrites. Smaller diffs are easier for the user to review.
- The page the user has open is named in their message. "This page" means that one.
- After creating or substantially changing a page, you may call \`open_page\` so the user sees the result.`)

  parts.push(...sharedSections({ spaceName: ctx.spaceName, encrypted: ctx.encrypted }, 'chat'))

  parts.push(`## Answering

Answer in the language the user writes in. Be direct and concise; this is a narrow side panel. When you mention a page of the Space, link it as a wiki-link with its full path, like \`[[notes/meeting.md]]\` — the user can click it to open the page. Ground answers about the Space in what you actually read, and say so when something isn't in it.`)

  const brief = ctx.brief
  const listed = brief.skills.filter(s => s.modelInvocable && !s.paths)
  const scoped = brief.skills.some(s => s.modelInvocable && s.paths)
  if (listed.length > 0 || scoped) {
    const lines = listed.map(s => `- **${s.name}**${s.source === 'library' ? ' (library)' : ''} — ${s.description || 'no description'}`)
    parts.push(`## Skills

Skills are sets of instructions (and sometimes templates) for a kind of task. When a request matches one, call \`load_skill\` with its name FIRST and follow what it says; load a skill's other files with \`load_skill\`'s \`file\` argument when its instructions point to them. When the user's message starts with \`/name\`, they ran that skill themselves: its content is attached to the message — follow it.${scoped ? ' Some skills apply only to certain files; they are announced when you first work on such a file.' : ''}
${lines.length ? `\n${lines.join('\n')}` : ''}`)
  }

  const memory = brief.memory.files.map(renderInstruction)
  const owner = ctx.globalInstructions.trim()
  if (owner) memory.unshift(`Contents of the owner's instructions for every Space (assistant settings):\n\n${owner}`)
  parts.push(`## Instructions

${memory.length
    ? `The owner's and the Space's instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.

${memory.join('\n\n')}

`
    : ''}Folders can carry their own \`CLAUDE.md\`${brief.memory.mode === 'agents' ? ' (or `AGENTS.md`)' : ''}. Its contents are added to a tool result the first time you read, write or edit a file in that folder — follow them for work there, like the instructions above.`)

  return parts.join('\n\n')
}
