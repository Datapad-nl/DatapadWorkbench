#!/usr/bin/env node
/**
 * Stdio MCP for the Datapad Workbench BrowserPane.
 * Talks to the loopback HTTP API started by the Workbench main process.
 * Messages are newline-delimited JSON-RPC (MCP stdio), not LSP Content-Length.
 * With WORKBENCH_TOOLSET=workbench it serves the chat tools instead: visuals,
 * delegating to another agent, reading or starting other chats, scheduled tasks and
 * pull requests.
 */

const BASE = process.env.WORKBENCH_BROWSER_URL
const TOKEN = process.env.WORKBENCH_BROWSER_TOKEN
const CHAT_ID = process.env.WORKBENCH_CHAT_ID ?? ''
const WORKBENCH = process.env.WORKBENCH_TOOLSET === 'workbench'

if (!BASE || !TOKEN) {
  console.error('WORKBENCH_BROWSER_URL and WORKBENCH_BROWSER_TOKEN are required')
  process.exit(1)
}

const BROWSER_TOOLS = [
  {
    name: 'get_state',
    description:
      'Get the Datapad Workbench in-app BrowserPane state: url, title, loading, visible, canGoBack, canGoForward, error. Use this after navigate to verify the page loaded.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'navigate',
    description:
      'Open a URL in the Datapad Workbench BrowserPane — the in-app browser. Always use this instead of an external browser. Shows the pane if it is hidden. Use http or https only.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http(s) URL to load, e.g. http://localhost:3000' }
      },
      required: ['url'],
      additionalProperties: false
    }
  },
  {
    name: 'back',
    description: 'Go back in the Workbench BrowserPane history.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'forward',
    description: 'Go forward in the Workbench BrowserPane history.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'reload',
    description: 'Reload the current Workbench BrowserPane page.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'stop',
    description: 'Stop loading the current Workbench BrowserPane page.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'screenshot',
    description:
      'Take a screenshot of the page open in the Workbench BrowserPane and return it as an image. Use it to see your own UI work after navigate, click or type.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'snapshot',
    description:
      'Read the page open in the BrowserPane: its visible text plus a numbered list of links, buttons and fields. Pass a number from this list as `ref` to click or type. Numbers change after every snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        maxChars: { type: 'number', description: 'Cap on page text length. Default 6000.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'click',
    description:
      'Click an element in the BrowserPane page. Name it by `ref` (from snapshot), CSS `selector`, or its visible `text`. Returns the page state after the click.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'number', description: 'Element number from the last snapshot' },
        selector: { type: 'string', description: 'CSS selector' },
        text: { type: 'string', description: 'Visible text or label of the element' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'type',
    description:
      'Type text into a field in the BrowserPane page. Name the field by `ref`, `selector`, or its label in `field`; leave all three out to type into the focused field. For a <select>, `text` picks the option by label or value.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to type' },
        ref: { type: 'number', description: 'Field number from the last snapshot' },
        selector: { type: 'string', description: 'CSS selector of the field' },
        field: { type: 'string', description: 'Label, placeholder or name of the field' },
        clear: { type: 'boolean', description: 'Replace what the field holds instead of adding to it' }
      },
      required: ['text'],
      additionalProperties: false
    }
  },
  {
    name: 'press',
    description:
      'Press a key in the BrowserPane page, for example Enter, Escape, Tab, Backspace, ArrowDown, or a single character. Goes to the focused element.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        modifiers: {
          type: 'array',
          items: { type: 'string', enum: ['shift', 'control', 'alt', 'meta'] }
        }
      },
      required: ['key'],
      additionalProperties: false
    }
  },
  {
    name: 'wait_for',
    description:
      'Wait until a CSS selector is visible, or some text appears, in the BrowserPane page. Returns found: false after the timeout instead of failing.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        text: { type: 'string' },
        timeoutMs: { type: 'number', description: 'Default 5000, at most 30000' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'evaluate',
    description:
      'Run a JavaScript expression in the BrowserPane page and return its JSON value. Promises are awaited. For statements, wrap them: (() => { ...; return x })().',
    inputSchema: {
      type: 'object',
      properties: { expression: { type: 'string' } },
      required: ['expression'],
      additionalProperties: false
    }
  },
  {
    name: 'console',
    description:
      "Recent console messages from the BrowserPane page since it last navigated. Use it to find the page's errors.",
    inputSchema: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['all', 'warning', 'error'], description: 'warning includes errors' },
        limit: { type: 'number', description: 'Most recent messages to return. Default 50.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'transcribe_youtube',
    description:
      'Fetch the official captions/transcript for a YouTube video. Pass a youtube.com, youtu.be, shorts, or embed URL, or an 11-character video id. Use this when the user wants a transcript, summary, or quotes from a YouTube video. Returns title, author, language, and timestamped text. Fails if the video has no captions.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'YouTube URL or video id'
        },
        lang: {
          type: 'string',
          description: 'Preferred caption language code, e.g. en. Defaults to English when available.'
        }
      },
      required: ['url'],
      additionalProperties: false
    }
  }
]

