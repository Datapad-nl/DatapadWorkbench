import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'

const forked = vi.hoisted(() => ({
  calls: [] as Array<{ script: string; args: string[]; env: NodeJS.ProcessEnv; serviceName?: string }>,
  posted: [] as Array<string | null>,
  child: null as null | import('events').EventEmitter
}))
vi.mock('electron', async () => {
  const { EventEmitter } = await import('events')
  const { PassThrough } = await import('stream')
  return {
    app: { getPath: () => '/user-data', getAppPath: () => process.cwd() },
    utilityProcess: {
      fork: (script: string, args: string[], options: { env: NodeJS.ProcessEnv; serviceName?: string }) => {
        forked.calls.push({ script, args, env: options.env, serviceName: options.serviceName })
        const child = Object.assign(new EventEmitter(), {
          stdout: new PassThrough(),
          stderr: new PassThrough(),
          postMessage: (data: string | null) => forked.posted.push(data),
          kill: () => {
            child.emit('exit', 0)
            return true
          }
        })
        forked.child = child
        return child
      }
    }
  }
})

import { startWorkbenchAgent } from './workbenchAgent'

describe('the app’s own agent in a utility process', () => {
  it('forks the built file itself, with its home and without Electron as Node, and feeds it over the parent port', async () => {
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '1')
    const proc = startWorkbenchAgent()
    vi.unstubAllEnvs()
    const call = forked.calls[0]
    expect(call.script).toBe(join(__dirname, 'workbenchAgent.js'))
    expect(call.args).toEqual([])
    expect(call.serviceName).toBe('Workbench agent')
    expect(call.env.WB_AGENT_HOME).toBe(join('/user-data', 'workbench', 'agent'))
    expect(call.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(call.env.PATH).toBe(process.env.PATH)

    proc.stdin.write('{"id":1}\n')
    expect(forked.posted).toEqual([])
    forked.child?.emit('spawn')
    expect(forked.posted).toEqual(['{"id":1}\n'])
    await new Promise<void>((resolve) => proc.stdin.end(resolve))
    expect(forked.posted).toEqual(['{"id":1}\n', null])
  })
})
