import { describe, expect, it } from 'vitest'
import { MAX_BACKGROUND_TASKS, applyTaskMessage, endBackgroundTasks, type BackgroundTask } from './backgroundTasks'

const NOW = '2026-11-17T12:00:00.000Z'

function run(messages: unknown[], start: BackgroundTask[] = []): BackgroundTask[] {
  return messages.reduce<BackgroundTask[]>((tasks, message) => applyTaskMessage(tasks, message, NOW), start)
}

const started = (id: string, extra: Record<string, unknown> = {}): unknown => ({
  type: 'system',
  subtype: 'task_started',
  task_id: id,
  description: 'Poll the site',
  task_type: 'local_bash',
  is_backgrounded: true,
  ...extra
})

const live = (...tasks: Record<string, unknown>[]): unknown => ({
  type: 'system',
  subtype: 'background_tasks_changed',
  tasks
})

const notice = (id: string, status: string, summary = ''): unknown => ({
  type: 'system',
  subtype: 'task_notification',
  task_id: id,
  status,
  summary,
  output_file: '/tmp/out'
})

describe('applyTaskMessage', () => {
  it('adds a running task from task_started', () => {
    expect(run([started('b1')])).toEqual([
      { id: 'b1', title: 'Poll the site', status: 'running', summary: '', startedAt: NOW }
    ])
  })

  it('falls back to the task type for the title', () => {
    expect(run([started('b1', { description: '' })])[0].title).toBe('local_bash')
  })

  it('leaves out a command that runs in the foreground', () => {
    const none: BackgroundTask[] = []
    expect(applyTaskMessage(none, started('b1', { is_backgrounded: false }), NOW)).toBe(none)
  })

  it('stops a running task the live set no longer holds', () => {
    const tasks = run([started('b1'), started('b2'), live({ task_id: 'b2', task_type: 'local_bash', description: 'x' })])
    expect(tasks.map((task) => task.status)).toEqual(['stopped', 'running'])
  })

  it('adds a task the live set holds that it did not see start', () => {
    const [task] = run([live({ task_id: 'm1', task_type: 'local_monitor', description: 'Watch the log' })])
    expect(task).toMatchObject({ id: 'm1', title: 'Watch the log', status: 'running' })
  })

  it('returns the same array when the live set changes nothing', () => {
    const tasks = run([started('b1')])
    expect(applyTaskMessage(tasks, live({ task_id: 'b1', task_type: 'local_bash', description: 'x' }), NOW)).toBe(tasks)
  })

  it('gives a task its end state and summary from task_notification', () => {
    const tasks = run([started('b1'), started('b2'), started('b3')])
    const ended = run([notice('b1', 'completed', 'Site is up'), notice('b2', 'failed', 'exit 1'), notice('b3', 'stopped')], tasks)
    expect(ended.map(({ status, summary }) => ({ status, summary }))).toEqual([
      { status: 'done', summary: 'Site is up' },
      { status: 'error', summary: 'exit 1' },
      { status: 'stopped', summary: '' }
    ])
  })

  it('takes the notification after the live set already dropped the task', () => {
    const [task] = run([started('b1'), live(), notice('b1', 'completed', 'Site is up')])
    expect(task).toMatchObject({ status: 'done', summary: 'Site is up' })
  })

  it('never shows an ambient task or an agent', () => {
    const tasks = run([
      started('w1', { ambient: true }),
      started('a1', { task_type: 'local_agent' }),
      live(
        { task_id: 'w1', task_type: 'local_bash', description: 'watcher', ambient: true },
        { task_id: 'a1', task_type: 'local_agent', description: 'agent' }
      ),
      notice('a1', 'completed', 'done')
    ])
    expect(tasks).toEqual([])
  })

  it('drops a task once the live set calls it ambient', () => {
    const tasks = run([started('b1'), live({ task_id: 'b1', task_type: 'local_bash', description: 'x', ambient: true })])
    expect(tasks).toEqual([])
  })

  it('ignores other messages and unknown tasks', () => {
    const tasks = run([started('b1')])
    expect(applyTaskMessage(tasks, { type: 'system', subtype: 'compact_boundary' }, NOW)).toBe(tasks)
    expect(applyTaskMessage(tasks, notice('zz', 'completed'), NOW)).toBe(tasks)
  })

  it('drops the oldest tasks past the limit', () => {
    const tasks = run(Array.from({ length: MAX_BACKGROUND_TASKS + 2 }, (_, index) => started(`b${index}`)))
    expect(tasks).toHaveLength(MAX_BACKGROUND_TASKS)
    expect(tasks[0].id).toBe('b2')
  })
})

describe('endBackgroundTasks', () => {
  it('stops the tasks that still run, and leaves the rest', () => {
    const tasks = run([started('b1'), started('b2'), notice('b2', 'completed', 'ok')])
    expect(endBackgroundTasks(tasks).map((task) => task.status)).toEqual(['stopped', 'done'])
    const settled = endBackgroundTasks(tasks)
    expect(endBackgroundTasks(settled)).toBe(settled)
  })
})
