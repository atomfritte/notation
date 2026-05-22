import { useState } from 'react'
import { Check, Copy, X, AlertTriangle } from 'lucide-react'

type Tab = 'claude' | 'cursor' | 'http'

type Props = {
  open: boolean
  spaceID: string
  url: string
  /** Raw token — present only immediately after creation. Existing tokens are
   *  hashed-only on the server, so the modal renders a placeholder instead. */
  rawToken?: string
  onClose: () => void
}

/**
 * MCPIntegrationModal shows multi-client connection snippets for an MCP
 * endpoint. After a token is created, the modal opens with the raw token so
 * the user can copy and paste into their client config. For pre-existing
 * tokens the modal opens with <PASTE_YOUR_TOKEN> placeholders — the secret
 * cannot be recovered server-side.
 */
export function MCPIntegrationModal({ open, spaceID, url, rawToken, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('claude')

  if (!open) return null
  const token = rawToken ?? '<PASTE_YOUR_TOKEN>'
  const fresh = !!rawToken

  const serverName = `notation-${spaceID}`

  // `claude mcp add` takes the name and URL positionally; --transport and -H
  // are options. `--url` is NOT a valid flag. Project scope so the server
  // shows up in the .mcp.json of the current project (sharable, opt-in).
  const cliClaude = `claude mcp add ${serverName} "${url}" \\
  --transport http \\
  --scope project \\
  --header "Authorization: Bearer ${token}"`

  const claudeJson = JSON.stringify(
    { mcpServers: { [serverName]: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } },
    null,
    2,
  )

  const cursorJson = JSON.stringify(
    { mcpServers: { [serverName]: { url, headers: { Authorization: `Bearer ${token}` } } } },
    null,
    2,
  )

  const curlSnippet = `# List tools the MCP server exposes
curl -X POST '${url}' \\
  -H "Authorization: Bearer ${token}" \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--notation-backdrop)] backdrop-blur-sm animate-in fade-in duration-100 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl bg-white bg-[var(--notation-bg-alt)] border border-[var(--notation-border)] rounded-xl shadow-2xl overflow-hidden animate-in slide-in-from-bottom-4 duration-150 flex flex-col max-h-[90vh]"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--notation-border)]">
          <div>
            <h2 className="text-lg font-semibold text-[var(--notation-fg)]">
              Connect MCP client
            </h2>
            <p className="text-xs text-[var(--notation-fg-muted)] mt-0.5">
              Give Claude Code (or any MCP client) read+write access to{' '}
              <span className="font-mono text-[var(--notation-fg)]">{spaceID}</span>.
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)] hover:text-[var(--notation-fg)] p-1 rounded-md"
          >
            <X size={18} />
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-4 space-y-4">
          {fresh && (
            <div className="border border-[var(--notation-warning)] dark:border-[var(--notation-warning)]/50 bg-[var(--notation-warning)] dark:bg-[var(--notation-warning)]/30 rounded-md p-3">
              <div className="flex items-start gap-2">
                <AlertTriangle size={14} className="text-[var(--notation-warning)] dark:text-[var(--notation-warning)] mt-0.5 flex-shrink-0" />
                <div className="text-xs">
                  <div className="font-semibold text-[var(--notation-warning)] dark:text-[var(--notation-warning)] mb-0.5">
                    Save this token now
                  </div>
                  <div className="text-[var(--notation-warning)] dark:text-[var(--notation-warning)]">
                    The token is shown once. After closing this dialog it cannot be recovered — revoke
                    and create a new one if lost.
                  </div>
                </div>
              </div>
            </div>
          )}

          <Field label="Endpoint URL" value={url} mono />
          <Field
            label={fresh ? 'Token (one-time)' : 'Token'}
            value={token}
            mono
            secret={!fresh}
          />

          <div>
            <div className="flex items-center gap-1 border-b border-[var(--notation-border)] mb-3">
              {(['claude', 'cursor', 'http'] as const).map(t => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={
                    'px-3 py-1.5 text-sm font-medium border-b-2 -mb-px transition-colors ' +
                    (tab === t
                      ? 'border-[var(--notation-border)] dark:border-[color:var(--notation-accent)] text-[var(--notation-fg)] dark:text-[color:var(--notation-accent)]'
                      : 'border-transparent text-[var(--notation-fg-muted)] hover:text-[var(--notation-fg)]')
                  }
                >
                  {t === 'claude' ? 'Claude Code' : t === 'cursor' ? 'Cursor' : 'Raw HTTP'}
                </button>
              ))}
            </div>

            {tab === 'claude' && (
              <div className="space-y-3">
                <div>
                  <p className="text-xs text-[var(--notation-fg-muted)] mb-1.5">Quick add via CLI:</p>
                  <CodeBlock value={cliClaude} />
                </div>
                <div>
                  <p className="text-xs text-[var(--notation-fg-muted)] mb-1.5">
                    Or paste into <code className="bg-[var(--notation-bg-alt)] px-1 rounded">.mcp.json</code>{' '}
                    (project) or{' '}
                    <code className="bg-[var(--notation-bg-alt)] px-1 rounded">~/.claude/mcp.json</code>{' '}
                    (global):
                  </p>
                  <CodeBlock value={claudeJson} />
                </div>
              </div>
            )}

            {tab === 'cursor' && (
              <div className="space-y-3">
                <p className="text-xs text-[var(--notation-fg-muted)]">
                  Add to <code className="bg-[var(--notation-bg-alt)] px-1 rounded">~/.cursor/mcp.json</code>{' '}
                  (global) or <code className="bg-[var(--notation-bg-alt)] px-1 rounded">.cursor/mcp.json</code>{' '}
                  in your project root. Restart Cursor after saving.
                </p>
                <CodeBlock value={cursorJson} />
              </div>
            )}

            {tab === 'http' && (
              <div className="space-y-3">
                <p className="text-xs text-[var(--notation-fg-muted)]">
                  The endpoint speaks JSON-RPC 2.0 over plain HTTP. Useful for debugging or building
                  your own integration. Example list-tools call:
                </p>
                <CodeBlock value={curlSnippet} />
                <p className="text-xs text-[var(--notation-fg-muted)]">
                  Tools the server exposes:{' '}
                  <code>list_files</code>, <code>get_tree</code>, <code>glob</code>, <code>outline</code>,{' '}
                  <code>read_file</code>, <code>write_file</code>, <code>create_file</code>,{' '}
                  <code>delete_file</code>, <code>rename_file</code>, <code>mkdir</code>,{' '}
                  <code>search</code>, <code>grep</code>, <code>git_log</code>, <code>git_diff</code>.
                </p>
              </div>
            )}
          </div>
        </div>

        <div className="px-5 py-3 border-t border-[var(--notation-border)] flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 text-sm font-medium bg-[var(--notation-accent)] text-[var(--notation-fg-on-accent)] rounded-md hover:bg-[var(--notation-bg-alt)] dark:hover:bg-[#a6d944] transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, value, mono, secret }: { label: string; value: string; mono?: boolean; secret?: boolean }) {
  return (
    <div>
      <div className="text-xs text-[var(--notation-fg-muted)] mb-1">{label}</div>
      <div className="flex items-center gap-2 bg-[var(--notation-bg-elevated)] bg-[var(--notation-bg-elevated)]/50 border border-[var(--notation-border)] rounded-md px-3 py-2">
        <code className={`flex-1 break-all text-[var(--notation-fg)] text-xs select-all ${mono ? 'font-mono' : ''} ${secret ? 'opacity-70 italic' : ''}`}>
          {value}
        </code>
        {!secret && <CopyButton value={value} />}
      </div>
    </div>
  )
}

function CodeBlock({ value }: { value: string }) {
  return (
    <div className="relative group">
      <pre className="bg-[var(--notation-bg-elevated)] text-[var(--notation-fg)] rounded-md p-3 text-xs overflow-x-auto font-mono leading-relaxed border border-[var(--notation-border)]">
        <code>{value}</code>
      </pre>
      <div className="absolute top-2 right-2 opacity-60 hover:opacity-100 transition-opacity">
        <CopyButton value={value} />
      </div>
    </div>
  )
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  function onCopy() {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    })
  }
  return (
    <button
      onClick={onCopy}
      className="p-1.5 bg-[var(--notation-bg-alt)] bg-[var(--notation-bg-alt)] text-[var(--notation-fg-muted)] hover:text-white rounded-md transition-colors"
      aria-label="Copy"
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  )
}
