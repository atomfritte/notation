/**
 * File-type helpers. Path-extension based — keeps the runtime check trivial
 * and consistent with how the backend serves files.
 *
 * Dispatch precedence (highest first) in FileViewer:
 *   markdown → image → pdf → audio → video → word → spreadsheet → code → download
 */

const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdx'])
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'bmp', 'ico'])

const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv'])
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus'])
const WORD_EXTS = new Set(['docx']) // mammoth supports .docx only (no legacy .doc)
const SPREADSHEET_EXTS = new Set(['xlsx', 'xlsm', 'xlsb', 'xls', 'ods', 'csv', 'tsv'])
const PDF_EXTS = new Set(['pdf'])

// Everything we can sensibly syntax-highlight or show as plain text.
// (Includes csv/tsv so they remain *editable* — but SpreadsheetView is
// checked first in dispatch so the default view is the table.)
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

export function isMarkdownFile(path: string): boolean { return MARKDOWN_EXTS.has(ext(path)) }
export function isImageFile(path: string): boolean    { return IMAGE_EXTS.has(ext(path)) }
export function isPDFFile(path: string): boolean      { return PDF_EXTS.has(ext(path)) }
export function isVideoFile(path: string): boolean    { return VIDEO_EXTS.has(ext(path)) }
export function isAudioFile(path: string): boolean    { return AUDIO_EXTS.has(ext(path)) }
export function isWordFile(path: string): boolean     { return WORD_EXTS.has(ext(path)) }
export function isSpreadsheetFile(path: string): boolean { return SPREADSHEET_EXTS.has(ext(path)) }

export function isTextFile(path: string): boolean {
  const e = ext(path)
  return MARKDOWN_EXTS.has(e) || TEXT_EXTS.has(e) || e === ''
}

export function isCodeFile(path: string): boolean {
  const e = ext(path)
  return TEXT_EXTS.has(e) && !MARKDOWN_EXTS.has(e)
}

/** Returns the Monaco editor language id best matching the path's extension. */
export function monacoLang(path: string): string {
  const e = ext(path)
  const map: Record<string, string> = {
    md: 'markdown', markdown: 'markdown', mdx: 'markdown',
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
    yml: 'yaml', yaml: 'yaml', json: 'json', jsonc: 'json',
    xml: 'xml', html: 'html', htm: 'html',
    css: 'css', scss: 'scss', less: 'less',
    sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
    sql: 'sql', graphql: 'graphql', gql: 'graphql',
    c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', cxx: 'cpp',
    java: 'java', kt: 'kotlin', scala: 'scala', cs: 'csharp', swift: 'swift',
    php: 'php', dart: 'dart',
    toml: 'ini', env: 'shell',
    dockerfile: 'dockerfile',
  }
  return map[e] ?? 'plaintext'
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
