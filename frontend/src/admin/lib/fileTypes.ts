/**
 * File-type helpers. Path-extension based — keeps the runtime check trivial
 * and consistent with how the backend serves files.
 */

const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdx'])
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'bmp', 'ico'])

// Everything we can sensibly syntax-highlight or show as plain text.
const TEXT_EXTS = new Set([
  // Data
  'json', 'jsonc', 'yaml', 'yml', 'toml', 'xml', 'csv', 'tsv', 'env',
  // Web
  'html', 'htm', 'css', 'scss', 'less', 'svg',
  // Code
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx',
  'py', 'go', 'rs', 'c', 'h', 'cpp', 'hpp', 'cc', 'cxx',
  'java', 'kt', 'scala', 'rb', 'php', 'cs', 'swift', 'dart',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'sql', 'graphql', 'gql', 'proto',
  // Plain
  'txt', 'text', 'log', 'gitignore', 'gitattributes', 'editorconfig', 'dockerignore',
])

function ext(path: string): string {
  const i = path.lastIndexOf('.')
  if (i < 0) return ''
  return path.slice(i + 1).toLowerCase()
}

export function isMarkdownFile(path: string): boolean {
  return MARKDOWN_EXTS.has(ext(path))
}

export function isImageFile(path: string): boolean {
  return IMAGE_EXTS.has(ext(path))
}

export function isTextFile(path: string): boolean {
  const e = ext(path)
  return MARKDOWN_EXTS.has(e) || TEXT_EXTS.has(e) || e === ''
}

export function isCodeFile(path: string): boolean {
  const e = ext(path)
  return TEXT_EXTS.has(e) && !MARKDOWN_EXTS.has(e)
}

/** Returns the highlight.js language id best matching the path's extension. */
export function highlightLang(path: string): string {
  const e = ext(path)
  const map: Record<string, string> = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript',
    jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
    yml: 'yaml', sh: 'bash', zsh: 'bash', fish: 'bash',
    gql: 'graphql', gitignore: 'plaintext', env: 'bash',
  }
  return map[e] ?? e ?? 'plaintext'
}
