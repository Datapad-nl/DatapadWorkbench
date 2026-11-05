import { createReadStream } from 'fs'
import { createInterface } from 'readline'

/**
 * The rows of a JSONL file, streamed chunk by chunk. Session transcripts run past 100 MB,
 * and reading one in a single synchronous call froze every window until it was parsed.
 */
export async function* jsonLines(path: string): AsyncGenerator<unknown> {
  const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity })
  for await (const line of lines) {
    const text = line.trim()
    if (!text.startsWith('{')) continue
    try {
      yield JSON.parse(text)
    } catch {
      // partial or corrupt line
    }
  }
}
