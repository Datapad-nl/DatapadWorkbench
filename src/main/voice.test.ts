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
