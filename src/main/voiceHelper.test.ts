import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_VOICE } from '../shared/types'
import type { VoiceHelperJob } from '../shared/voiceHelper'

/** A page in a WebContentsView: it keeps the jobs sent to it, and the test answers them. */
const fake = vi.hoisted(() => {
  type Page = {
    jobs: unknown[]
    closed: boolean
    url: string
    options: unknown
    events: Map<string, (...args: unknown[]) => void>
    ipc: import('events').EventEmitter
    contents: unknown
  }
  return { pages: [] as Page[], ensureVoiceModel: vi.fn(async () => ({ state: 'ready', error: null as string | null })) }
})

vi.mock('electron', () => {
  class WebContentsView {
    webContents: Record<string, unknown>
    constructor(options: unknown) {
      const page = {
        jobs: [] as unknown[],
        closed: false,
        url: '',
        options,
        events: new Map<string, (...args: unknown[]) => void>(),
        ipc: new EventEmitter(),
        contents: null as unknown
      }
      this.webContents = {
        ipc: page.ipc,
        on: (name: string, listener: (...args: unknown[]) => void) => page.events.set(name, listener),
        setWindowOpenHandler: () => {},
        loadURL: async (url: string) => {
          page.url = url
        },
        loadFile: async (path: string) => {
          page.url = path
        },
        send: (_channel: string, job: unknown) => page.jobs.push(job),
        isDestroyed: () => page.closed,
        close: () => {
          page.closed = true
        }
      }
      page.contents = this.webContents
      fake.pages.push(page)
    }
  }
  // The helper must never be a window.
  class BrowserWindow {
    constructor() {
      throw new Error('The voice helper made a BrowserWindow')
    }
  }
  return { WebContentsView, BrowserWindow }
})
vi.mock('./voice', () => ({ ensureVoiceModel: fake.ensureVoiceModel }))
vi.mock('./appUrl', () => ({ devServerUrl: () => null }))

let helper: typeof import('./voiceHelper')

function page(index = fake.pages.length - 1): (typeof fake.pages)[number] {
  return fake.pages[index]
}

/** The page's answer to its latest job, as the helper preload sends it. */
function answer(result: Record<string, unknown>, from?: unknown): void {
  const current = page()
  const job = current.jobs.at(-1) as VoiceHelperJob
  current.ipc.emit('voice-helper:done', { sender: from ?? current.contents }, { id: job.id, ...result })
}

async function jobs(count: number, index?: number): Promise<VoiceHelperJob[]> {
  await vi.waitFor(() => expect(page(index)?.jobs).toHaveLength(count))
  return page(index).jobs as VoiceHelperJob[]
}

beforeEach(async () => {
  fake.pages.length = 0
  fake.ensureVoiceModel.mockClear()
  vi.resetModules()
  helper = await import('./voiceHelper')
})
afterEach(() => vi.useRealTimers())

describe('voice helper', () => {
  it('opens a sandboxed page with its own preload and the helper page, on demand', async () => {
    expect(fake.pages).toHaveLength(0)
    const text = helper.transcribeVoiceNote(Buffer.from('ogg'))
    const [job] = await jobs(1)
    expect(page().options).toMatchObject({
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
    })
    expect(String((page().options as { webPreferences: { preload: string } }).webPreferences.preload)).toMatch(/preload[/\\]voiceHelper\.js$/)
    expect(page().url).toMatch(/renderer[/\\]voiceHelper\.html$/)
    expect(job).toMatchObject({ kind: 'transcribe', audio: new Uint8Array(Buffer.from('ogg')) })
    answer({ text: ' Kun je de build checken? ' })
    await expect(text).resolves.toBe('Kun je de build checken?')
  })

  it('runs one job at a time, in order', async () => {
    const first = helper.transcribeVoiceNote(Buffer.from('one'))
    const second = helper.transcribeVoiceNote(Buffer.from('two'))
    await jobs(1)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(page().jobs).toHaveLength(1)
    answer({ text: 'one' })
    await expect(first).resolves.toBe('one')
    const [, next] = await jobs(2)
    expect(next.kind === 'transcribe' && Buffer.from(next.audio).toString()).toBe('two')
    answer({ text: 'two' })
    await expect(second).resolves.toBe('two')
    expect(fake.pages).toHaveLength(1)
  })

  it('takes answers only from its own page', async () => {
    const text = helper.transcribeVoiceNote(Buffer.from('ogg'))
    await jobs(1)
    answer({ text: 'forged' }, { id: 'another page' })
    answer({ text: 'real' })
    await expect(text).resolves.toBe('real')
  })

  it('passes an error from the page on', async () => {
    const text = helper.transcribeVoiceNote(Buffer.from('ogg'))
    await jobs(1)
    answer({ error: 'Unable to decode audio data' })
    await expect(text).rejects.toThrow('Unable to decode audio data')
  })

  it('closes after two idle minutes and opens again for the next job', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const text = helper.transcribeVoiceNote(Buffer.from('ogg'))
    await jobs(1)
    answer({ text: 'hi' })
    await text
    vi.advanceTimersByTime(helper.IDLE_MS - 1000)
    expect(page().closed).toBe(false)
    vi.advanceTimersByTime(1000)
    expect(page().closed).toBe(true)
    vi.useRealTimers()
    const again = helper.transcribeVoiceNote(Buffer.from('ogg'))
    await jobs(1, 1)
    answer({ text: 'again' })
    await expect(again).resolves.toBe('again')
  })

  it('fails the job of a page that crashed and starts a fresh page for the next', async () => {
    const lost = helper.transcribeVoiceNote(Buffer.from('one'))
    const waiting = helper.transcribeVoiceNote(Buffer.from('two'))
    await jobs(1)
    page().events.get('render-process-gone')!({}, { reason: 'oom' })
    await expect(lost).rejects.toThrow('The voice helper stopped (oom)')
    expect(page(0).closed).toBe(true)
    await jobs(1, 1)
    answer({ text: 'two' })
    await expect(waiting).resolves.toBe('two')
  })

  it('speaks with the speech model ready and returns the Ogg file', async () => {
    const memo = helper.speakVoiceMemo('The build passed.', DEFAULT_VOICE)
    const [job] = await jobs(1)
    expect(fake.ensureVoiceModel).toHaveBeenCalled()
    expect(job).toMatchObject({ kind: 'speak', text: 'The build passed.', voice: DEFAULT_VOICE })
    answer({ ogg: new Uint8Array([0x4f, 0x67, 0x67, 0x53]) })
    await expect(memo).resolves.toEqual(Buffer.from('OggS'))
  })

  it('does not speak without the speech model', async () => {
    fake.ensureVoiceModel.mockResolvedValueOnce({ state: 'error', error: 'Download of onnx/vocoder.onnx stalled' })
    await expect(helper.speakVoiceMemo('Hi.', DEFAULT_VOICE)).rejects.toThrow('Download of onnx/vocoder.onnx stalled')
    expect(fake.pages).toHaveLength(0)
  })
})
