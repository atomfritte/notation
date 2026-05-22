import type { ReactNode } from 'react'

type Props = {
  title: string
  subtitle?: string
  children: ReactNode
}

/**
 * AuthShell wraps the claim / passkey-setup / passkey-login screens in a
 * minimal centered card with the notation lockup. Same dark/lime palette as
 * the main app so the transition between auth and the workspace is seamless.
 */
export function AuthShell({ title, subtitle, children }: Props) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-white dark:bg-[#0a0a0a] text-zinc-900 dark:text-zinc-200 p-6">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-3 mb-8">
          <div className="w-9 h-9 rounded-md bg-zinc-900 text-white dark:bg-[color:var(--notation-accent-15)] dark:text-[color:var(--notation-accent)] flex items-center justify-center font-bold text-lg">
            n
          </div>
          <div className="text-lg font-semibold tracking-tight">notation</div>
        </div>
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/50 shadow-sm p-6">
          <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100">{title}</h1>
          {subtitle && (
            <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1.5">{subtitle}</p>
          )}
          <div className="mt-6">{children}</div>
        </div>
      </div>
    </div>
  )
}
