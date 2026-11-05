import { describe, expect, it } from 'vitest'
import { parseMcpServers, toAcpMcpServers } from './mcp'

describe('parseMcpServers', () => {
  it('reads the mcpServers wrapper or the bare object', () => {
    const inner = { github: { command: 'npx', args: ['-y', 'server-github'], env: { TOKEN: 'x' } } }
    expect(parseMcpServers(JSON.stringify({ mcpServers: inner }))).toEqual(inner)
    expect(parseMcpServers(JSON.stringify(inner))).toEqual(inner)
    expect(parseMcpServers('  ')).toEqual({})
  })

  it('treats a url as http unless it says sse', () => {
    expect(parseMcpServers('{"a":{"url":"https://x/mcp"},"b":{"type":"sse","url":"https://y"}}')).toEqual({
      a: { type: 'http', url: 'https://x/mcp' },
      b: { type: 'sse', url: 'https://y' }
    })
  })

  it('explains what is wrong', () => {
    expect(() => parseMcpServers('{')).toThrow(/Not valid JSON/)
    expect(() => parseMcpServers('{"browser":{"command":"x"}}')).toThrow(/built-in/)
    expect(() => parseMcpServers('{"a":{"args":[]}}')).toThrow(/needs a "command"/)
    expect(() => parseMcpServers('{"a":{"command":"x","env":{"K":1}}}')).toThrow(/env/)
    expect(() => parseMcpServers('{"a":{"url":"https://x","type":"ws"}}')).toThrow(/type/)
  })
})

describe('toAcpMcpServers', () => {
  it('converts enabled servers and skips disabled ones', () => {
    const servers = parseMcpServers(
      JSON.stringify({
        local: { command: 'node', env: { A: '1' } },
        remote: { url: 'https://x/mcp', headers: { Authorization: 'Bearer t' } },
        off: { command: 'x', disabled: true }
      })
    )
    expect(toAcpMcpServers(servers)).toEqual([
      { type: 'stdio', name: 'local', command: 'node', args: [], env: [{ name: 'A', value: '1' }] },
      { type: 'http', name: 'remote', url: 'https://x/mcp', headers: [{ name: 'Authorization', value: 'Bearer t' }] }
    ])
  })
})
