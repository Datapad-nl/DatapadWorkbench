import { WebContentsView } from 'electron'
import { join } from 'path'
import type { VoiceSettings } from '../shared/types'
import { VOICE_HELPER_DONE, VOICE_HELPER_JOB, type VoiceHelperJob, type VoiceHelperResult } from '../shared/voiceHelper'
import { devServerUrl } from './appUrl'
import { ensureVoiceModel } from './voice'

/**
 * Telegram's voice notes and spoken replies run on Web Audio, WebCodecs and web workers, so they need a page,
 * also with no window open. The helper is a WebContentsView that is never put in a window: it is no
 * BrowserWindow, so getAllWindows, getFocusedWindow, a notification click, the tray and the app's IPC
 * (isAppSender) never see it, and closing the app window still counts as no window open.
 */

/** The helper closes when it has had nothing to do for this long. */
export const IDLE_MS = 2 * 60_000
/** A job that runs longer than this closes the helper; a long voice note on a slow machine fits well inside. */
const JOB_MS = 10 * 60_000

type Pending = { job: VoiceHelperJob; resolve: (result: VoiceHelperResult) => void; reject: (error: Error) => void }

let view: WebContentsView | null = null
let loaded: Promise<void> | null = null
let idle: NodeJS.Timeout | undefined
let seq = 0
let running: (Pending & { timer: NodeJS.Timeout }) | null = null
const queue: Pending[] = []

function open(): { view: WebContentsView; loaded: Promise<void> } {
  if (view && loaded) return { view, loaded }
  const helper = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/voiceHelper.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Never shown, so Chromium would otherwise slow its timers down.
      backgroundThrottling: false
    }
  })
  const contents = helper.webContents
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event) => event.preventDefault())
  contents.on('render-process-gone', (_event, details) => {
    if (view === helper) close(new Error(`The voice helper stopped (${details.reason})`))
  })
  // Scoped to this page: the app's guarded ipcMain never takes the helper's messages, and this listener only its own.
  contents.ipc.on(VOICE_HELPER_DONE, (event, result: VoiceHelperResult) => {
    if (event.sender !== contents || view !== helper) return
    finish(result)
  })
  const dev = devServerUrl()
  const page = dev ? contents.loadURL(`${dev}/voiceHelper.html`) : contents.loadFile(join(__dirname, '../renderer/voiceHelper.html'))
  view = helper
  loaded = page
  page.catch((error: unknown) => {
    if (view === helper) close(error instanceof Error ? error : new Error('The voice helper did not load'))
  })
  return { view: helper, loaded: page }
}

/** Closes the helper and fails the job it was on. A job that waited gets a fresh helper. */
function close(error: Error): void {
  clearTimeout(idle)
  const helper = view
  view = null
  loaded = null
  const stopped = running
  running = null
  if (helper && !helper.webContents.isDestroyed()) helper.webContents.close()
  if (stopped) {
    clearTimeout(stopped.timer)
    stopped.reject(error)
  }
  if (queue.length > 0) next()
}

function finish(result: VoiceHelperResult): void {
  if (!running || running.job.id !== result.id) return
  const done = running
  running = null
  clearTimeout(done.timer)
  done.resolve(result)
  next()
}

function next(): void {
  if (running) return
  const pending = queue.shift()
  if (!pending) {
    clearTimeout(idle)
    idle = setTimeout(() => close(new Error('The voice helper closed')), IDLE_MS)
    return
  }
  clearTimeout(idle)
  const { view: helper, loaded: page } = open()
  const timer = setTimeout(() => close(new Error('The voice helper took too long')), JOB_MS)
  running = { ...pending, timer }
  page.then(
    () => {
      if (running?.job === pending.job && view === helper) helper.webContents.send(VOICE_HELPER_JOB, pending.job)
    },
    () => undefined
  )
}

type JobInput = { kind: 'transcribe'; audio: Uint8Array } | { kind: 'speak'; text: string; voice: VoiceSettings }

/** One job at a time, in the order they came. */
function runJob(input: JobInput): Promise<VoiceHelperResult> {
  return new Promise((resolve, reject) => {
    queue.push({ job: { ...input, id: ++seq }, resolve, reject })
    next()
  })
}

function failed(result: VoiceHelperResult): string | null {
  return 'error' in result ? result.error : null
}

/** A voice note in any format Chromium decodes, as text. The speech model is fetched before this, by channels. */
export async function transcribeVoiceNote(bytes: Buffer): Promise<string> {
  const result = await runJob({ kind: 'transcribe', audio: new Uint8Array(bytes) })
  const error = failed(result)
  if (error !== null) throw new Error(error)
  return 'text' in result ? result.text.trim() : ''
}

/** A reply spoken with the Settings voice, as an Ogg Opus voice memo. */
export async function speakVoiceMemo(text: string, voice: VoiceSettings): Promise<Buffer> {
  const model = await ensureVoiceModel()
  if (model.state !== 'ready') throw new Error(model.error || 'The speech model is not ready')
  const result = await runJob({ kind: 'speak', text, voice })
  const error = failed(result)
  if (error !== null) throw new Error(error)
  if (!('ogg' in result)) throw new Error('The voice helper returned no audio')
  return Buffer.from(result.ogg)
}
