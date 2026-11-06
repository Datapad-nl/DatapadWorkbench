import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ updater: null as unknown as FakeUpdater }))

type FakeUpdater = EventEmitter & {
  checkForUpdatesAndNotify: ReturnType<typeof vi.fn>
  checkForUpdates: ReturnType<typeof vi.fn>
  quitAndInstall: ReturnType<typeof vi.fn>
}

vi.mock('electron', () => ({ app: { isPackaged: true } }))
// A getter, so each test's fresh import sees that test's updater.
vi.mock('electron-updater', () => ({
  get autoUpdater() {
    return fake.updater
  }
}))

const FOUR_HOURS = 4 * 60 * 60_000

async function load(): Promise<typeof import('./updater')> {
  vi.resetModules()
  return import('./updater')
}

beforeEach(() => {
  vi.useFakeTimers()
  fake.updater = Object.assign(new EventEmitter(), {
    checkForUpdatesAndNotify: vi.fn(async () => null),
    checkForUpdates: vi.fn(async () => null),
    quitAndInstall: vi.fn()
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('periodic update checks', () => {
  it('check at start, then every four hours', async () => {
    const updater = await load()
    updater.startUpdater()
    expect(fake.updater.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(FOUR_HOURS - 1)
    expect(fake.updater.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(fake.updater.checkForUpdatesAndNotify).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(FOUR_HOURS)
    expect(fake.updater.checkForUpdatesAndNotify).toHaveBeenCalledTimes(3)
    updater.stopUpdater()
  })

  it('skip a check while one is running or downloading, or an update waits for a restart', async () => {
    const updater = await load()
    updater.startUpdater()
    fake.updater.emit('checking-for-update')
    vi.advanceTimersByTime(FOUR_HOURS)
    expect(fake.updater.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1)

    fake.updater.emit('update-available', { version: '9.9.9' })
    vi.advanceTimersByTime(FOUR_HOURS)
    expect(fake.updater.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1)

    fake.updater.emit('update-downloaded', { version: '9.9.9' })
    vi.advanceTimersByTime(FOUR_HOURS)
    expect(fake.updater.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1)
    expect(await updater.checkForUpdates()).toEqual({ status: 'ready', version: '9.9.9' })
    expect(fake.updater.checkForUpdates).not.toHaveBeenCalled()
    updater.stopUpdater()
  })

  it('check again after a failed one', async () => {
    const updater = await load()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    updater.startUpdater()
    fake.updater.emit('checking-for-update')
    fake.updater.emit('error', new Error('offline'))
    expect(updater.getUpdateState()).toEqual({ status: 'error', message: 'offline' })
    vi.advanceTimersByTime(FOUR_HOURS)
    expect(fake.updater.checkForUpdatesAndNotify).toHaveBeenCalledTimes(2)
    updater.stopUpdater()
  })

  it('stop when stopUpdater is called', async () => {
    const updater = await load()
    updater.startUpdater()
    updater.stopUpdater()
    vi.advanceTimersByTime(3 * FOUR_HOURS)
    expect(fake.updater.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('a downloaded update', () => {
  it('stays installable when a later check fails', async () => {
    const updater = await load()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    updater.startUpdater()
    fake.updater.emit('update-downloaded', { version: '9.9.9' })
    fake.updater.emit('error', new Error('offline'))
    expect(updater.getUpdateState()).toEqual({ status: 'ready', version: '9.9.9' })
    updater.installUpdate()
    expect(fake.updater.quitAndInstall).toHaveBeenCalledTimes(1)
    updater.stopUpdater()
  })

  it('stays installable when a manual check rejects after it finished downloading', async () => {
    const updater = await load()
    updater.startUpdater()
    fake.updater.checkForUpdates.mockImplementation(async () => {
      fake.updater.emit('update-downloaded', { version: '9.9.9' })
      throw new Error('late failure')
    })
    expect(await updater.checkForUpdates()).toEqual({ status: 'ready', version: '9.9.9' })
    updater.stopUpdater()
  })
})
