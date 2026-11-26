import { randomUUID } from 'crypto'
import { errorMessage, parseToolInput, postStream, postWithEffort, providerError, sseData } from './http'
import type { Block, ImageBlock, Message, ModelClient, TextBlock } from './types'

type Part = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

function parts(blocks: Array<TextBlock | ImageBlock>): Part[] {
  return blocks.map((block) =>
    block.type === 'text'
      ? { type: 'text', text: block.text }
      : { type: 'image_url', image_url: { url: `data:${block.mimeType};base64,${block.data}` } }
  )
}

function text(blocks: Block[]): string {
  return blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
}

/** The conversation as Chat Completions messages. A tool result's images follow it in a user message. */
export function toChatMessages(system: string, messages: Message[]): unknown[] {
  const out: unknown[] = [{ role: 'system', content: system }]
  for (const message of messages) {
    if (message.role === 'assistant') {
      const calls = message.content.flatMap((block) =>
        block.type === 'tool_call'
          ? [{ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input) } }]
          : []
      )
      out.push({ role: 'assistant', content: text(message.content), ...(calls.length > 0 ? { tool_calls: calls } : {}) })
      continue
    }
    const rest: Array<TextBlock | ImageBlock> = []
    for (const block of message.content) {
      if (block.type === 'tool_result') {
        out.push({ role: 'tool', tool_call_id: block.id, content: text(block.content) || '(no output)' })
        rest.push(...block.content.filter((item) => item.type === 'image'))
      } else if (block.type === 'text' || block.type === 'image') {
        rest.push(block)
      }
    }
    if (rest.length > 0) {
      out.push({ role: 'user', content: rest.every((block) => block.type === 'text') ? text(rest) : parts(rest) })
    }
  }
  return out
}

type Chunk = {
  error?: unknown
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null
  choices?: Array<{
    finish_reason?: string | null
    delta?: {
      content?: string | null
      reasoning?: string | null
      reasoning_content?: string | null
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>
    }
  }>
}

/** An OpenAI-compatible Chat Completions endpoint, streamed. */
export const chatCompletions: ModelClient = async (request, signal, on) => {
  const { provider, model } = request
  const url = `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`
  const response = await postWithEffort(`${url} ${model.id}`, /reasoning/i, Boolean(request.effort), (effort) =>
    postStream(
      url,
      { ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}), ...provider.headers },
      {
        model: model.id,
        messages: toChatMessages(request.system, request.messages),
        stream: true,
        stream_options: { include_usage: true },
        ...(request.tools.length > 0
          ? {
              tools: request.tools.map((tool) => ({
                type: 'function',
                function: { name: tool.name, description: tool.description, parameters: tool.schema }
              }))
            }
          : {}),
        ...(effort && request.effort ? { reasoning_effort: request.effort === 'max' ? 'xhigh' : request.effort } : {})
      },
      signal
    )
  )

  let reply = ''
  let thought = ''
  let used = 0
  let outputTokens = 0
  let truncated = false
  const calls: Array<{ id: string; name: string; args: string }> = []
  for await (const data of sseData(response)) {
    let chunk: Chunk
    try {
      chunk = JSON.parse(data) as Chunk
    } catch {
      continue
    }
    // Some providers report a failure inside a stream that began with 200.
    if (chunk.error) throw providerError(errorMessage(data, 'The provider reported an error'))
    if (chunk.usage) {
      outputTokens = chunk.usage.completion_tokens ?? 0
      used = (chunk.usage.prompt_tokens ?? 0) + outputTokens
    }
    const choice = chunk.choices?.[0]
    if (!choice) continue
    if (choice.finish_reason === 'length') truncated = true
    const delta = choice.delta
    if (!delta) continue
    const reasoning = delta.reasoning ?? delta.reasoning_content
    if (reasoning) {
      thought += reasoning
      on.onThought(reasoning)
    }
    if (delta.content) {
      reply += delta.content
      on.onText(delta.content)
    }
    for (const part of delta.tool_calls ?? []) {
      // A call's id and name come once; its arguments arrive in pieces under the same index.
      const index = part.index ?? (part.id ? calls.length : Math.max(calls.length - 1, 0))
      const call = (calls[index] ??= { id: '', name: '', args: '' })
      if (part.id) call.id = part.id
      if (part.function?.name) call.name += part.function.name
      if (part.function?.arguments) call.args += part.function.arguments
    }
  }

  const content: Block[] = []
  if (thought) content.push({ type: 'thinking', text: thought })
  if (reply) content.push({ type: 'text', text: reply })
  for (const call of calls) {
    if (!call) continue
    content.push({ type: 'tool_call', id: call.id || `call_${randomUUID()}`, name: call.name, ...parseToolInput(call.args) })
  }
  return { content, used, outputTokens, truncated }
}
