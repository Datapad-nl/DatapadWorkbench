import { memo, useMemo, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { isMediaSrc, isRemoteSrc, isVideoSrc, mediaUrl } from '../../../shared/media'

const PLUGINS = [remarkGfm]

const FRAME = 'my-2 max-h-[480px] max-w-full cursor-pointer rounded-lg border border-line'

function plainText(children: ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children)
  if (Array.isArray(children)) return children.map((child) => plainText(child)).join('')
  return ''
}

function LocalMedia({
  chatId,
  src,
  alt
}: {
  chatId: string
  src: string
  alt?: string
}): React.JSX.Element {
  const url = mediaUrl(chatId, src)
  const open = (): void => {
    void window.workbench.openMedia(chatId, src)
  }
  if (isVideoSrc(src)) {
    return <video src={url} controls className={FRAME} />
  }
  return <img src={url} alt={alt || ''} className={FRAME} onClick={open} />
}

function mediaComponents(chatId: string): Components {
  return {
    img: ({ src, alt }) => {
      if (!src) return null
      if (isRemoteSrc(src)) {
        return <img src={src} alt={alt ?? ''} className={FRAME} />
      }
      if (!isMediaSrc(src)) return null
      return <LocalMedia chatId={chatId} src={src} alt={alt} />
    },
    a: ({ href, children }) => {
      if (!href) return <>{children}</>
      if (isRemoteSrc(href)) {
        return (
          <a href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        )
      }
      if (isMediaSrc(href)) {
        return <LocalMedia chatId={chatId} src={href} alt={plainText(children)} />
      }
      return (
        <a
          href={href}
          onClick={(event) => {
            event.preventDefault()
          }}
        >
          {children}
        </a>
      )
    }
  }
}

export const Markdown = memo(function Markdown({
  text,
  chatId
}: {
  text: string
  chatId?: string
}): React.JSX.Element {
  const components = useMemo(() => (chatId ? mediaComponents(chatId) : undefined), [chatId])
  return (
    <div className="markdown text-[14.5px] leading-7 text-ink">
      <ReactMarkdown remarkPlugins={PLUGINS} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
