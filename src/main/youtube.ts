import {
  parseYoutubeVideoId,
  youtubeWatchUrl,
  type YoutubeTranscriptResult
} from '../shared/youtube'

const WATCH_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
const VR_UA =
  'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip'
const VR_VERSION = '1.65.10'
const FETCH_MS = 20_000

type CaptionTrack = {
  languageCode: string
  name: string
  kind: string
  baseUrl: string
}

type Cue = {
  startMs: number
  text: string
}

function formatTs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

function parseJson3(body: string): Cue[] {
  const parsed = JSON.parse(body) as {
    events?: Array<{ tStartMs?: number; segs?: Array<{ utf8?: string }> }>
  }
  const cues: Cue[] = []
  for (const event of parsed.events ?? []) {
    const text = (event.segs ?? [])
      .map((seg) => seg.utf8 ?? '')
      .join('')
      .replace(/\s+/g, ' ')
      .trim()
    if (!text) continue
    cues.push({ startMs: event.tStartMs ?? 0, text })
  }
  return cues
}

function parseXmlCues(body: string): Cue[] {
  const cues: Cue[] = []
  const textRe = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi
  let match: RegExpExecArray | null
  while ((match = textRe.exec(body))) {
    const start = Number(/start="([^"]+)"/.exec(match[1])?.[1] ?? 0)
    const inner = decodeEntities(match[2].replace(/<[^>]+>/g, ''))
      .replace(/\s+/g, ' ')
      .trim()
    if (!inner) continue
    cues.push({ startMs: Number.isFinite(start) ? Math.round(start * 1000) : 0, text: inner })
  }
  if (cues.length) return cues

  const pRe = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi
  while ((match = pRe.exec(body))) {
    const start = Number(/t="([^"]+)"/.exec(match[1])?.[1] ?? 0)
    const inner = decodeEntities(match[2].replace(/<[^>]+>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim()
    if (!inner) continue
    cues.push({ startMs: Number.isFinite(start) ? start : 0, text: inner })
  }
  return cues
}

function parseCues(body: string): Cue[] {
  const trimmed = body.trim()
  if (!trimmed) return []
  if (trimmed.startsWith('{')) {
    try {
      return parseJson3(trimmed)
    } catch {
      return []
    }
  }
  return parseXmlCues(trimmed)
}

function formatTranscript(cues: Cue[]): string {
  return cues.map((cue) => `[${formatTs(cue.startMs)}] ${cue.text}`).join('\n')
}

function pickTrack(tracks: CaptionTrack[], lang?: string): CaptionTrack | null {
  if (tracks.length === 0) return null
  const wanted = (lang ?? 'en').toLowerCase()
  const scored = tracks.map((track, index) => {
    const code = track.languageCode.toLowerCase()
    let score = 50 + index
    if (code === wanted || code.startsWith(`${wanted}-`)) score = track.kind === 'asr' ? 1 : 0
    else if (wanted === 'en' && (code === 'en' || code.startsWith('en-'))) {
      score = track.kind === 'asr' ? 3 : 2
    }
    return { track, score }
  })
  scored.sort((a, b) => a.score - b.score)
  return scored[0]?.track ?? null
}

function parseYtcfg(html: string): Record<string, unknown> | null {
  const match = html.match(/ytcfg\.set\s*\(\s*(\{.+?\})\s*\)\s*;/)
  if (!match) return null
  try {
    return JSON.parse(match[1]) as Record<string, unknown>
  } catch {
    return null
  }
}

function extractVisitor(html: string, cfg: Record<string, unknown> | null): string {
  const context = cfg?.INNERTUBE_CONTEXT as { client?: { visitorData?: string } } | undefined
  const fromCfg =
    context?.client?.visitorData ||
    (typeof cfg?.VISITOR_DATA === 'string' ? cfg.VISITOR_DATA : '') ||
    (typeof cfg?.EOM_VISITOR_DATA === 'string' ? cfg.EOM_VISITOR_DATA : '')
  if (fromCfg) return fromCfg
  return html.match(/"visitorData":"([^"]+)"/)?.[1] ?? ''
}

async function fetchWatchPage(videoId: string): Promise<{ html: string; cfg: Record<string, unknown> | null }> {
  const res = await fetch(youtubeWatchUrl(videoId), {
    headers: {
      'User-Agent': WATCH_UA,
      'Accept-Language': 'en-US,en;q=0.9'
    },
    signal: AbortSignal.timeout(FETCH_MS)
  })
  if (!res.ok) throw new Error(`YouTube watch page returned ${res.status}`)
  const html = await res.text()
  return { html, cfg: parseYtcfg(html) }
}

