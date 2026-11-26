/** One conversation in a shape neither API owns; each model client converts it to its own. */
export type TextBlock = { type: 'text'; text: string }
export type ImageBlock = { type: 'image'; mimeType: string; data: string }
/** `raw` is the Messages API's own block, sent back unchanged so its signature stays valid. */
export type ThinkingBlock = { type: 'thinking'; text: string; raw?: unknown }
/** `error` is set when the model's arguments were not valid JSON: the call is answered without running. */
export type ToolCallBlock = { type: 'tool_call'; id: string; name: string; input: Record<string, unknown>; error?: string }
export type ToolResultBlock = { type: 'tool_result'; id: string; content: Array<TextBlock | ImageBlock>; isError?: boolean }
export type Block = TextBlock | ImageBlock | ThinkingBlock | ToolCallBlock | ToolResultBlock
export type Message = { role: 'user' | 'assistant'; content: Block[] }

export type ProviderModel = {
  key: string
  id: string
  name: string
  contextWindow?: number
  efforts?: string[]
  images?: boolean
}

export type Provider = {
  id: string
  name: string
  backend: 'chat_completions' | 'responses' | 'messages'
  baseUrl: string
  apiKey: string
  headers?: Record<string, string>
  models: ProviderModel[]
}

export type ToolSpec = { name: string; description: string; schema: Record<string, unknown> }

export type ModelRequest = {
  provider: Provider
  model: ProviderModel
  system: string
  messages: Message[]
  tools: ToolSpec[]
  effort?: string
}

export type ModelReply = {
  /** Thinking, text and tool calls, in the order the model gave them. */
  content: Block[]
  /** Tokens this call held in context: input, cached input and output. 0 when the provider gave no numbers. */
  used: number
  outputTokens: number
  /** The reply was cut off at the output limit. */
  truncated: boolean
}

export type StreamHandlers = { onText: (text: string) => void; onThought: (text: string) => void }

export type ModelClient = (request: ModelRequest, signal: AbortSignal, on: StreamHandlers) => Promise<ModelReply>
