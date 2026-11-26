/** An error whose code and message go to the other side as they are. */
export class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown
  ) {
    super(message)
  }
}

type Incoming = {
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string }
}

export type Rpc = {
  /** Text from the other side, in chunks of any size. */
  feed: (chunk: string) => void
  request: (method: string, params: unknown) => Promise<unknown>
  notify: (method: string, params: unknown) => void
}

/**
 * Newline-delimited JSON-RPC 2.0 over `write`. `onRequest` answers a request (a thrown error becomes the
 * error response) and `onNotification` takes a message without an id.
 */
export function createRpc(
  write: (line: string) => void,
  onRequest: (method: string, params: unknown) => Promise<unknown>,
  onNotification: (method: string, params: unknown) => void
): Rpc {
  let buffer = ''
  let nextId = 1
  const pending = new Map<number | string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  const send = (message: Record<string, unknown>): void => write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')

  const handle = (line: string): void => {
    let message: Incoming
    try {
      message = JSON.parse(line) as Incoming
    } catch {
      send({ id: null, error: { code: -32700, message: 'Parse error' } })
      return
    }
    if (!message || typeof message !== 'object') return
    if (typeof message.method === 'string') {
      const { id, method, params } = message
      if (id === undefined || id === null) {
        try {
          onNotification(method, params)
        } catch (error) {
          process.stderr.write(`[agent] ${method} failed: ${error instanceof Error ? error.message : String(error)}\n`)
        }
        return
      }
      onRequest(method, params).then(
        (result) => send({ id, result: result ?? {} }),
        (error: unknown) => {
          const known = error instanceof RpcError
          send({
            id,
            error: {
              code: known ? error.code : -32603,
              message: error instanceof Error ? error.message : String(error),
              ...(known && error.data !== undefined ? { data: error.data } : {})
            }
          })
        }
      )
      return
    }
    if (message.id === undefined || message.id === null) return
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(message.error.message || 'Request failed'))
    else waiter.resolve(message.result)
  }

  return {
    feed(chunk) {
      buffer += chunk
      let end = buffer.indexOf('\n')
      while (end !== -1) {
        const line = buffer.slice(0, end).trim()
        buffer = buffer.slice(end + 1)
        if (line) handle(line)
        end = buffer.indexOf('\n')
      }
    },
    request(method, params) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        send({ id, method, params })
      })
    },
    notify(method, params) {
      send({ method, params })
    }
  }
}
