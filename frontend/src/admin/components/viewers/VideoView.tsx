type Props = { url: string; path: string }

/**
 * VideoView: native <video controls>. The backend serves video/* MIMEs
 * inline via http.ServeContent so seeking + range requests work end-to-end.
 * Browser media decoder is sandboxed by the platform — even a malformed
 * file can't cross into HTML / JS context.
 */
export function VideoView({ url, path }: Props) {
  return (
    <div className="flex-1 flex items-center justify-center bg-black p-4">
      <video
        src={url}
        controls
        preload="metadata"
        playsInline
        className="max-w-full max-h-full rounded-md shadow-lg"
        aria-label={path}
      >
        Your browser does not support the video element.
      </video>
    </div>
  )
}
