import { randomUUID } from 'crypto'
import { createRpc, RpcError } from './rpc'
import { COMMANDS, Session, type SessionHost, type SessionParams } from './session'
import type { Provider } from './types'

const VERSION = '1.0.0'

const PERMISSION_OPTIONS = [
  { optionId: 'allow_once', kind: 'allow_once', name: 'Allow' },
  { optionId: 'reject_once', kind: 'reject_once', name: 'Reject' }
]

export type Agent = {
  /** Text from the app, in chunks of any size. */
  feed: (chunk: string) => void
  /** Stop every session: its turn, its command and its MCP servers. */
  close: () => Promise<void>
}

type Params = SessionParams & {
  sessionId?: unknown
  prompt?: unknown
  modeId?: unknown
  configId?: unknown
  value?: unknown
  providers?: unknown
}

function providersFrom(value: unknown): Provider[] {
  if (!Array.isArray(value)) return []
  return (value as Provider[]).filter(
    (provider) => provider && typeof provider.id === 'string' && typeof provider.baseUrl === 'string' && Array.isArray(provider.models)
  )
}

/** The ACP agent: `write` takes each line for the app, `home` is where transcripts are kept. */
export function createAgent(write: (line: string) => void, options: { home?: string }): Agent {
  // Keys stay in this variable: they are never written to disk or to the log.
  let providers: Provider[] = []
  const sessions = new Map<string, Session>()
  const log = (line: string): void => void process.stderr.write(`[agent] ${line}\n`)

  const host: SessionHost = {
    home: options.home,
    providers: () => providers,
    update: (sessionId, update) => rpc.notify('session/update', { sessionId, update }),
    permission: (sessionId, toolCall) => rpc.request('session/request_permission', { sessionId, toolCall, options: PERMISSION_OPTIONS }),
    log
  }

  // After the result, as Grok does, so the app knows the session when the list comes.
  const announce = (sessionId: string): void =>
    void setImmediate(() => host.update(sessionId, { sessionUpdate: 'available_commands_update', availableCommands: COMMANDS }))

  const session = (params: Params): Session => {
    const found = typeof params.sessionId === 'string' ? sessions.get(params.sessionId) : undefined
    if (!found) throw new RpcError(-32602, `Unknown session: ${String(params.sessionId)}`)
    return found
  }

  const onRequest = async (method: string, raw: unknown): Promise<unknown> => {
    const params = (raw && typeof raw === 'object' ? raw : {}) as Params
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: 1,
          agentInfo: { name: 'workbench-agent', title: 'Datapad Workbench agent', version: VERSION },
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: true },
            mcpCapabilities: { http: true, sse: true }
          },
          authMethods: []
        }
      case 'session/new': {
        const created = await Session.create(host, randomUUID(), params)
        sessions.set(created.id, created)
        announce(created.id)
        return { sessionId: created.id, modes: created.modes() }
      }
      case 'session/load': {
        const id = String(params.sessionId)
        // A live session of this id ends first, so its last lines are in the file that is read.
        const live = sessions.get(id)
        sessions.delete(id)
        await live?.close()
        const loaded = await Session.load(host, id, params)
        sessions.set(id, loaded)
        announce(id)
        return { modes: loaded.modes() }
      }
      case 'session/prompt':
        return session(params).prompt(params.prompt)
      case 'session/cancel':
        session(params).cancel()
        return {}
      case 'session/set_mode':
        session(params).setMode(String(params.modeId))
        return {}
      case 'session/set_config_option': {
        const target = session(params)
        const inner = params.value && typeof params.value === 'object' ? (params.value as { value?: unknown }).value : params.value
        const value = typeof inner === 'string' ? inner : ''
        if (params.configId === 'model') target.setModel(value)
        else if (params.configId === 'reasoning_effort') target.setEffort(value)
        else throw new RpcError(-32602, `Unknown config option: ${String(params.configId)}`)
        return {}
      }
      case 'session/close': {
        const target = session(params)
        sessions.delete(target.id)
        await target.close()
        return {}
      }
      default:
        throw new RpcError(-32601, `Method not found: ${method}`)
    }
  }

  const onNotification = (method: string, raw: unknown): void => {
    const params = (raw && typeof raw === 'object' ? raw : {}) as Params
    if (method === '_workbench/providers') providers = providersFrom(params.providers)
    else if (method === 'session/cancel' && typeof params.sessionId === 'string') sessions.get(params.sessionId)?.cancel()
  }

  const rpc = createRpc(write, onRequest, onNotification)

  return {
    feed: rpc.feed,
    close: async () => {
      const open = [...sessions.values()]
      sessions.clear()
      await Promise.allSettled(open.map((item) => item.close()))
    }
  }
}
