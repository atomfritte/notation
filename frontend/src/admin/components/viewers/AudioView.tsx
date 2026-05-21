import { Music } from 'lucide-react'

type Props = { url: string; path: string }

/**
 * AudioView: native <audio controls>. Same Range / inline serving deal as
 * VideoView. The big <Music> icon gives the otherwise audio-only page some
 * visual anchor.
 */
export function AudioView({ url, path }: Props) {
  const filename = path.split('/').pop() ?? path
  return (
    <div className="flex-1 flex flex-col items-center justify-center bg-zinc-50 dark:bg-zinc-950/40 p-8 gap-6">
      <Music size={64} className="text-zinc-400 dark:text-zinc-600" />
      <div className="text-sm text-zinc-700 dark:text-zinc-300 font-medium">{filename}</div>
      <audio src={url} controls preload="metadata" className="w-full max-w-md" aria-label={path}>
        Your browser does not support the audio element.
      </audio>
    </div>
  )
}
