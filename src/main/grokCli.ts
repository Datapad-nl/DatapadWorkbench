import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { DEFAULT_MODEL, type GrokChannel, type GrokCliInfo } from '../shared/types'

const TTL_MS = 60_000

let inflight: Promise<GrokCliInfo> | null = null
let cached: GrokCliInfo | null = null
let cachedAt = 0

export function grokBinary(): string {
  const homeBin = join(homedir(), '.grok', 'bin', 'grok')
  if (process.env.GROK_BIN && existsSync(process.env.GROK_BIN)) return process.env.GROK_BIN
  if (existsSync(homeBin)) return homeBin
  return 'grok'
}

/** What the last probe found, however old. Null until one has finished. */
export function peekGrokCliInfo(): GrokCliInfo | null {
  return cached
}

export async function getGrokCliInfo(): Promise<GrokCliInfo> {
  if (cached && Date.now() - cachedAt < TTL_MS) return cached
  if (inflight) return inflight
  inflight = probe()
    .then((info) => {
      cached = info
      cachedAt = Date.now()
      return info
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

function emptyInfo(path: string): GrokCliInfo {
  return {
    path,
    version: null,
    channel: 'unknown',
    models: [DEFAULT_MODEL]
  }
}

async function probe(): Promise<GrokCliInfo> {
  const path = grokBinary()
  const [versionText, modelsText] = await Promise.all([
    runGrok(path, ['--version'], 4_000),
    runGrok(path, ['models'], 8_000)
  ])
  const parsed = parseVersionLine(versionText)
  const models = parseModelsList(modelsText)
  if (!parsed.version) {
    return { ...emptyInfo(path), models: models.length > 0 ? models : [DEFAULT_MODEL] }
  }
  return {
    path,
    version: parsed.version,
    channel: parsed.channel,
    models: models.length > 0 ? models : [DEFAULT_MODEL]
  }
}

function runGrok(bin: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { timeout, encoding: 'utf8', maxBuffer: 256_000, env: process.env },
      (error, stdout, stderr) => {
        const text = `${stdout ?? ''}\n${stderr ?? ''}`.trim()
        if (error && !text) {
          resolve('')
          return
        }
        resolve(text)
      }
    )
  })
}

export function parseModelsList(text: string): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const line of text.split('\n')) {
    const match = /^\s*[*-]\s+(\S+)/.exec(line)
    if (!match) continue
    const id = match[1]
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

export function parseVersionLine(text: string): { version: string | null; channel: GrokChannel } {
  const tagged = /grok(?:\s+build)?\s+-?\s*v?(\d+\.\d+\.\d+\S*)\s*(?:\([^)]*\))?\s*\[([^\]]+)\]/i.exec(text)
  if (tagged) {
    return { version: tagged[1], channel: parseChannel(tagged[2]) }
  }
  const plain = /grok(?:\s+build)?\s+-?\s*v?(\d+\.\d+\.\d+\S*)/i.exec(text)
  return { version: plain?.[1] ?? null, channel: 'unknown' }
}

function parseChannel(raw: string): GrokChannel {
  const value = raw.trim().toLowerCase()
  if (value === 'stable' || value === 'alpha') return value
  return 'unknown'
}
