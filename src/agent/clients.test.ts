import { afterEach, describe, expect, it } from 'vitest'
import { chatCompletions } from './chatCompletions'
import { anthropicMessages } from './messages'
import { chatText, chatToolCall, fakeProvider, type FakeProvider, type FakeReply } from './testServer'
import type { Message, ModelRequest, Provider } from './types'

let server: FakeProvider | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
})

async function request(backend: Provider['backend'], reply: (body: Record<string, unknown>, index: number) => FakeReply, extra: Partial<ModelRequest> = {}): Promise<ModelRequest> {
  server = await fakeProvider(reply)
  const model = { key: 'wb-p-m', id: 'vendor/model', name: 'Model' }
  return {
    provider: { id: 'p', name: 'Provider', backend, baseUrl: `${server.url}/v1/`, apiKey: 'sk-test', headers: { 'x-extra': 'yes' }, models: [model] },
    model,
    system: 'You are a test.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    tools: [{ name: 'read_file', description: 'Read', schema: { type: 'object', properties: {} } }],
    ...extra
  }
}

function collect() {
  const text: string[] = []
  const thoughts: string[] = []
  return { text, thoughts, on: { onText: (part: string) => text.push(part), onThought: (part: string) => thoughts.push(part) } }
}

const never = new AbortController().signal

const history: Message[] = [
  { role: 'user', content: [{ type: 'text', text: 'Read it' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'On it' }, { type: 'tool_call', id: 'c1', name: 'read_file', input: { file_path: '/a' } }] },
  { role: 'user', content: [{ type: 'tool_result', id: 'c1', content: [{ type: 'text', text: 'body' }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }] }] }
]

describe('chatCompletions', () => {
  it('streams text and thoughts, and sends the request in the API\'s shape', async () => {
    const got = collect()
    const reply = await chatCompletions(
      await request('chat_completions', () => ({
        events: [
          { choices: [{ delta: { reasoning: 'thinking' } }] },
          { choices: [{ delta: { content: 'Hel' } }] },
          { choices: [{ delta: { content: 'lo' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
          { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } },
          '[DONE]'
        ]
      }), { effort: 'max' }),
      never,
      got.on
    )
    expect(got.text).toEqual(['Hel', 'lo'])
    expect(got.thoughts).toEqual(['thinking'])
    expect(reply).toEqual({
      content: [{ type: 'thinking', text: 'thinking' }, { type: 'text', text: 'Hello' }],
      used: 120,
      outputTokens: 20,
      truncated: false
    })
    const sent = server!.requests[0]
    expect(sent.path).toBe('/v1/chat/completions')
    expect(sent.headers.authorization).toBe('Bearer sk-test')
    expect(sent.headers['x-extra']).toBe('yes')
    expect(sent.body).toMatchObject({
      model: 'vendor/model',
      stream: true,
      reasoning_effort: 'xhigh',
      messages: [{ role: 'system', content: 'You are a test.' }, { role: 'user', content: 'Hi' }],
      tools: [{ type: 'function', function: { name: 'read_file' } }]
    })
  })

  it('joins a tool call whose arguments come in pieces, and two calls in one reply', async () => {
    const reply = await chatCompletions(
      await request('chat_completions', () => ({
        events: [
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'read_file', arguments: '{"file_' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'path":"/x"}' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'grep', arguments: '{"pattern":' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '"y"}' } }] } }] },
          '[DONE]'
        ]
      })),
      never,
      collect().on
    )
    expect(reply.content).toEqual([
      { type: 'tool_call', id: 'a', name: 'read_file', input: { file_path: '/x' } },
      { type: 'tool_call', id: 'b', name: 'grep', input: { pattern: 'y' } }
    ])
  })

  it('marks arguments that are not JSON instead of failing', async () => {
    const reply = await chatCompletions(await request('chat_completions', () => chatToolCall('read_file', '{"file_path": ')), never, collect().on)
    expect(reply.content[0]).toMatchObject({ type: 'tool_call', name: 'read_file', input: {} })
    expect((reply.content[0] as { error?: string }).error).toMatch(/not valid JSON/)
  })

  it('sends tool calls and results back, a result\'s image in a user message', async () => {
    await chatCompletions(await request('chat_completions', () => chatText('ok'), { messages: history }), never, collect().on)
    expect(server!.requests[0].body.messages).toEqual([
      { role: 'system', content: 'You are a test.' },
      { role: 'user', content: 'Read it' },
      { role: 'assistant', content: 'On it', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"file_path":"/a"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'body' },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }
    ])
  })

  it('fails with the provider\'s own message and status', async () => {
    const call = chatCompletions(
      await request('chat_completions', () => ({ status: 402, body: JSON.stringify({ error: { message: 'Insufficient credits', code: 402 } }) })),
      never,
      collect().on
    )
    await expect(call).rejects.toMatchObject({ code: -32000, message: 'Insufficient credits (HTTP 402)', data: { status: 402 } })
    expect(server!.requests).toHaveLength(1)
  })

  it('fails with an error that comes inside the stream', async () => {
    const call = chatCompletions(
      await request('chat_completions', () => ({ events: [{ error: { message: 'Provider returned error', metadata: { raw: 'overloaded' } } }] })),
      never,
      collect().on
    )
    await expect(call).rejects.toThrow('Provider returned error: overloaded')
  })

  it('tries again after 429 and 5xx', async () => {
    const reply = await chatCompletions(
      await request('chat_completions', (_body, index) =>
        index === 0
          ? { status: 429, headers: { 'retry-after': '0' }, body: '{"error":{"message":"Slow down"}}' }
          : index === 1
            ? { status: 503, headers: { 'retry-after': '0' }, body: 'busy' }
            : chatText('done')
      ),
      never,
      collect().on
    )
    expect(reply.content).toEqual([{ type: 'text', text: 'done' }])
    expect(server!.requests).toHaveLength(3)
  })

  it('gives up after the retries with the last error', async () => {
    const call = chatCompletions(
      await request('chat_completions', () => ({ status: 429, headers: { 'retry-after': '0' }, body: '{"error":{"message":"Rate limited"}}' })),
      never,
      collect().on
    )
    await expect(call).rejects.toThrow('Rate limited (HTTP 429)')
    expect(server!.requests).toHaveLength(4)
  })
})

