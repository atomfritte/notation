/**
 * pageOrder — the single, testable definition of "which pages, in what order"
 * for a Space. It is a depth-first flatten of the {@link Entry} tree in the
 * exact order the FileTree renders (files before subfolders, then case-folded
 * by name — see {@link fsToEntries} / the server tree), so a derived list
 * (prev/next nav, the whole-space PDF, the jump palette) always matches the
 * visible menu.
 *
 * Callers pick the granularity:
 *   - `markdownOnly: true`  → the navigable *pages* (`.md` / `.mdx` /
 *     `.markdown`), which is what prev/next nav and the whole-space PDF walk.
 *   - `markdownOnly: false` → every file of any type (used for link resolution
 *     and the client-side ZIP's logical-path set).
 */
import type { Entry } from './api'
import { isMarkdownFile } from './fileTypes'

/**
 * Depth-first flatten of the tree into a flat path list, in menu order.
 * `markdownOnly` keeps it to markdown pages; `false` includes every file.
 * Form folders (a dir with a `_form.md` template) carry no `children`, so they
 * contribute nothing here — they are not printable pages.
 */
export function collectPages(entries: Entry[], markdownOnly: boolean): string[] {
  const out: string[] = []
  for (const e of entries) {
    if (e.is_dir && e.children) {
      out.push(...collectPages(e.children, markdownOnly))
    } else if (!e.is_dir) {
      if (!markdownOnly || isMarkdownFile(e.name)) out.push(e.path)
    }
  }
  return out
}