const AGENT = {
  type: 'string',
  enum: ['grok', 'claude'],
  description: 'grok for Grok Build, claude for Claude Code. Defaults to the agent set in Settings.'
}

const WORKBENCH_TOOLS = [
  {
    name: 'show_visual',
    description:
      'Show a visual inline in the chat: a chart, diagram, table or UI mock-up. Pass one self-contained HTML document. Inline <script> and <style> work; scripts and styles may also load from cdn.jsdelivr.net, cdnjs.cloudflare.com or unpkg.com, and fonts from Google Fonts. Nothing else on the network is reachable, and the page runs in a sandbox with no storage. Use it when a picture explains the answer better than text. The user sees it in your reply where you call it.',
    inputSchema: {
      type: 'object',
      properties: {
        html: { type: 'string', description: 'A complete HTML document' },
        title: { type: 'string', description: 'Short caption shown under the visual' }
      },
      required: ['html'],
      additionalProperties: false
    }
  },
  {
    name: 'delegate',
    description:
      'Hand a self-contained task to another agent in a new chat in this project, wait for it to finish, and return its final answer. The child chat shows in the sidebar so the user can follow it. The child starts with no context: put everything it needs in the brief (goal, files, what is already ruled out, what to return). Use it for independent work, or for a second opinion from the other agent.',
    inputSchema: {
      type: 'object',
      properties: {
        brief: { type: 'string', description: 'The full task for the other agent' },
        agent: AGENT,
        model: {
          type: 'string',
          description:
            'Claude Code model for the child, which then runs on Claude Code: fable for a really hard task (it costs the most), opus for work that needs judgement, sonnet for routine work, haiku when a small, fast model is enough. Leave out for the model set in Settings. Settings can fix one model for every child; that one then wins.'
        },
        title: { type: 'string', description: 'Sidebar title for the child chat' },
        worktree: {
          type: 'boolean',
          description:
            'Give the child its own git worktree and branch so its edits stay apart. Removed again if the child changed nothing.'
        }
      },
      required: ['brief'],
      additionalProperties: false
    }
  },
  {
    name: 'nudge',
    description:
      'Send a follow-up message to a chat you started with delegate, wait for it to finish, and return its answer. The child keeps its context. Use it when the child stopped before its task was done, or its work did not pass your check.',
    inputSchema: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: 'Chat id of the child, as delegate returned it' },
        message: { type: 'string', description: 'What is still missing or wrong, and what to do next' }
      },
      required: ['chat', 'message'],
      additionalProperties: false
    }
  },
  {
    name: 'list_chats',
    description: 'List the chats in this project: id, title, agent, message count, whether it is running, and its worktree branch.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'read_chat',
    description: 'Read another chat in this project. Pass its id or (part of) its title. Returns the latest messages.',
    inputSchema: {
      type: 'object',
      properties: {
        chat: { type: 'string', description: 'Chat id or title' },
        last: { type: 'number', description: 'How many of the latest messages to return. Default 20.' }
      },
      required: ['chat'],
      additionalProperties: false
    }
  },
  {
    name: 'start_chat',
    description:
      'Open a new chat in this project in the sidebar, optionally sending it a first message. Only when the user asks for a new chat; to get work done and hear back, use delegate.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'First message to send, if any' },
        agent: AGENT,
        title: { type: 'string', description: 'Sidebar title' }
      },
      additionalProperties: false
    }
  }
]