describe('anthropicMessages', () => {
  const stream = (blocks: unknown[], stop = 'end_turn'): FakeReply => ({
    events: [
      { type: 'message_start', message: { usage: { input_tokens: 50, cache_read_input_tokens: 30, cache_creation_input_tokens: 20, output_tokens: 1 } } },
      ...blocks,
      { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 25 } },
      { type: 'message_stop' }
    ]
  })

  it('streams thinking, text and a tool call whose JSON comes in pieces', async () => {
    const got = collect()
    const reply = await anthropicMessages(
      await request('messages', () =>
        stream([
          { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me see' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Read' } },
          { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'ing' } },
          { type: 'content_block_stop', index: 1 },
          { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} } },
          { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"file_pa' } },
          { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: 'th":"/x"}' } },
          { type: 'content_block_stop', index: 2 }
        ], 'tool_use'), { effort: 'high' }),
      never,
      got.on
    )
    expect(got.text).toEqual(['Read', 'ing'])
    expect(got.thoughts).toEqual(['Let me see'])
    expect(reply).toEqual({
      content: [
        { type: 'thinking', text: 'Let me see', raw: { type: 'thinking', thinking: 'Let me see', signature: 'sig' } },
        { type: 'text', text: 'Reading' },
        { type: 'tool_call', id: 'toolu_1', name: 'read_file', input: { file_path: '/x' } }
      ],
      used: 125,
      outputTokens: 25,
      truncated: false
    })
    const sent = server!.requests[0]
    expect(sent.path).toBe('/v1/messages')
    // Not api.anthropic.com, so the key is a bearer token.
    expect(sent.headers.authorization).toBe('Bearer sk-test')
    expect(sent.headers['x-api-key']).toBeUndefined()
    expect(sent.headers['anthropic-version']).toBe('2023-06-01')
    expect(sent.body).toMatchObject({
      model: 'vendor/model',
      system: 'You are a test.',
      stream: true,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'high' },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      tools: [{ name: 'read_file', description: 'Read', input_schema: { type: 'object' } }]
    })
    expect(sent.body.cache_control).toBeUndefined()
  })

  it('sends no thinking fields without an effort, and history in its own blocks', async () => {
    const thinking = { type: 'thinking', thinking: 'hm', signature: 's' }
    const messages: Message[] = [
      history[0],
      { role: 'assistant', content: [{ type: 'thinking', text: 'hm', raw: thinking }, { type: 'thinking', text: 'from another API' }, ...history[1].content] },
      history[2]
    ]
    const reply = await anthropicMessages(await request('messages', () => stream([], 'max_tokens'), { messages }), never, collect().on)
    expect(reply.truncated).toBe(true)
    const body = server!.requests[0].body
    expect(body.thinking).toBeUndefined()
    expect(body.output_config).toBeUndefined()
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Read it' }] },
      { role: 'assistant', content: [thinking, { type: 'text', text: 'On it' }, { type: 'tool_use', id: 'c1', name: 'read_file', input: { file_path: '/a' } }] },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'c1',
          content: [{ type: 'text', text: 'body' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }]
        }]
      }
    ])
  })

  it('marks tool JSON that is cut off instead of failing', async () => {
    const reply = await anthropicMessages(
      await request('messages', () =>
        stream([
          { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: 'read_file' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path": "/x' } },
          { type: 'content_block_stop', index: 0 }
        ])),
      never,
      collect().on
    )
    expect((reply.content[0] as { error?: string }).error).toMatch(/not valid JSON/)
  })

  it('fails with the provider\'s own message and status', async () => {
    const call = anthropicMessages(
      await request('messages', () => ({ status: 400, body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens is too large' } }) })),
      never,
      collect().on
    )
    await expect(call).rejects.toMatchObject({ code: -32000, message: 'max_tokens is too large (HTTP 400)' })
  })

  it('fails with an error event inside the stream', async () => {
    const call = anthropicMessages(
      await request('messages', () => ({ events: [{ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }] })),
      never,
      collect().on
    )
    await expect(call).rejects.toThrow('Overloaded')
  })

  it('tries again after 429', async () => {
    const reply = await anthropicMessages(
      await request('messages', (_body, index) =>
        index === 0
          ? { status: 429, headers: { 'retry-after': '0' }, body: '{"error":{"message":"Slow down"}}' }
          : stream([
              { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
              { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
              { type: 'content_block_stop', index: 0 }
            ])
      ),
      never,
      collect().on
    )
    expect(reply.content).toEqual([{ type: 'text', text: 'ok' }])
    expect(server!.requests).toHaveLength(2)
  })
})

describe('an effort the model refuses', () => {
  const refusal = (message: string): FakeReply => ({ status: 400, body: JSON.stringify({ error: { message } }) })
  const messagesText: FakeReply = {
    events: [
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'content_block_stop', index: 0 }
    ]
  }

  it('is sent no more to a Chat Completions model after a 400 that names it', async () => {
    const sent = await request('chat_completions', (_body, index) => (index === 0 ? refusal('Unsupported parameter: reasoning_effort') : chatText('ok')), { effort: 'high' })
    expect((await chatCompletions(sent, never, collect().on)).content).toEqual([{ type: 'text', text: 'ok' }])
    await chatCompletions(sent, never, collect().on)
    expect(server!.requests.map((item) => item.body.reasoning_effort)).toEqual(['high', undefined, undefined])
  })

  it('is sent no more to a Messages model after a 400 that names thinking', async () => {
    const sent = await request('messages', (_body, index) => (index === 0 ? refusal('thinking.type: Input tag \'adaptive\' does not match') : messagesText), { effort: 'high' })
    expect((await anthropicMessages(sent, never, collect().on)).content).toEqual([{ type: 'text', text: 'ok' }])
    await anthropicMessages(sent, never, collect().on)
    expect(server!.requests.map((item) => [item.body.thinking, item.body.output_config])).toEqual([
      [{ type: 'adaptive', display: 'summarized' }, { effort: 'high' }],
      [undefined, undefined],
      [undefined, undefined]
    ])
  })

  it('is kept after a 400 about something else, and that error fails the call', async () => {
    const sent = await request('messages', () => refusal('max_tokens is too large'), { effort: 'high' })
    await expect(anthropicMessages(sent, never, collect().on)).rejects.toThrow('max_tokens is too large (HTTP 400)')
    expect(server!.requests).toHaveLength(1)
  })
})
