import { createContext, memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { localLinkSrc, looksLikeFilePath } from '../../../shared/fileView'
import { isMediaSrc, isRemoteSrc, isVideoSrc, mediaUrl } from '../../../shared/media'
import { useFileResolvable } from '../fileLinks'
import { NOTE_HREF } from '../noteLinks'
import { Icon } from './icons'
import { ZoomImage } from './ImageLightbox'
import { mermaidSource, useMermaidSvg } from './mermaid'

const PLUGINS = [remarkGfm]

const FRAME = 'my-2 max-h-[480px] max-w-full rounded-lg border border-line'

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
    return <video src={url} controls className={`${FRAME} cursor-pointer`} />
  }
  return <ZoomImage src={url} alt={alt || ''} className={FRAME} onOpenFile={open} />
}

// Inline code in a link stays part of the link rather than becoming a second thing to click.
const InLink = createContext(false)

/** Inline code naming a file of the chat's project, which opens in the browser panel once it is known to exist. */
function FilePathCode({ chatId, src, children }: { chatId: string; src: string; children: ReactNode }): React.JSX.Element {
  const inLink = useContext(InLink)
  const exists = useFileResolvable(chatId, src, !inLink)
  if (!exists) return <code>{children}</code>
  return (
    <button
      type="button"
      title="Open in browser panel"
      onClick={() => void window.workbench.openFile(chatId, src)}
      className="inline cursor-pointer text-left text-accent underline-offset-2 hover:underline"
    >
      <code>{children}</code>
    </button>
  )
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
      {/* Outside the frame, so a visual can't pass itself off as the app's own UI. */}
      <div className="mb-1 text-[11.5px] text-muted">Made by the agent</div>
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

function CopyButton({ text }: { text: () => string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  const copy = (): void => {
    void navigator.clipboard.writeText(text()).then(
      () => setCopied(true),
      () => undefined
    )
  }
  return (
    <button
      type="button"
      title={copied ? 'Copied' : 'Copy'}
      aria-label={copied ? 'Copied' : 'Copy code'}
      onClick={copy}
      className={`absolute top-2 right-2 flex h-[26px] items-center justify-center gap-1 rounded-[7px] border bg-code-block text-[11.5px] transition-colors ${
        copied
          ? 'border-ok px-2 text-ok'
          : 'w-[26px] border-line text-muted hover:bg-hover hover:text-ink'
      }`}
    >
      <Icon name={copied ? 'check' : 'copy'} size={13} />
      {copied ? 'Copied' : null}
    </button>
  )
}

function CodeBlock({ children }: { children: ReactNode }): React.JSX.Element {
  const pre = useRef<HTMLPreElement>(null)
  return (
    <div className="code-block relative">
      <pre ref={pre}>{children}</pre>
      <CopyButton text={() => (pre.current?.textContent ?? '').replace(/\n$/, '')} />
    </div>
  )
}

/** A `mermaid` block as its diagram, and as plain code until the source renders. */
function MermaidBlock({ source, children }: { source: string; children: ReactNode }): React.JSX.Element {
  const svg = useMermaidSvg(source)
  const box = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!box.current || !svg) return
    box.current.innerHTML = svg
    // Mermaid shrinks a diagram to the column. At its own width a wide one scrolls instead.
    const el = box.current.querySelector('svg')
    if (el?.style.maxWidth) {
      el.style.width = el.style.maxWidth
      el.style.maxWidth = 'none'
    }
  }, [svg])
  if (!svg) return <CodeBlock>{children}</CodeBlock>
  return (
    <div className="code-block relative">
      <div ref={box} className="mb-[0.9em] overflow-x-auto rounded-lg border border-line bg-code-block px-[14px] py-3 pr-[46px]" />
      <CopyButton text={() => source} />
    </div>
  )
}

const visualComponents: Components = {
  pre: ({ node, children }) => {
    const visual = visualBlock(node)
    if (visual) return <VisualFrame {...visual} />
    const mermaid = mermaidSource(node)
    if (mermaid !== null) return <MermaidBlock source={mermaid}>{children}</MermaidBlock>
    return <CodeBlock>{children}</CodeBlock>
  }
}

function mediaComponents(chatId: string): Components {
  return {
    ...visualComponents,
    img: ({ src, alt }) => {
      if (!src) return null
      if (isRemoteSrc(src)) {
        return <ZoomImage src={src} alt={alt ?? ''} className={FRAME} />
      }
      if (!isMediaSrc(src)) return null
      return <LocalMedia chatId={chatId} src={src} alt={alt} />
    },
    a: ({ href, children }) => {
      if (!href) return <>{children}</>
      if (isRemoteSrc(href)) {
        return (
          <a href={href} target="_blank" rel="noreferrer">
            <InLink.Provider value>{children}</InLink.Provider>
          </a>
        )
      }
      if (isMediaSrc(href)) {
        return <LocalMedia chatId={chatId} src={href} alt={plainText(children)} />
      }
      const file = localLinkSrc(href)
      return (
        <a
          href={href}
          onClick={(event) => {
            event.preventDefault()
            if (file) void window.workbench.openFile(chatId, file)
          }}
        >
          <InLink.Provider value>{children}</InLink.Provider>
        </a>
      )
    },
    // Fenced code is a `pre` above and its text ends in a newline, so only inline code is ever a path.
    code: ({ className, children }) => {
      const text = plainText(children)
      if (className || !looksLikeFilePath(text)) return <code className={className}>{children}</code>
      return (
        <FilePathCode chatId={chatId} src={text}>
          {children}
        </FilePathCode>
      )
    }
  }
}

/** Links in a vault note: `#note:` links open that note, web links open in the browser. */
function noteComponents(onNoteLink: (id: string) => void): Components {
  return {
    ...visualComponents,
    a: ({ href, children }) => {
      if (href?.startsWith(NOTE_HREF)) {
        const id = decodeURIComponent(href.slice(NOTE_HREF.length))
        return (
          <a
            href={href}
            onClick={(event) => {
              event.preventDefault()
              onNoteLink(id)
            }}
          >
            {children}
          </a>
        )
      }
      if (href && isRemoteSrc(href)) {
        return (
          <a href={href} target="_blank" rel="noreferrer">
            {children}
          </a>
        )
      }
      return <>{children}</>
    }
  }
}

export const Markdown = memo(function Markdown({
  text,
  chatId,
  onNoteLink
}: {
  text: string
  chatId?: string
  onNoteLink?: (id: string) => void
}): React.JSX.Element {
  const components = useMemo(
    () => (chatId ? mediaComponents(chatId) : onNoteLink ? noteComponents(onNoteLink) : visualComponents),
    [chatId, onNoteLink]
  )
  return (
    <div className="markdown text-[14.5px] leading-7 text-ink">
      <ReactMarkdown remarkPlugins={PLUGINS} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
