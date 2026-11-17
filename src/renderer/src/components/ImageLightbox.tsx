import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './icons'

/** An image that opens larger in an overlay when clicked. */
export function ZoomImage({
  src,
  alt,
  className,
  onOpenFile
}: {
  src: string
  alt: string
  className?: string
  onOpenFile?: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  return (
    <>
      <img
        src={src}
        alt={alt}
        className={`${className ?? ''} cursor-zoom-in`}
        onClick={() => setOpen(true)}
      />
      {open &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-label={alt || 'Image'}
            className="fixed inset-0 z-50 flex items-center justify-center bg-overlay"
            onClick={() => setOpen(false)}
          >
            <img
              src={src}
              alt={alt}
              className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain"
              onClick={(event) => event.stopPropagation()}
            />
            <div className="absolute top-4 right-4 flex items-center gap-2">
              {onOpenFile && (
                <button
                  type="button"
                  className="rounded-[7px] border border-line bg-raised px-3 py-1.5 text-[12.5px] text-muted hover:text-ink"
                  onClick={(event) => {
                    event.stopPropagation()
                    onOpenFile()
                  }}
                >
                  Open file
                </button>
              )}
              <button
                type="button"
                title="Close"
                aria-label="Close"
                className="flex h-8 w-8 items-center justify-center rounded-[7px] border border-line bg-raised text-muted hover:text-ink"
                onClick={() => setOpen(false)}
              >
                <Icon name="close" size={14} />
              </button>
            </div>
          </div>,
          document.body
        )}
    </>
  )
}
