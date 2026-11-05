#!/usr/bin/env node
/**
 * Stdio MCP for the Datapad Workbench BrowserPane.
 * Talks to the loopback HTTP API started by the Workbench main process.
 * Messages are newline-delimited JSON-RPC (MCP stdio), not LSP Content-Length.
 */

const BASE = process.env.WORKBENCH_BROWSER_URL
const TOKEN = process.env.WORKBENCH_BROWSER_TOKEN

if (!BASE || !TOKEN) {
  console.error('WORKBENCH_BROWSER_URL and WORKBENCH_BROWSER_TOKEN are required')
  process.exit(1)
}

const TOOLS = [
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

async function callApi(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(text || `BrowserPane API ${res.status}`)
  }
  return text ? JSON.parse(text) : {}
}

async function handleTool(name, args) {
  if (name === 'get_state') return callApi('GET', '/state')
  if (name === 'navigate') return callApi('POST', '/navigate', { url: String(args?.url ?? '') })
  if (name === 'back') return callApi('POST', '/back')
  if (name === 'forward') return callApi('POST', '/forward')
  if (name === 'reload') return callApi('POST', '/reload')
  if (name === 'stop') return callApi('POST', '/stop')
  if (name === 'transcribe_youtube') {
    return callApi('POST', '/youtube/transcript', {
      url: String(args?.url ?? ''),
      lang: args?.lang ? String(args.lang) : undefined
    })
  }
  throw new Error(`Unknown tool: ${name}`)
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
      serverInfo: { name: 'workbench-browser', version: '0.1.0' }
    })
    return
  }
  if (method === 'notifications/initialized' || method === 'initialized') return
  if (method === 'ping') {
    reply(id, {})
    return
  }
  if (method === 'tools/list') {
    reply(id, { tools: TOOLS })
    return
  }
  if (method === 'tools/call') {
    try {
      const data = await handleTool(params?.name, params?.arguments ?? {})
      reply(id, {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      reply(id, {
        content: [{ type: 'text', text: message }],
        isError: true
      })
    }
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
