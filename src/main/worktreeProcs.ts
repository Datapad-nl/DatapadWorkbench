import { execFile, execFileSync } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

const WORKTREE_MARKER = '/.workbench-worktrees/'
const REAP_MS = 30_000
const CPU_HITS = 2
const CPU_LIMIT = 80

let timer: ReturnType<typeof setInterval> | null = null
let reaping = false
const cpuHits = new Map<number, number>()

function isWorktreeCwd(cwd: string): boolean {
  return cwd.includes(WORKTREE_MARKER)
}

async function nodeCwds(): Promise<Array<{ pid: number; cwd: string }>> {
  try {
    const { stdout } = await execFileAsync(
      'lsof',
      ['-nP', '-a', '-d', 'cwd', '-c', 'node', '-c', 'npm', '-F', 'pn'],
      { timeout: 8_000, maxBuffer: 4 * 1024 * 1024 }
    )
    const found: Array<{ pid: number; cwd: string }> = []
    let pid = 0
    for (const line of stdout.split('\n')) {
      if (line.startsWith('p')) {
        pid = Number(line.slice(1))
        continue
      }
      if (!line.startsWith('n') || !pid) continue
      found.push({ pid, cwd: line.slice(1) })
    }
    return found
  } catch {
    return []
  }
}

async function cpuByPid(pids: number[]): Promise<Map<number, number>> {
  const map = new Map<number, number>()
  if (pids.length === 0) return map
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'pid=,pcpu=', '-p', pids.join(',')], {
      timeout: 5_000
    })
    for (const line of stdout.split('\n')) {
      const match = line.trim().match(/^(\d+)\s+([\d.]+)/)
      if (!match) continue
      map.set(Number(match[1]), Number(match[2]))
    }
  } catch {
    // process already gone
  }
  return map
}

function terminate(pids: number[]): void {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // already gone
    }
  }
}

/** SIGTERM, then SIGKILL the pids that still run from a matching folder a moment later. */
async function stopProcesses(pids: number[], matches: (cwd: string) => boolean): Promise<void> {
  terminate(pids)
  await new Promise((resolve) => setTimeout(resolve, 1_200))
  // A pid freed by SIGTERM can be reused, so look again rather than trust the old list.
  const left = new Set((await nodeCwds()).filter((item) => matches(item.cwd)).map((item) => item.pid))
  killForce(pids.filter((pid) => left.has(pid)))
}

function killForce(pids: number[]): void {
  for (const pid of pids) {
    try {
      process.kill(pid, 0)
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
}

export async function killProcessesUnder(root: string): Promise<number> {
  const prefix = root.endsWith('/') ? root : `${root}/`
  const under = (cwd: string): boolean => cwd === root || cwd.startsWith(prefix)
  const pids = [
    ...new Set(
      (await nodeCwds())
        .filter((item) => under(item.cwd))
        .map((item) => item.pid)
    )
  ]
  if (pids.length === 0) return 0
  await stopProcesses(pids, under)
  for (const pid of pids) cpuHits.delete(pid)
  return pids.length
}

export async function sweepWorktreeProcesses(): Promise<number> {
  const pids = [...new Set((await nodeCwds()).filter((item) => isWorktreeCwd(item.cwd)).map((item) => item.pid))]
  if (pids.length === 0) return 0
  await stopProcesses(pids, isWorktreeCwd)
  cpuHits.clear()
  return pids.length
}

async function reapRunaways(): Promise<void> {
  const worktree = (await nodeCwds()).filter((item) => isWorktreeCwd(item.cwd))
  const pids = [...new Set(worktree.map((item) => item.pid))]
  const cpu = await cpuByPid(pids)
  const live = new Set(pids)
  for (const pid of [...cpuHits.keys()]) {
    if (!live.has(pid)) cpuHits.delete(pid)
  }

  const hotRoots = new Set<string>()
  for (const item of worktree) {
    const usage = cpu.get(item.pid) ?? 0
    if (usage < CPU_LIMIT) {
      cpuHits.delete(item.pid)
      continue
    }
    const hits = (cpuHits.get(item.pid) ?? 0) + 1
    cpuHits.set(item.pid, hits)
    if (hits >= CPU_HITS) hotRoots.add(item.cwd)
  }

  for (const cwd of hotRoots) {
    await killProcessesUnder(cwd)
  }
}

export function sweepWorktreeProcessesSync(): number {
  let stdout = ''
  try {
    stdout = execFileSync('lsof', ['-nP', '-a', '-d', 'cwd', '-c', 'node', '-c', 'npm', '-F', 'pn'], {
      timeout: 5_000,
      encoding: 'utf8'
    })
  } catch (error) {
    const err = error as { stdout?: string }
    stdout = err.stdout ?? ''
  }
  const pids = new Set<number>()
  let pid = 0
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1))
      continue
    }
    if (!line.startsWith('n') || !pid) continue
    if (isWorktreeCwd(line.slice(1))) pids.add(pid)
  }
  killForce([...pids])
  cpuHits.clear()
  return pids.size
}

export function startWorktreeReaper(): void {
  if (timer) return
  timer = setInterval(() => {
    // A slow sweep (lsof, ps, kills) must not overlap the next one.
    if (reaping) return
    reaping = true
    void reapRunaways().finally(() => {
      reaping = false
    })
  }, REAP_MS)
  timer.unref()
}

export function stopWorktreeReaper(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
  cpuHits.clear()
}
