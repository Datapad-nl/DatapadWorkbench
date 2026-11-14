import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({
  calls: [] as Array<[string, unknown]>,
  delegateDone: false,
  chat: { botId: undefined as string | undefined, projectId: 'p' }
}))
vi.mock('./store', () => ({ getChat: async (chatId: string) => ({ id: chatId, ...fake.chat }) }))

vi.mock('./browser', () => ({
  getBrowserState: () => ({ url: 'about:blank' }),
  requestShowBrowser: () => undefined,
  stopBrowser: () => ({ ok: true })
}))
vi.mock('./browserDrive', () => ({
  navigate: async (url: string) => {
    fake.calls.push(['navigate', url])
    return { url }
  }
}))
vi.mock('./youtube', () => ({}))
vi.mock('./pullRequests', () => ({}))
vi.mock('./secretTools', () => ({}))
vi.mock('./chatTools', () => ({
  listProjectChats: async (from: unknown) => {
    fake.calls.push(['list', from])
    return { chats: [] }
  },
  readProjectChat: async (input: unknown) => {
    fake.calls.push(['read', input])
    return { text: 'the chat' }
  },
  delegateTask: async (input: unknown) => {
    fake.calls.push(['delegate', input])
    return { chatId: 'child', title: 'Child' }
  },
  waitForDelegate: async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
    return fake.delegateDone ? { done: true, answer: 'all done' } : { done: false }
  }
}))

import { handleMcp, type Toolset } from './workbenchMcp'

let server: Server
let base = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const toolset = (req.url ?? '').slice('/mcp/'.length) as Toolset
      void handleMcp(res, { token: 't1', chatId: 'chat-1' }, toolset, JSON.parse(Buffer.concat(chunks).toString()))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => server.close())
beforeEach(() => {
  fake.calls.length = 0
  fake.delegateDone = false
  fake.chat = { botId: undefined, projectId: 'p' }
})

function post(toolset: Toolset, body: unknown, signal?: AbortSignal): Promise<Response> {
  return fetch(`${base}/mcp/${toolset}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
    signal
  })
}

/** The JSON-RPC messages of an event stream. */
async function events(res: Response): Promise<unknown[]> {
  const text = await res.text()
  return text
    .split('\n\n')
    .filter((block) => block.startsWith('event: message'))
    .map((block) => JSON.parse(block.slice(block.indexOf('data: ') + 'data: '.length)))
}

describe('Workbench MCP over HTTP', () => {
  it('answers initialize and tools/list as JSON, and a notification with 202', async () => {
    const init = await post('workbench', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
    expect(init.headers.get('content-type')).toBe('application/json')
    expect(await init.json()).toMatchObject({ id: 1, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'workbench' } } })

    expect((await post('workbench', { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202)

    const workbench = (await (await post('workbench', { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()) as {
      result: { tools: Array<{ name: string }> }
    }
    expect(workbench.result.tools.map((tool) => tool.name)).toContain('request_secret')
    const browser = (await (await post('browser', { jsonrpc: '2.0', id: 3, method: 'tools/list' })).json()) as {
      result: { tools: Array<{ name: string }> }
    }
    expect(browser.result.tools.map((tool) => tool.name)).toContain('navigate')
    expect(browser.result.tools.map((tool) => tool.name)).not.toContain('delegate')
  })

  it("lists notify and follow_up only in a bot's own chats", async () => {
    const names = async (): Promise<string[]> => {
      const list = (await (await post('workbench', { jsonrpc: '2.0', id: 9, method: 'tools/list' })).json()) as {
        result: { tools: Array<{ name: string }> }
      }
      return list.result.tools.map((tool) => tool.name)
    }
    expect(await names()).not.toContain('notify')
    fake.chat = { botId: 'scout', projectId: 'p' }
    expect(await names()).not.toContain('notify')
    fake.chat = { botId: 'scout', projectId: '' }
    expect(await names()).toEqual(expect.arrayContaining(['notify', 'follow_up', 'request_secret']))
  })

  it('runs a tool for the chat of the token, whatever the arguments name', async () => {
    const res = await post('workbench', {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'read_chat', arguments: { chat: 'other', from: 'someone-else' } }
    })
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(await events(res)).toEqual([{ jsonrpc: '2.0', id: 4, result: { content: [{ type: 'text', text: 'the chat' }] } }])
    expect(fake.calls).toEqual([['read', { chat: 'other', from: 'chat-1' }]])

    const list = await post('workbench', { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'list_chats' } })
    await events(list)
    expect(fake.calls[1]).toEqual(['list', 'chat-1'])
  })

  it('keeps a browser tool off the chat tools, and reports a failing tool as an error result', async () => {
    const res = await post('browser', {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'navigate', arguments: { url: 'http://localhost:5173' } }
    })
    expect(await events(res)).toHaveLength(1)
    expect(fake.calls).toEqual([['navigate', 'http://localhost:5173']])

    const wrong = await post('browser', { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'delegate', arguments: {} } })
    expect(await events(wrong)).toEqual([
      { jsonrpc: '2.0', id: 7, result: { content: [{ type: 'text', text: 'Unknown tool: delegate' }], isError: true } }
    ])
  })

  it('waits out a delegate, and ends the stream without an answer when the call is cancelled', async () => {
    const waiting = post('workbench', { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'delegate', arguments: { brief: 'x' } } })
    await new Promise((resolve) => setTimeout(resolve, 60))
    fake.delegateDone = true
    const [message] = (await events(await waiting)) as Array<{ result: { content: Array<{ text: string }> } }>
    expect(message.result.content[0].text).toBe('Child (child) finished.\n\nall done')

    fake.delegateDone = false
    const cancelled = post('workbench', { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'delegate', arguments: { brief: 'y' } } })
    await new Promise((resolve) => setTimeout(resolve, 60))
    const note = await post('workbench', { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 9 } })
    expect(note.status).toBe(202)
    expect(await events(await cancelled)).toEqual([])
  })

  it('keeps the calls of the two toolsets apart: a cancel on one does not stop the other', async () => {
    const delegating = post('workbench', { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'delegate', arguments: { brief: 'z' } } })
    await new Promise((resolve) => setTimeout(resolve, 40))
    await post('browser', { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 10 } })
    fake.delegateDone = true
    expect(await events(await delegating)).toHaveLength(1)
  })

  it('refuses a batch', async () => {
    const res = await post('workbench', [{ jsonrpc: '2.0', id: 11, method: 'ping' }])
    expect(await res.json()).toMatchObject({ error: { code: -32600 } })
  })
})
