import { RpcError } from './rpc'

const RETRIES = 3
const MAX_WAIT_MS = 30_000

/** A provider's own words for a failure, with the HTTP status when there was one. */
export function providerError(message: string, status?: number): RpcError {
  return new RpcError(-32000, status ? `${message} (HTTP ${status})` : message, status ? { status } : undefined)
}

/** The message in an error body: `{ error: { message } }`, `{ error: '…' }` or `{ message }`; else the text itself. */
export function errorMessage(body: string, fallback: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown }
    const error = parsed.error as { message?: unknown; metadata?: { raw?: unknown } } | string | undefined
    if (typeof error === 'string' && error) return error
    if (error && typeof error === 'object' && typeof error.message === 'string') {
      // OpenRouter keeps the upstream provider's reason here.
      const raw = error.metadata?.raw
      return typeof raw === 'string' && raw ? `${error.message}: ${raw}` : error.message
    }
    if (typeof parsed.message === 'string' && parsed.message) return parsed.message
  } catch {
    // not JSON
  }
  return body.trim().slice(0, 500) || fallback
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (): void => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', done)
      resolve()
    }, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}

function retryAfterMs(response: Response, attempt: number): number {
  const header = response.headers.get('retry-after')
  if (header !== null) {
    const seconds = Number(header)
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now()
    if (Number.isFinite(ms)) return Math.min(Math.max(ms, 0), MAX_WAIT_MS)
  }
  return 1000 * 2 ** attempt
}

/** POST a JSON body and return the streaming response. 429 and 5xx are tried again a few times. */
export async function postStream(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...headers },
      body: JSON.stringify(body),
      signal
    })
    if (response.ok) return response
    const text = await response.text().catch(() => '')
    const retryable = response.status === 429 || response.status >= 500
    if (!retryable || attempt >= RETRIES) {
      throw providerError(errorMessage(text, response.statusText || 'Request failed'), response.status)
    }
    await sleep(retryAfterMs(response, attempt), signal)
  }
}

/** Models whose API refused the effort fields: for the rest of the process they are sent none. */
const effortRefused = new Set<string>()

/**
 * Post with the effort fields, or without them for a model that refused them. A 400 whose message names
 * one of the fields (`refusal`) is tried once more without them, and the model is remembered.
 */
export async function postWithEffort(
  model: string,
  refusal: RegExp,
  effort: boolean,
  post: (effort: boolean) => Promise<Response>
): Promise<Response> {
  const send = effort && !effortRefused.has(model)
  try {
    return await post(send)
  } catch (error) {
    const status = error instanceof RpcError ? (error.data as { status?: unknown } | undefined)?.status : undefined
    if (!send || status !== 400 || !refusal.test((error as Error).message)) throw error
    effortRefused.add(model)
    return post(false)
  }
}

/** The `data:` payloads of a server-sent event stream, one per event, until the stream or `[DONE]` ends it. */
export async function* sseData(response: Response): AsyncGenerator<string> {
  if (!response.body) return
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true })
    let end = buffer.indexOf('\n')
    while (end !== -1) {
      const line = buffer.slice(0, end).replace(/\r$/, '')
      buffer = buffer.slice(end + 1)
      end = buffer.indexOf('\n')
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') return
      if (data) yield data
    }
  }
}

/** A tool call's arguments as the model streamed them. Not an object is an error the model is told about. */
export function parseToolInput(json: string): { input: Record<string, unknown>; error?: string } {
  if (!json.trim()) return { input: {} }
  try {
    const parsed = JSON.parse(json) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { input: parsed as Record<string, unknown> }
    return { input: {}, error: 'The tool arguments must be a JSON object.' }
  } catch (error) {
    return { input: {}, error: `The tool arguments were not valid JSON: ${(error as Error).message}` }
  }
}
