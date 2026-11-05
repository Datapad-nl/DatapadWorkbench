import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
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

type Visual = { id: string; title?: string }

/** The `visual` block an agent's `show_visual` call leaves in its reply. */
function visualBlock(node: unknown): Visual | null {
  const code = (node as { children?: Array<{ tagName?: string; properties?: { className?: unknown }; children?: Array<{ value?: unknown }> }> })?.children?.[0]
  if (code?.tagName !== 'code') return null
  const classes = code.properties?.className
  if (!Array.isArray(classes) || !classes.includes('language-visual')) return null
  try {
    const data = JSON.parse(String(code.children?.[0]?.value ?? '')) as Partial<Visual>
    return typeof data.id === 'string' && /^[0-9a-f-]{36}$/.test(data.id) ? { id: data.id, title: data.title } : null
  } catch {
    return null
  }
}

function VisualFrame({ id, title }: Visual): React.JSX.Element {
  const frame = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(240)
  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== frame.current?.contentWindow) return
      const data = event.data as { type?: unknown; height?: unknown }
      if (data?.type !== 'workbench-visual-height' || typeof data.height !== 'number') return
      setHeight(Math.min(900, Math.max(80, Math.ceil(data.height))))
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])
  return (
    <figure className="my-3">
      <iframe
        ref={frame}
        src={`workbench-visual://v/${id}`}
        sandbox="allow-scripts"
        title={title || 'Visual'}
        style={{ height }}
        className="block w-full rounded-lg border border-line bg-white"
      />
      {title ? <figcaption className="mt-1 text-[12.5px] text-muted">{title}</figcaption> : null}
    </figure>
  )
}

const visualComponents: Components = {
  pre: ({ node, children }) => {
    const visual = visualBlock(node)
    return visual ? <VisualFrame {...visual} /> : <pre>{children}</pre>
  }
}

function mediaComponents(chatId: string): Components {
  return {
    ...visualComponents,
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
  const components = useMemo(() => (chatId ? mediaComponents(chatId) : visualComponents), [chatId])
  return (
    <div className="markdown text-[14.5px] leading-7 text-ink">
      <ReactMarkdown remarkPlugins={PLUGINS} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