WORKBENCH_TOOLS.push(
  {
    name: 'schedule_task',
    description:
      'Run a prompt in this project later, once (at) or repeating (cron). Each schedule gets its own chat in the sidebar, and every run is a new message in that chat. Times are the user\'s local time. Datapad Workbench must be open for a run to start; a run missed while it was closed starts when it opens.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The message to send on each run. It must stand on its own.' },
        cron: {
          type: 'string',
          description: 'Five-field cron in local time, e.g. "0 9 * * 1-5" for weekdays at 9:00, or @hourly/@daily/@weekly'
        },
        at: { type: 'string', description: 'One run at this local date and time, e.g. 2026-11-06T09:00' },
        agent: AGENT,
        title: { type: 'string', description: 'Sidebar title' }
      },
      required: ['prompt'],
      additionalProperties: false
    }
  },
  {
    name: 'cancel_schedule',
    description: 'Stop a scheduled task. Pass its chat id or title (list_chats shows which chats have a schedule). The chat itself stays.',
    inputSchema: {
      type: 'object',
      properties: { chat: { type: 'string', description: 'Chat id or title' } },
      required: ['chat'],
      additionalProperties: false
    }
  },
  {
    name: 'link_pr',
    description:
      'Link a GitHub pull request to this chat. The chat header shows its checks and review state, and by default Datapad Workbench watches it: when checks finish, a review comes in or it is merged or closed, this chat gets a message so you can act on it. Leave pr out to use the PR of the current branch. Needs the GitHub CLI (gh), signed in.',
    inputSchema: {
      type: 'object',
      properties: {
        pr: { type: ['string', 'number'], description: 'PR number, URL or branch; default: the current branch\'s PR' },
        watch: { type: 'boolean', description: 'Wake this chat on changes (default true)' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'pr_status',
    description: 'Checks, review state and latest reviews of the PR linked to this chat, or of another PR.',
    inputSchema: {
      type: 'object',
      properties: { pr: { type: ['string', 'number'], description: 'PR number, URL or branch; default: the linked PR' } },
      additionalProperties: false
    }
  },
  {
    name: 'unlink_pr',
    description: 'Unlink the pull request from this chat and stop watching it.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  }
)

const TOOLS = WORKBENCH ? WORKBENCH_TOOLS : BROWSER_TOOLS

async function callApi(method, path, body, signal) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined,
    signal
  })
  const text = await res.text()
  if (!res.ok) {
    let message = text
    try {
      message = JSON.parse(text).error ?? text
    } catch {
      // plain text error
    }
    throw new Error(message || `BrowserPane API ${res.status}`)
  }
  return text ? JSON.parse(text) : {}
}

// Tool calls in flight with their aborts, and those the client cancelled (`notifications/cancelled`).
const running = new Map()
const cancelled = new Set()

async function delegate(path, args, requestId) {
  const started = await callApi('POST', path, { ...args, from: CHAT_ID })
  // A cancel ends the wait in progress rather than after it.
  const signal = running.get(requestId)?.signal
  while (!cancelled.has(requestId)) {
    const result = await callApi('POST', '/chats/wait', { chatId: started.chatId, ms: 60_000 }, signal)
    if (result.done) return { ...result, chatId: started.chatId, title: started.title, model: started.model }
  }
  throw new Error('Cancelled')
}

async function handleWorkbenchTool(name, args, requestId) {
  if (name === 'show_visual') {
    // The app picks the HTML up from the tool call itself and draws it in the chat.
    if (!String(args?.html ?? '').trim()) throw new Error('Pass the HTML to show.')
    return { shown: true }
  }
  if (name === 'delegate') return delegate('/chats/delegate', args, requestId)
  if (name === 'nudge') return delegate('/chats/nudge', args, requestId)
  if (name === 'list_chats') return callApi('POST', '/chats/list', { from: CHAT_ID })
  if (name === 'read_chat') return callApi('POST', '/chats/read', { ...args, from: CHAT_ID })
  if (name === 'start_chat') return callApi('POST', '/chats/start', { ...args, from: CHAT_ID })
  if (name === 'schedule_task') return callApi('POST', '/chats/schedule', { ...args, from: CHAT_ID })
  if (name === 'cancel_schedule') return callApi('POST', '/chats/unschedule', { ...args, from: CHAT_ID })
  if (name === 'link_pr') return callApi('POST', '/pr/link', { ...args, from: CHAT_ID })
  if (name === 'pr_status') return callApi('POST', '/pr/status', { ...args, from: CHAT_ID })
  if (name === 'unlink_pr') return callApi('POST', '/pr/unlink', { from: CHAT_ID })
  throw new Error(`Unknown tool: ${name}`)
}

