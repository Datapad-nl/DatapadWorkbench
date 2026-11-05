import { app, net, protocol, shell, systemPreferences } from 'electron'
import { createWriteStream } from 'fs'
import { mkdir, stat } from 'fs/promises'
import { join, normalize, sep } from 'path'
import { pathToFileURL } from 'url'
import { finished } from 'stream/promises'
import { Readable } from 'stream'
import type { VoiceModelStatus } from '../shared/types'
import { mediaSchemePrivilege } from './media'
import { visualSchemePrivilege } from './visuals'

const SCHEME = 'workbench-model'

type ModelPack = { id: string; files: string[] }

const PACKS: ModelPack[] = [
  {
    id: 'Xenova/whisper-tiny.en',
    files: [
      'added_tokens.json',
      'config.json',
      'generation_config.json',
      'normalizer.json',
      'preprocessor_config.json',
      'special_tokens_map.json',
      'tokenizer.json',
      'tokenizer_config.json',
      'onnx/encoder_model.onnx',
      'onnx/decoder_model_merged_q4.onnx'
    ]
  },
  {
    // Supertone archived Supertonic in 2026. The archive keeps the weights.
    id: 'supertone-oss-archive/supertonic-3',
    files: [
      'onnx/tts.json',
      'onnx/unicode_indexer.json',
      'onnx/duration_predictor.onnx',
      'onnx/text_encoder.onnx',
      'onnx/vector_estimator.onnx',
      'onnx/vocoder.onnx',
      'voice_styles/F1.json',
      'voice_styles/F2.json',
      'voice_styles/F3.json',
      'voice_styles/F4.json',
      'voice_styles/F5.json',
      'voice_styles/M1.json',
      'voice_styles/M2.json',
      'voice_styles/M3.json',
      'voice_styles/M4.json',
      'voice_styles/M5.json'
    ]
  }
]

const ALL_FILES = PACKS.flatMap((pack) => pack.files.map((file) => ({ id: pack.id, file })))

let inflight: Promise<void> | null = null
const listeners = new Set<(status: VoiceModelStatus) => void>()
let status: VoiceModelStatus = {
  ready: false,
  downloading: false,
  error: null,
  file: null,
  loadedBytes: 0,
  totalBytes: 0
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

async function fileReady(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile() && info.size > 0
  } catch {
    return false
  }
}

async function modelReady(): Promise<boolean> {
  for (const item of ALL_FILES) {
    if (!(await fileReady(join(packDir(item.id), item.file)))) return false
  }
  return true
}

async function downloadFile(id: string, rel: string, dest: string): Promise<number> {
  const url = `https://huggingface.co/${id}/resolve/main/${rel}`
  const response = await net.fetch(url, { redirect: 'follow' })
  if (!response.ok || !response.body) {
    throw new Error(`Could not download ${rel} (${response.status})`)
  }
  await mkdir(join(dest, '..'), { recursive: true })
  const out = createWriteStream(dest)
  await finished(Readable.fromWeb(response.body as never).pipe(out))
  const info = await stat(dest)
  return info.size
}

export async function ensureVoiceModel(): Promise<VoiceModelStatus> {
  if (await modelReady()) {
    emit({
      ready: true,
      downloading: false,
      error: null,
      file: null,
      loadedBytes: 0,
      totalBytes: 0
    })
    return status
  }
  if (inflight) {
    await inflight
    return status
  }
  inflight = (async () => {
    emit({
      ready: false,
      downloading: true,
      error: null,
      file: ALL_FILES[0]?.file ?? null,
      loadedBytes: 0,
      totalBytes: ALL_FILES.length
    })
    try {
      let done = 0
      for (const item of ALL_FILES) {
        emit({
          ready: false,
          downloading: true,
          error: null,
          file: item.file,
          loadedBytes: done,
          totalBytes: ALL_FILES.length
        })
        const dest = join(packDir(item.id), item.file)
        if (!(await fileReady(dest))) {
          await downloadFile(item.id, item.file, dest)
        }
        done += 1
      }
      emit({
        ready: true,
        downloading: false,
        error: null,
        file: null,
        loadedBytes: ALL_FILES.length,
        totalBytes: ALL_FILES.length
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not download the local speech model'
      emit({
        ready: false,
        downloading: false,
        error: message,
        file: status.file,
        loadedBytes: status.loadedBytes,
        totalBytes: ALL_FILES.length
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
