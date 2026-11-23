import { existsSync, mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ userData: '', fetch: vi.fn() }))
vi.mock('electron', () => ({
  app: { getPath: () => fake.userData },
  net: { fetch: (...args: unknown[]) => fake.fetch(...args) },
  protocol: {},
  shell: {},
  systemPreferences: {}
}))
vi.mock('./media', () => ({ mediaSchemePrivilege: () => ({}) }))
vi.mock('./visuals', () => ({ visualSchemePrivilege: () => ({}) }))

/** A body that sends some bytes and then breaks, like a dropped connection. */
function brokenBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(1000))
      setTimeout(() => controller.error(new Error('connection reset')), 10)
    }
  })
}

/** Every file still to download, with any half-written ones beside them. */
function partFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('.part'))
}

describe('voice model download', () => {
  beforeEach(() => {
    fake.userData = mkdtempSync(join(tmpdir(), 'voice-test-'))
    fake.fetch.mockReset()
    vi.resetModules()
  })
  afterEach(() => rmSync(fake.userData, { recursive: true, force: true }))

  it('leaves no .part file when the connection drops', async () => {
    fake.fetch.mockResolvedValue(new Response(brokenBody(), { headers: { 'content-length': '2082' } }))
    const { ensureVoiceModel } = await import('./voice')
    const status = await ensureVoiceModel()
    expect(status.state).toBe('error')
    expect(partFiles(join(fake.userData, 'workbench', 'models'))).toEqual([])
  })

  it('leaves no .part file when the download is cut short', async () => {
    fake.fetch.mockResolvedValue(new Response(new Uint8Array(1000), { headers: { 'content-length': '2082' } }))
    const { ensureVoiceModel } = await import('./voice')
    const status = await ensureVoiceModel()
    expect(status).toMatchObject({ state: 'error', error: expect.stringContaining('cut short') })
    expect(partFiles(join(fake.userData, 'workbench', 'models'))).toEqual([])
  })
})

describe('model packs', () => {
  const pack = { id: 'test/tiny', files: { 'a.json': 4, 'onnx/b.onnx': 6 } }

  beforeEach(() => {
    fake.userData = mkdtempSync(join(tmpdir(), 'voice-test-'))
    fake.fetch.mockReset()
    vi.resetModules()
  })
  afterEach(() => rmSync(fake.userData, { recursive: true, force: true }))

  function serve(): void {
    fake.fetch.mockImplementation(async (url: string) => new Response(new Uint8Array(url.endsWith('a.json') ? 4 : 6)))
  }

  it('says the size once, before it downloads, and not when the files are there', async () => {
    serve()
    const { ensureModelPack } = await import('./voice')
    const fetching = vi.fn()
    await Promise.all([ensureModelPack(pack, fetching), ensureModelPack(pack, fetching)])
    expect(fetching).toHaveBeenCalledTimes(1)
    expect(fetching).toHaveBeenCalledWith(10)
    expect(fake.fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://huggingface.co/test/tiny/resolve/main/a.json',
      'https://huggingface.co/test/tiny/resolve/main/onnx/b.onnx'
    ])
    await ensureModelPack(pack, fetching)
    expect(fetching).toHaveBeenCalledTimes(1)
    expect(fake.fetch).toHaveBeenCalledTimes(2)
  })

  it('fails a download and fetches what is missing on the next try', async () => {
    fake.fetch.mockImplementation(async (url: string) =>
      url.endsWith('a.json') ? new Response(new Uint8Array(4)) : new Response(null, { status: 503 })
    )
    const { ensureModelPack } = await import('./voice')
    const fetching = vi.fn()
    await expect(ensureModelPack(pack, fetching)).rejects.toThrow('Could not download onnx/b.onnx (503)')
    serve()
    await ensureModelPack(pack, fetching)
    expect(fetching.mock.calls).toEqual([[10], [6]])
  })

  it('does not count the voice note model as part of the in-app voice', async () => {
    const { VOICE_NOTE_PACK } = await import('./voice')
    expect(VOICE_NOTE_PACK.id).toBe('onnx-community/whisper-small')
    fake.fetch.mockResolvedValue(new Response(null, { status: 503 }))
    const { ensureVoiceModel } = await import('./voice')
    await ensureVoiceModel()
    expect(fake.fetch.mock.calls.some(([url]) => String(url).includes('whisper-small'))).toBe(false)
  })
})
