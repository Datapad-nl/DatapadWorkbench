/**
 * A shell command, monitor or other background task Claude Code runs for one chat, other than
 * its own agents (those are `BuiltinAgent`s). What is known about it comes from Claude Code's
 * raw SDK messages: `task_started`, `background_tasks_changed` and `task_notification`.
 */
export type BackgroundTask = {
  /** Claude Code's task id. */
  id: string
  /** The description the agent gave it, or its task type. */
  title: string
  status: 'running' | 'done' | 'error' | 'stopped'
  /** The summary from the notice that it ended. */
  summary: string
  startedAt: string
}

export type BackgroundTasksFeed = { chatId: string; tasks: BackgroundTask[] }

/** The most background tasks kept per chat. The oldest go first. */
export const MAX_BACKGROUND_TASKS = 12

type Fields = Record<string, unknown>

function fields(value: unknown): Fields {
  return value && typeof value === 'object' ? (value as Fields) : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Agents are shown as subagents, and ambient tasks are not activity. */
function shown(task: Fields): boolean {
  return task.ambient !== true && task.task_type !== 'local_agent'
}

function fresh(id: string, task: Fields, now: string): BackgroundTask {
  const title = text(task.description) || text(task.task_type) || 'Background task'
  return { id, title, status: 'running', summary: '', startedAt: now }
}

function added(tasks: BackgroundTask[], more: BackgroundTask[]): BackgroundTask[] {
  return [...tasks, ...more].slice(-MAX_BACKGROUND_TASKS)
}

/**
 * Applies one raw SDK message of the chat's session to its background tasks.
 * Returns the same array when the message changes nothing.
 */
export function applyTaskMessage(tasks: BackgroundTask[], message: unknown, now: string): BackgroundTask[] {
  const msg = fields(message)
  const subtype = text(msg.subtype)

  if (subtype === 'task_started') {
    const id = text(msg.task_id)
    // A foreground command blocks its tool call. It is not background work unless it is moved there.
    if (!id || !shown(msg) || msg.is_backgrounded === false || tasks.some((task) => task.id === id)) return tasks
    return added(tasks, [fresh(id, msg, now)])
  }

  // The full set of live tasks: the one authority on what still runs.
  if (subtype === 'background_tasks_changed') {
    const live = (Array.isArray(msg.tasks) ? msg.tasks : []).map(fields).filter((task) => text(task.task_id))
    const ambient = new Set(live.filter((task) => task.ambient === true).map((task) => text(task.task_id)))
    const running = new Map(live.filter(shown).map((task) => [text(task.task_id), task]))
    let changed = false
    const kept = tasks.flatMap((task) => {
      if (ambient.has(task.id)) {
        changed = true
        return []
      }
      if (task.status === 'running' && !running.has(task.id)) {
        changed = true
        return [{ ...task, status: 'stopped' as const }]
      }
      return [task]
    })
    const unknown = [...running].filter(([id]) => !kept.some((item) => item.id === id))
    if (!changed && unknown.length === 0) return tasks
    return added(kept, unknown.map(([id, task]) => fresh(id, task, now)))
  }

  // How a task ended. It may come after the set already dropped it.
  if (subtype === 'task_notification') {
    const id = text(msg.task_id)
    if (!tasks.some((task) => task.id === id)) return tasks
    const status = msg.status === 'completed' ? 'done' : msg.status === 'failed' ? 'error' : 'stopped'
    return tasks.map((task) => (task.id === id ? { ...task, status, summary: text(msg.summary) } : task))
  }

  return tasks
}

/** The session's process ended or the chat moved to another session: what still ran is stopped. */
export function endBackgroundTasks(tasks: BackgroundTask[]): BackgroundTask[] {
  if (!tasks.some((task) => task.status === 'running')) return tasks
  return tasks.map((task) => (task.status === 'running' ? { ...task, status: 'stopped' } : task))
}