async function handleTool(name, args, requestId) {
  if (WORKBENCH) return handleWorkbenchTool(name, args, requestId)
  if (name === 'get_state') return callApi('GET', '/state')
  if (name === 'navigate') return callApi('POST', '/navigate', { url: String(args?.url ?? '') })
  if (name === 'back') return callApi('POST', '/back')
  if (name === 'forward') return callApi('POST', '/forward')
  if (name === 'reload') return callApi('POST', '/reload')
  if (name === 'stop') return callApi('POST', '/stop')
  const drive = ['screenshot', 'snapshot', 'click', 'type', 'press', 'wait_for', 'evaluate', 'console']
  if (drive.includes(name)) return callApi('POST', `/${name}`, args ?? {})
  if (name === 'transcribe_youtube') {
    return callApi('POST', '/youtube/transcript', {
      url: String(args?.url ?? ''),
      lang: args?.lang ? String(args.lang) : undefined
    })
  }
  throw new Error(`Unknown tool: ${name}`)
}

function snapshotText(data) {
  const lines = [`${data.title || '(no title)'} — ${data.url}`, '', data.text || '(no text)', '', 'Elements:']
  for (const el of data.elements ?? []) {
    let line = `[${el.ref}] ${el.role} "${el.name}"`
    if (el.value !== undefined) line += ` value="${el.value}"`
    if (el.checked !== undefined) line += el.checked ? ' (checked)' : ' (unchecked)'
    if (el.disabled) line += ' (disabled)'
    if (el.offscreen) line += ' (scrolled out of view)'
    lines.push(line)
  }
  if (!data.elements?.length) lines.push('(none)')
  return lines.join('\n')
}

function toContent(name, data) {
  if (name === 'screenshot') {
    return [
      { type: 'image', data: data.png, mimeType: 'image/png' },
      { type: 'text', text: `${data.width}×${data.height}` }
    ]
  }
  if (name === 'snapshot') return [{ type: 'text', text: snapshotText(data) }]
  if (name === 'show_visual') return [{ type: 'text', text: 'Shown in the chat.' }]
  if (name === 'delegate' || name === 'nudge') {
    const head = `${data.title} (${data.chatId})${data.model ? ` on ${data.model}` : ''}${data.worktreeBranch ? ` on branch ${data.worktreeBranch}` : ''}`
    if (data.error) return [{ type: 'text', text: `${head} stopped: ${data.error}\n\n${data.answer ?? ''}`.trim() }]
    return [{ type: 'text', text: `${head} finished.\n\n${data.answer || '(no answer)'}` }]
  }
  if (name === 'read_chat' || name === 'link_pr' || name === 'pr_status') return [{ type: 'text', text: data.text }]
  return [{ type: 'text', text: JSON.stringify(data, null, 2) }]
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function fail(id, message) {
  send({
    jsonrpc: '2.0',
    id,
    error: { code: -32000, message }
  })
}

async function handle(message) {
  const { id, method, params } = message
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: WORKBENCH ? 'workbench' : 'workbench-browser', version: '0.1.0' }
    })
    return
  }
  if (method === 'notifications/initialized' || method === 'initialized') return
  if (method === 'notifications/cancelled') {
    const call = running.get(params?.requestId)
    if (call) {
      cancelled.add(params.requestId)
      call.abort()
    }
    return
  }
  if (method === 'ping') {
    reply(id, {})
    return
  }
  if (method === 'tools/list') {
    reply(id, { tools: TOOLS })
    return
  }
  if (method === 'tools/call') {
    running.set(id, new AbortController())
    let result
    try {
      const data = await handleTool(params?.name, params?.arguments ?? {}, id)
      result = { content: toContent(params?.name, data) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      result = {
        content: [{ type: 'text', text: message }],
        isError: true
      }
    }
    running.delete(id)
    // A cancelled request gets no reply.
    if (!cancelled.delete(id)) reply(id, result)
    return
  }
  if (id !== undefined) fail(id, `Unknown method: ${method}`)
}

let buffer = ''

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  while (true) {
    const nl = buffer.indexOf('\n')
    if (nl === -1) return
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    if (!line) continue
    try {
      void handle(JSON.parse(line))
    } catch (error) {
      console.error(error)
    }
  }
})

process.stdin.on('end', () => process.exit(0))
