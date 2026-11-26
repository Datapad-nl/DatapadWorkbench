import { describe, expect, it } from 'vitest'
import { createRpc, RpcError } from './rpc'

function setup(onRequest: (method: string, params: unknown) => Promise<unknown>) {
  const out: Array<Record<string, unknown>> = []
  const notes: Array<[string, unknown]> = []
  const rpc = createRpc(
    (line) => out.push(JSON.parse(line) as Record<string, unknown>),
    onRequest,
    (method, params) => notes.push([method, params])
  )
  return { rpc, out, notes }
}

const tick = (): Promise<void> => new Promise((done) => setTimeout(done, 0))

describe('createRpc', () => {
  it('answers a request, also one that arrives in pieces', async () => {
    const { rpc, out } = setup(async (method, params) => ({ method, params }))
    const line = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping', params: { a: 1 } }) + '\n'
    rpc.feed(line.slice(0, 10))
    rpc.feed(line.slice(10))
    await tick()
    expect(out).toEqual([{ jsonrpc: '2.0', id: 7, result: { method: 'ping', params: { a: 1 } } }])
  })

  it('takes several messages in one chunk and hands a notification over', async () => {
    const { rpc, out, notes } = setup(async () => undefined)
    rpc.feed('{"jsonrpc":"2.0","method":"note","params":{"x":1}}\n{"jsonrpc":"2.0","id":1,"method":"m"}\n')
    await tick()
    expect(notes).toEqual([['note', { x: 1 }]])
    expect(out).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }])
  })

  it('sends an RpcError with its code, message and data, and another error with its message', async () => {
    const { rpc, out } = setup(async (method) => {
      if (method === 'known') throw new RpcError(-32000, 'No credits (HTTP 402)', { status: 402 })
      throw new Error('boom')
    })
    rpc.feed('{"id":1,"method":"known"}\n{"id":2,"method":"other"}\n')
    await tick()
    expect(out[0].error).toEqual({ code: -32000, message: 'No credits (HTTP 402)', data: { status: 402 } })
    expect(out[1].error).toEqual({ code: -32603, message: 'boom' })
  })

  it('answers a line that is not JSON with a parse error', () => {
    const { rpc, out } = setup(async () => ({}))
    rpc.feed('not json\n')
    expect(out[0]).toMatchObject({ id: null, error: { code: -32700 } })
  })

  it('resolves its own request with the result and rejects it with the error', async () => {
    const { rpc, out } = setup(async () => ({}))
    const first = rpc.request('ask', { q: 1 })
    const second = rpc.request('ask', { q: 2 })
    expect(out[0]).toMatchObject({ method: 'ask', params: { q: 1 } })
    rpc.feed(JSON.stringify({ id: out[0].id, result: { ok: true } }) + '\n')
    rpc.feed(JSON.stringify({ id: out[1].id, error: { code: 1, message: 'no' } }) + '\n')
    await expect(first).resolves.toEqual({ ok: true })
    await expect(second).rejects.toThrow('no')
  })
})
