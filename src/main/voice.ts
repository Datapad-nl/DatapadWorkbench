import { app, net, protocol, shell, systemPreferences } from 'electron'
import { createWriteStream } from 'fs'
import { mkdir, rename, rm, stat, writeFile } from 'fs/promises'
import { join, normalize, sep } from 'path'
import { pathToFileURL } from 'url'
import { pipeline } from 'stream/promises'
import { Readable, Transform } from 'stream'
import type { VoiceModelStatus } from '../shared/types'
import { mediaSchemePrivilege } from './media'
import { visualSchemePrivilege } from './visuals'

const SCHEME = 'workbench-model'

/** Each file with its byte size on Hugging Face, which shows a file an older build left cut short. */
type ModelPack = { id: string; files: Record<string, number> }

const PACKS: ModelPack[] = [
  {
    id: 'Xenova/whisper-tiny.en',
    files: {
      'added_tokens.json': 2082,
      'config.json': 2202,
      'generation_config.json': 1590,
      'normalizer.json': 52666,
      'preprocessor_config.json': 339,
      'special_tokens_map.json': 1717,
      'tokenizer.json': 2128494,
      'tokenizer_config.json': 835,
      'onnx/encoder_model.onnx': 32909539,
      'onnx/decoder_model_merged_q4.onnx': 86737938
    }
  },
  {
    // Supertone archived Supertonic in 2026. The archive keeps the weights.
    id: 'supertone-oss-archive/supertonic-3',
    files: {
      'onnx/tts.json': 8253,
      'onnx/unicode_indexer.json': 277676,
      'onnx/duration_predictor.onnx': 3700147,
      'onnx/text_encoder.onnx': 36416150,
      'onnx/vector_estimator.onnx': 256534781,
      'onnx/vocoder.onnx': 101424195,
      'voice_styles/F1.json': 292046,
      'voice_styles/F2.json': 292423,
      'voice_styles/F3.json': 290794,
      'voice_styles/F4.json': 291808,
      'voice_styles/F5.json': 291479,
      'voice_styles/M1.json': 291748,
      'voice_styles/M2.json': 292055,
      'voice_styles/M3.json': 290198,
      'voice_styles/M4.json': 291522,
      'voice_styles/M5.json': 291469
    }
  }
]

const ALL_FILES = PACKS.flatMap((pack) =>
  Object.entries(pack.files).map(([file, size]) => ({ id: pack.id, file, size }))
)

let inflight: Promise<void> | null = null
const listeners = new Set<(status: VoiceModelStatus) => void>()
let status: VoiceModelStatus = {
  state: 'idle',
  error: null,
  file: null,
  filesDone: 0,
  filesTotal: 0
}

function modelsRoot(): string {
  return join(app.getPath('userData'), 'workbench', 'models')
}

function packDir(id: string): string {
  return join(modelsRoot(), ...id.split('/'))
}

function emit(next: VoiceModelStatus): void {
  status = next
  for (const listener of listeners) listener(next)
}

export function onVoiceModelStatus(listener: (status: VoiceModelStatus) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getVoiceModelStatus(): VoiceModelStatus {
  return status
}

/** Like getVoiceModelStatus, but files already on disk count as ready before anything ran. */
export async function readVoiceModelStatus(): Promise<VoiceModelStatus> {
  if (status.state === 'ready' || inflight) return status
  // A download may start while the files are checked; its status is the newer one.
  if ((await modelReady()) && !inflight && getVoiceModelStatus().state !== 'ready') {
    emit({ state: 'ready', error: null, file: null, filesDone: 0, filesTotal: 0 })
  }
  return status
}

export function registerVoiceScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
        bypassCSP: true
      }
    },
    mediaSchemePrivilege(),
    visualSchemePrivilege()
  ])
}

export function attachVoiceProtocol(): void {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url)
    const rel = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
    const root = modelsRoot()
    const target = normalize(join(root, rel))
    const prefix = root.endsWith(sep) ? root : root + sep
    if (target !== root && !target.startsWith(prefix)) {
      return new Response('Forbidden', { status: 403 })
    }
    return net.fetch(pathToFileURL(target).href)
  })
}

export type MicAccess = 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown'

export function getMicAccess(): MicAccess {
  if (process.platform !== 'darwin') return 'granted'
  return systemPreferences.getMediaAccessStatus('microphone')
}

