/**
 * An Ogg Opus file from raw Opus packets, as RFC 7845 lays it out: an OpusHead page, an OpusTags page,
 * then the audio pages with granule positions counted at 48 kHz. Telegram shows only this as a voice memo.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let crc = i << 24
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1
    table[i] = crc >>> 0
  }
  return table
})()

/** Ogg's CRC-32: polynomial 0x04C11DB7, not reflected, starting at 0 with no final xor. */
export function oggCrc(bytes: Uint8Array): number {
  let crc = 0
  for (const byte of bytes) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0
  return crc
}

const HEADER_BOS = 0x02
const HEADER_EOS = 0x04
const MAX_SEGMENTS = 255

/** One page holding whole packets. A packet is never split across pages here; Opus packets are far smaller. */
export function oggPage(input: { packets: Uint8Array[]; granule: bigint; serial: number; sequence: number; flags?: number }): Uint8Array {
  const lacing: number[] = []
  for (const packet of input.packets) {
    for (let left = packet.length; ; left -= 255) {
      lacing.push(Math.min(left, 255))
      if (left < 255) break
    }
  }
  if (lacing.length > MAX_SEGMENTS) throw new Error('Too many packets for one Ogg page')
  const bodyLength = input.packets.reduce((sum, packet) => sum + packet.length, 0)
  const page = new Uint8Array(27 + lacing.length + bodyLength)
  const view = new DataView(page.buffer)
  page.set([0x4f, 0x67, 0x67, 0x53]) // OggS
  page[4] = 0
  page[5] = input.flags ?? 0
  view.setBigInt64(6, input.granule, true)
  view.setUint32(14, input.serial >>> 0, true)
  view.setUint32(18, input.sequence >>> 0, true)
  page[26] = lacing.length
  page.set(lacing, 27)
  let offset = 27 + lacing.length
  for (const packet of input.packets) {
    page.set(packet, offset)
    offset += packet.length
  }
  view.setUint32(22, oggCrc(page), true)
  return page
}

export function opusHead(input: { channels: number; preSkip: number; inputSampleRate: number }): Uint8Array {
  const head = new Uint8Array(19)
  const view = new DataView(head.buffer)
  head.set(new TextEncoder().encode('OpusHead'))
  head[8] = 1
  head[9] = input.channels
  view.setUint16(10, input.preSkip, true)
  view.setUint32(12, input.inputSampleRate, true)
  view.setInt16(16, 0, true)
  head[18] = 0
  return head
}

export function opusTags(vendor: string): Uint8Array {
  const name = new TextEncoder().encode(vendor)
  const tags = new Uint8Array(8 + 4 + name.length + 4)
  const view = new DataView(tags.buffer)
  tags.set(new TextEncoder().encode('OpusTags'))
  view.setUint32(8, name.length, true)
  tags.set(name, 12)
  view.setUint32(12 + name.length, 0, true)
  return tags
}

const FRAME_SAMPLES_SILK = [480, 960, 1920, 2880]
const FRAME_SAMPLES_HYBRID = [480, 960]
const FRAME_SAMPLES_CELT = [120, 240, 480, 960]

/** How many 48 kHz samples one Opus packet holds, from its TOC byte (RFC 6716, 3.1). */
export function opusPacketSamples(packet: Uint8Array): number {
  if (packet.length === 0) return 0
  const config = packet[0] >> 3
  const frame =
    config < 12 ? FRAME_SAMPLES_SILK[config % 4] : config < 16 ? FRAME_SAMPLES_HYBRID[config % 2] : FRAME_SAMPLES_CELT[config % 4]
  const code = packet[0] & 3
  const frames = code === 0 ? 1 : code === 3 ? (packet[1] ?? 0) & 0x3f : 2
  return frame * frames
}

/** About a second of audio per page. */
const PAGE_SAMPLES = 48_000

/**
 * The whole file. `totalSamples` is the length of the audio at 48 kHz before encoding, so the last
 * granule position tells a player to drop the encoder's padding at the end.
 */
export function oggOpusFile(input: {
  packets: Uint8Array[]
  preSkip: number
  inputSampleRate: number
  totalSamples: number
  serial: number
  channels?: number
  vendor?: string
}): Uint8Array {
  if (input.packets.length === 0) throw new Error('No Opus audio to write')
  const pages: Uint8Array[] = []
  let sequence = 0
  const page = (packets: Uint8Array[], granule: bigint, flags = 0): void => {
    pages.push(oggPage({ packets, granule, serial: input.serial, sequence: sequence++, flags }))
  }
  page([opusHead({ channels: input.channels ?? 1, preSkip: input.preSkip, inputSampleRate: input.inputSampleRate })], 0n, HEADER_BOS)
  page([opusTags(input.vendor ?? 'Datapad Workbench')], 0n)

  const end = input.preSkip + input.totalSamples
  let granule = input.preSkip
  let batch: Uint8Array[] = []
  let segments = 0
  let batchSamples = 0
  input.packets.forEach((packet, index) => {
    const needed = Math.floor(packet.length / 255) + 1
    if (needed > MAX_SEGMENTS) throw new Error('Opus packet too large for one Ogg page')
    if (batch.length > 0 && (segments + needed > MAX_SEGMENTS || batchSamples >= PAGE_SAMPLES)) {
      page(batch, BigInt(granule))
      batch = []
      segments = 0
      batchSamples = 0
    }
    batch.push(packet)
    segments += needed
    const samples = opusPacketSamples(packet)
    batchSamples += samples
    granule += samples
    if (index === input.packets.length - 1) page(batch, BigInt(Math.min(granule, end)), HEADER_EOS)
  })
  const file = new Uint8Array(pages.reduce((sum, item) => sum + item.length, 0))
  let offset = 0
  for (const item of pages) {
    file.set(item, offset)
    offset += item.length
  }
  return file
}
