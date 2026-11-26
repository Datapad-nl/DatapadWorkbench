import { createServer, type IncomingHttpHeaders } from 'http'
import type { AddressInfo } from 'net'

/** What the fake provider answers one request with. */
export type FakeReply = {
  status?: number
  headers?: Record<string, string>
  /** A plain body, for errors. */
  body?: string
  /** The `data:` payloads of a streamed answer. */
  events?: unknown[]
  /** Keep the stream open after the events, as a model that is still writing. */
  hold?: boolean
}

export type FakeProvider = {
  url: string
  requests: Array<{ path: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }>
  close: () => Promise<void>
}

/** A local HTTP server that plays a model API: `reply` gets each request's body and its number, from 0. */
export async function fakeProvider(reply: (body: Record<string, unknown>, index: number) => FakeReply): Promise<FakeProvider> {
  const requests: FakeProvider['requests'] = []
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')))
    request.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>
      requests.push({ path: request.url ?? '', headers: request.headers, body })
      const answer = reply(body, requests.length - 1)
      if (answer.events) {
        response.writeHead(answer.status ?? 200, { 'content-type': 'text/event-stream', ...answer.headers })
        for (const event of answer.events) response.write(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`)
        if (!answer.hold) response.end()
      } else {
        response.writeHead(answer.status ?? 200, { 'content-type': 'application/json', ...answer.headers })
        response.end(answer.body ?? '')
      }
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections()
        server.close(() => done())
      })
  }
}

/** Chat Completions chunks for a reply of text. */
export function chatText(text: string, usage = { prompt_tokens: 10, completion_tokens: 5 }): FakeReply {
  return {
    events: [
      { choices: [{ delta: { role: 'assistant', content: text.slice(0, 2) } }] },
      { choices: [{ delta: { content: text.slice(2) } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage },
      '[DONE]'
    ]
  }
}

/** Chat Completions chunks for several tool calls in one reply, after optional reasoning and text. */
export function chatToolCalls(calls: Array<{ name: string; input: unknown; id: string }>, before: { reasoning?: string; content?: string } = {}): FakeReply {
  return {
    events: [
      ...(before.reasoning ? [{ choices: [{ delta: { reasoning: before.reasoning } }] }] : []),
      ...(before.content ? [{ choices: [{ delta: { content: before.content } }] }] : []),
      ...calls.map((call, index) => ({
        choices: [{ delta: { tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } }] } }]
      })),
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
      '[DONE]'
    ]
  }
}

/** Chat Completions chunks for one tool call, its arguments split over two chunks. */
export function chatToolCall(name: string, input: unknown, id = 'call_1'): FakeReply {
  const args = typeof input === 'string' ? input : JSON.stringify(input)
  const half = Math.ceil(args.length / 2)
  return {
    events: [
      { choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(0, half) } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(half) } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
      '[DONE]'
    ]
  }
}