export async function ensureMicAccess(): Promise<boolean> {
  if (process.platform !== 'darwin') return true
  const status = getMicAccess()
  if (status === 'granted') return true
  if (status === 'denied' || status === 'restricted') return false
  return systemPreferences.askForMediaAccess('microphone')
}

export function openMicPrivacySettings(): void {
  if (process.platform !== 'darwin') return
  void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone')
}

/** Written after a full download. Since then files only land whole, so a file only has to exist. */
function verifiedMarker(): string {
  return join(modelsRoot(), '.verified')
}

async function isVerified(): Promise<boolean> {
  try {
    await stat(verifiedMarker())
    return true
  } catch {
    return false
  }
}

async function fileReady(path: string, size: number, verified: boolean): Promise<boolean> {
  try {
    const info = await stat(path)
    // Older builds wrote in place, so a download they lost midway kept a short file.
    return info.isFile() && (verified ? info.size > 0 : info.size === size)
  } catch {
    return false
  }
}

async function modelReady(): Promise<boolean> {
  const verified = await isVerified()
  for (const item of ALL_FILES) {
    if (!(await fileReady(join(packDir(item.id), item.file), item.size, verified))) return false
  }
  return true
}

/** A download that receives nothing for this long is dropped. */
const DOWNLOAD_IDLE_MS = 30_000

async function downloadFile(id: string, rel: string, dest: string): Promise<number> {
  const url = `https://huggingface.co/${id}/resolve/main/${rel}`
  const controller = new AbortController()
  let idle: NodeJS.Timeout | undefined
  const touch = (): void => {
    clearTimeout(idle)
    idle = setTimeout(() => controller.abort(), DOWNLOAD_IDLE_MS)
  }
  touch()
  // Written beside the target and moved in place at the end, so a cut download never looks ready.
  const part = `${dest}.part`
  try {
    const response = await net.fetch(url, { redirect: 'follow', signal: controller.signal })
    if (!response.ok || !response.body) {
      throw new Error(`Could not download ${rel} (${response.status})`)
    }
    await mkdir(join(dest, '..'), { recursive: true })
    let bytes = 0
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length
        touch()
        callback(null, chunk)
      }
    })
    await pipeline(Readable.fromWeb(response.body as never), meter, createWriteStream(part), {
      signal: controller.signal
    })
    // With a content-encoding the header counts compressed bytes, not the decoded ones written here.
    const encoding = response.headers.get('content-encoding')
    const length = Number(response.headers.get('content-length'))
    if ((!encoding || encoding === 'identity') && length > 0 && bytes !== length) {
      throw new Error(`Download of ${rel} was cut short (${bytes} of ${length} bytes)`)
    }
    await rename(part, dest)
    return bytes
  } catch (error) {
    // A failed download leaves no half file behind on disk.
    await rm(part, { force: true }).catch(() => undefined)
    if (controller.signal.aborted) throw new Error(`Download of ${rel} stalled`)
    throw error
  } finally {
    clearTimeout(idle)
  }
}

export async function ensureVoiceModel(): Promise<VoiceModelStatus> {
  if (await modelReady()) {
    emit({
      state: 'ready',
      error: null,
      file: null,
      filesDone: 0,
      filesTotal: 0
    })
    return status
  }
  if (inflight) {
    await inflight
    return status
  }
  inflight = (async () => {
    emit({
      state: 'downloading',
      error: null,
      file: ALL_FILES[0]?.file ?? null,
      filesDone: 0,
      filesTotal: ALL_FILES.length
    })
    try {
      const verified = await isVerified()
      let done = 0
      for (const item of ALL_FILES) {
        emit({
          state: 'downloading',
          error: null,
          file: item.file,
          filesDone: done,
          filesTotal: ALL_FILES.length
        })
        const dest = join(packDir(item.id), item.file)
        if (!(await fileReady(dest, item.size, verified))) {
          await downloadFile(item.id, item.file, dest)
        }
        done += 1
      }
      await writeFile(verifiedMarker(), '')
      emit({
        state: 'ready',
        error: null,
        file: null,
        filesDone: ALL_FILES.length,
        filesTotal: ALL_FILES.length
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not download the local speech model'
      emit({
        state: 'error',
        error: message,
        file: status.file,
        filesDone: status.filesDone,
        filesTotal: ALL_FILES.length
      })
      throw error
    } finally {
      inflight = null
    }
  })()
  try {
    await inflight
  } catch {
    // status already recorded
  }
  return status
}