async function fetchPlayer(
  videoId: string,
  visitor: string,
  apiKey: string
): Promise<{
  title: string
  author: string
  durationSeconds: number
  tracks: CaptionTrack[]
}> {
  const url =
    'https://www.youtube.com/youtubei/v1/player?prettyPrint=false' +
    (apiKey ? `&key=${encodeURIComponent(apiKey)}` : '')
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'User-Agent': VR_UA,
      'Content-Type': 'application/json',
      'X-YouTube-Client-Name': '28',
      'X-YouTube-Client-Version': VR_VERSION,
      'X-Goog-Visitor-Id': visitor,
      Origin: 'https://www.youtube.com'
    },
    body: JSON.stringify({
      context: {
        client: {
          clientName: 'ANDROID_VR',
          clientVersion: VR_VERSION,
          deviceMake: 'Oculus',
          deviceModel: 'Quest 3',
          androidSdkVersion: 32,
          userAgent: VR_UA,
          osName: 'Android',
          osVersion: '12L',
          hl: 'en',
          gl: 'US',
          visitorData: visitor
        }
      },
      videoId,
      playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' } },
      contentCheckOk: true,
      racyCheckOk: true
    }),
    signal: AbortSignal.timeout(FETCH_MS)
  })
  if (!res.ok) throw new Error(`YouTube player returned ${res.status}`)
  const data = (await res.json()) as {
    playabilityStatus?: { status?: string; reason?: string }
    videoDetails?: { title?: string; author?: string; lengthSeconds?: string }
    captions?: {
      playerCaptionsTracklistRenderer?: {
        captionTracks?: Array<{
          languageCode?: string
          name?: { simpleText?: string }
          kind?: string
          baseUrl?: string
        }>
      }
    }
  }
  if (data.playabilityStatus?.status && data.playabilityStatus.status !== 'OK') {
    throw new Error(data.playabilityStatus.reason || data.playabilityStatus.status)
  }
  const raw = data.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []
  return {
    title: data.videoDetails?.title ?? '',
    author: data.videoDetails?.author ?? '',
    durationSeconds: Number(data.videoDetails?.lengthSeconds ?? 0),
    tracks: raw
      .filter((track) => track.baseUrl)
      .map((track) => ({
        languageCode: track.languageCode ?? '',
        name: track.name?.simpleText ?? track.languageCode ?? '',
        kind: track.kind ?? '',
        baseUrl: track.baseUrl ?? ''
      }))
  }
}

async function fetchCaptionBody(baseUrl: string): Promise<string> {
  for (const url of [`${baseUrl}&fmt=json3`, `${baseUrl}&fmt=srv3`, baseUrl]) {
    const res = await fetch(url, { headers: { 'User-Agent': VR_UA }, signal: AbortSignal.timeout(FETCH_MS) })
    const body = await res.text()
    if (res.ok && body.trim()) return body
  }
  return ''
}

export async function transcribeYoutube(input: string, lang?: string): Promise<YoutubeTranscriptResult> {
  const videoId = parseYoutubeVideoId(input)
  if (!videoId) {
    return { ok: false, error: 'Not a YouTube URL or video id' }
  }

  try {
    const { html, cfg } = await fetchWatchPage(videoId)
    const visitor = extractVisitor(html, cfg)
    const apiKey = typeof cfg?.INNERTUBE_API_KEY === 'string' ? cfg.INNERTUBE_API_KEY : ''
    const player = await fetchPlayer(videoId, visitor, apiKey)
    const track = pickTrack(player.tracks, lang)
    if (!track) {
      return {
        ok: false,
        videoId,
        error: player.title
          ? `No captions on “${player.title}”.`
          : 'This video has no captions, so there is nothing to transcribe.'
      }
    }

    const cues = parseCues(await fetchCaptionBody(track.baseUrl))
    if (cues.length === 0) {
      return { ok: false, videoId, error: 'Captions were listed but the transcript came back empty' }
    }

    return {
      ok: true,
      videoId,
      url: youtubeWatchUrl(videoId),
      title: player.title || videoId,
      author: player.author || '',
      durationSeconds: player.durationSeconds || 0,
      language: track.languageCode,
      languageName: track.name || track.languageCode,
      autoGenerated: track.kind === 'asr',
      text: formatTranscript(cues)
    }
  } catch (error) {
    return {
      ok: false,
      videoId,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
