import { errorMessage, parseToolInput, postStream, postWithEffort, providerError, sseData } from './http'
import type { Block, Message, ModelClient } from './types'

const MAX_OUTPUT_TOKENS = 32_000

/** Anthropic's own API takes the key in `x-api-key`; other Messages endpoints, such as OpenRouter's, a bearer token. */
function isAnthropicHost(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === 'api.anthropic.com'
  } catch {
    return false
  }
}

function toContent(blocks: Block[]): unknown[] {
  return blocks.flatMap((block): unknown[] => {
    switch (block.type) {
      case 'text':
        return block.text ? [{ type: 'text', text: block.text }] : []
      case 'image':
        return [{ type: 'image', source: { type: 'base64', media_type: block.mimeType, data: block.data } }]
      case 'thinking':
        // Only a block this API signed can go back; another model's reasoning is left out.
        return block.raw ? [block.raw] : []
      case 'tool_call':
        return [{ type: 'tool_use', id: block.id, name: block.name, input: block.input }]
      case 'tool_result':
        return [
          {
            type: 'tool_result',
            tool_use_id: block.id,
            content: toContent(block.content),
            ...(block.isError ? { is_error: true } : {})
          }
        ]
    }
  })
}

export function toAnthropicMessages(messages: Message[]): unknown[] {
  return messages
    .map((message) => ({ role: message.role, content: toContent(message.content) }))
    .filter((message) => message.content.length > 0)
}

type Event = {
  type?: string
  index?: number
  message?: { usage?: Usage }
  usage?: Usage
  content_block?: { type?: string; id?: string; name?: string; data?: string }
  delta?: { type?: string; text?: string; thinking?: string; signature?: string; partial_json?: string; stop_reason?: string }
  error?: unknown
}

type Usage = {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

type Open = { type: string; id: string; name: string; text: string; json: string; signature: string; data: string }

/** The Anthropic Messages API, streamed. */
export const anthropicMessages: ModelClient = async (request, signal, on) => {
  const { provider, model } = request
  const own = isAnthropicHost(provider.baseUrl)
  const auth: Record<string, string> = !provider.apiKey
    ? {}
    : own
      ? { 'x-api-key': provider.apiKey }
      : { authorization: `Bearer ${provider.apiKey}` }
  const url = `${provider.baseUrl.replace(/\/+$/, '')}/messages`
  const response = await postWithEffort(`${url} ${model.id}`, /thinking|output_config|effort/i, Boolean(request.effort), (effort) =>
    postStream(
      url,
      { 'anthropic-version': '2023-06-01', ...auth, ...provider.headers },
      {
        model: model.id,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: request.system,
        messages: toAnthropicMessages(request.messages),
        stream: true,
        // Each call sends the whole conversation again, so the part already sent is read from the cache.
        ...(own ? { cache_control: { type: 'ephemeral' } } : {}),
        ...(request.tools.length > 0
          ? { tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.schema })) }
          : {}),
        ...(effort && request.effort
          ? { thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: request.effort } }
          : {})
      },
      signal
    )
  )

  const content: Block[] = []
  const open = new Map<number, Open>()
  let input = 0
  let outputTokens = 0
  let truncated = false
  for await (const data of sseData(response)) {
    let event: Event
    try {
      event = JSON.parse(data) as Event
    } catch {
      continue
    }
    if (event.type === 'error') throw providerError(errorMessage(data, 'The provider reported an error'))
    // Anthropic counts the input in message_start; some compatible endpoints only in message_delta.
    const usage = event.type === 'message_start' ? event.message?.usage : event.type === 'message_delta' ? event.usage : undefined
    if (usage) {
      const counted = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)
      if (counted > 0) input = counted
      if (usage.output_tokens !== undefined) outputTokens = usage.output_tokens
    }
    if (event.type === 'message_delta') {
      if (event.delta?.stop_reason === 'max_tokens') truncated = true
    } else if (event.type === 'content_block_start' && event.index !== undefined) {
      const block = event.content_block ?? {}
      open.set(event.index, {
        type: block.type ?? '',
        id: block.id ?? '',
        name: block.name ?? '',
        text: '',
        json: '',
        signature: '',
        data: block.data ?? ''
      })
    } else if (event.type === 'content_block_delta' && event.index !== undefined) {
      const block = open.get(event.index)
      const delta = event.delta
      if (!block || !delta) continue
      if (delta.type === 'text_delta' && delta.text) {
        block.text += delta.text
        on.onText(delta.text)
      } else if (delta.type === 'thinking_delta' && delta.thinking) {
        block.text += delta.thinking
        on.onThought(delta.thinking)
      } else if (delta.type === 'signature_delta' && delta.signature) {
        block.signature += delta.signature
      } else if (delta.type === 'input_json_delta' && delta.partial_json) {
        block.json += delta.partial_json
      }
    } else if (event.type === 'content_block_stop' && event.index !== undefined) {
      const block = open.get(event.index)
      open.delete(event.index)
      if (!block) continue
      if (block.type === 'text') {
        if (block.text) content.push({ type: 'text', text: block.text })
      } else if (block.type === 'thinking') {
        content.push({
          type: 'thinking',
          text: block.text,
          raw: { type: 'thinking', thinking: block.text, signature: block.signature }
        })
      } else if (block.type === 'redacted_thinking') {
        content.push({ type: 'thinking', text: '', raw: { type: 'redacted_thinking', data: block.data } })
      } else if (block.type === 'tool_use') {
        content.push({ type: 'tool_call', id: block.id, name: block.name, ...parseToolInput(block.json) })
      }
    }
  }
  return { content, used: input + outputTokens, outputTokens, truncated }
}
