import { describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ hooks: [] as string[], mcp: [] as Array<[string, string]> }))

vi.mock('./chatTools', () => ({
  agentHook: async (chatId: string) => {
    fake.hooks.push(chatId)
    return { ok: true }
  }
}))
vi.mock('./workbenchMcp', () => ({
  handleMcp: async (res: import('http').ServerResponse, caller: { chatId: string }, toolset: string) => {
    fake.mcp.push([caller.chatId, toolset])
    res.writeHead(200).end('{}')
  }
}))

import { agentHookSettings, browserMcpServers } from './browserAgent'

type Http = { url: string; headers: Array<{ name: string; value: string }> }

async function serversOf(chatId: string): Promise<{ browser: Http; workbench: Http; token: string }> {
  const [browser, workbench] = (await browserMcpServers(chatId)) as Http[]
  return { browser, workbench, token: browser.headers[0].value }
}

describe('Workbench server', () => {
  it('gives each chat its own token, and acts for the chat of the token', async () => {
    const a = await serversOf('chat-a')
    const b = await serversOf('chat-b')
    expect(a.token).not.toBe(b.token)
    expect((await serversOf('chat-a')).token).toBe(a.token)

    await fetch(a.workbench.url, { method: 'POST', headers: { Authorization: a.token }, body: '{}' })
    await fetch(b.browser.url, { method: 'POST', headers: { Authorization: b.token }, body: '{}' })
    expect(fake.mcp).toEqual([
      ['chat-a', 'workbench'],
      ['chat-b', 'browser']
    ])

    // The hook's chat comes from its token too, not from anything in the URL.
    const hook = (await agentHookSettings('chat-b')) as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ url: string; headers: { Authorization: string } }> }> }
    }
    const { url, headers } = hook.hooks.PreToolUse[0].hooks[0]
    expect(headers.Authorization).toBe(b.token)
    await fetch(`${url}?chat=chat-a`, { method: 'POST', headers, body: '{}' })
    expect(fake.hooks).toEqual(['chat-b'])
  })

  it('refuses a request without a known token, and anything but POST', async () => {
    const { workbench, token } = await serversOf('chat-c')
    expect((await fetch(workbench.url, { method: 'POST', body: '{}' })).status).toBe(401)
    expect((await fetch(workbench.url, { method: 'POST', headers: { Authorization: 'Bearer nope' }, body: '{}' })).status).toBe(401)
    expect((await fetch(workbench.url, { headers: { Authorization: token } })).status).toBe(405)
    const old = new URL('/chats/list', workbench.url).href
    expect((await fetch(old, { method: 'POST', headers: { Authorization: token }, body: '{}' })).status).toBe(404)
  })
})
