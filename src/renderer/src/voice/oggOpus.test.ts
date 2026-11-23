import { describe, expect, it } from 'vitest'
import { oggCrc, oggOpusFile, oggPage, opusHead, opusPacketSamples } from './oggOpus'

/** The first page of a file ffmpeg's Ogg muxer wrote: OpusHead, mono, 312 samples pre-skip, 24 kHz input. */
const FFMPEG_HEAD_PAGE =
  '4f676753000200000000000000009f735b220000000093ce6aac01134f7075734865616401013801c05d0000000000'

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

type Page = { flags: number; granule: bigint; serial: number; sequence: number; crc: number; lacing: number[]; body: Uint8Array }

/** Reads the pages back, checking each one's CRC. */
function readPages(file: Uint8Array): Page[] {
  const pages: Page[] = []
  let offset = 0
  while (offset < file.length) {
    const view = new DataView(file.buffer, file.byteOffset + offset)
    expect(new TextDecoder().decode(file.subarray(offset, offset + 4))).toBe('OggS')
    const count = file[offset + 26]
    const lacing = [...file.subarray(offset + 27, offset + 27 + count)]
    const length = 27 + count + lacing.reduce((sum, value) => sum + value, 0)
    const raw = file.slice(offset, offset + length)
    const crc = view.getUint32(22, true)
    raw.fill(0, 22, 26)
    expect(oggCrc(raw)).toBe(crc)
    pages.push({
      flags: file[offset + 5],
      granule: view.getBigInt64(6, true),
      serial: view.getUint32(14, true),
      sequence: view.getUint32(18, true),
      crc,
      lacing,
      body: file.subarray(offset + 27 + count, offset + length)
    })
    offset += length
  }
  return pages
}

/** A 20 ms CELT packet (TOC config 31, one frame) of the given size. */
function packet(size: number): Uint8Array {
  const bytes = new Uint8Array(size).fill(0x55)
  bytes[0] = 31 << 3
  return bytes
}

describe('ogg opus writer', () => {
  it('computes the Ogg CRC', () => {
    // CRC-32/CKSUM without its final xor.
    expect(oggCrc(new TextEncoder().encode('123456789'))).toBe(0x89a1897f)
  })

  it('writes the same OpusHead page as ffmpeg, CRC included', () => {
    const page = oggPage({
      packets: [opusHead({ channels: 1, preSkip: 312, inputSampleRate: 24000 })],
      granule: 0n,
      serial: 0x225b739f,
      sequence: 0,
      flags: 0x02
    })
    expect(hex(page)).toBe(FFMPEG_HEAD_PAGE)
  })

  it('laces a packet of 255 bytes with a closing zero', () => {
    const page = oggPage({ packets: [packet(255), packet(10)], granule: 0n, serial: 1, sequence: 0 })
    expect([...page.subarray(27, 27 + page[26])]).toEqual([255, 0, 10])
  })

  it('counts samples from the TOC byte', () => {
    expect(opusPacketSamples(packet(20))).toBe(960)
    // SILK 60 ms, two frames.
    expect(opusPacketSamples(new Uint8Array([(3 << 3) | 1, 0]))).toBe(5760)
    // CELT 2.5 ms, code 3 with 4 frames.
    expect(opusPacketSamples(new Uint8Array([(16 << 3) | 3, 4]))).toBe(480)
  })

  it('lays out head, tags and audio pages with granule positions at 48 kHz', () => {
    // 120 packets of 20 ms: 2.4 s, so three audio pages of about a second.
    const packets = Array.from({ length: 120 }, () => packet(80))
    const totalSamples = 120 * 960 - 500
    const file = oggOpusFile({ packets, preSkip: 312, inputSampleRate: 44100, totalSamples, serial: 0x1234 })
    const pages = readPages(file)
    expect(pages.map((page) => page.sequence)).toEqual([0, 1, 2, 3, 4])
    expect(pages.every((page) => page.serial === 0x1234)).toBe(true)

    expect(pages[0].flags).toBe(0x02)
    expect(pages[0].granule).toBe(0n)
    expect(new TextDecoder().decode(pages[0].body.subarray(0, 8))).toBe('OpusHead')
    expect(new DataView(pages[0].body.buffer, pages[0].body.byteOffset).getUint16(10, true)).toBe(312)
    expect(new DataView(pages[0].body.buffer, pages[0].body.byteOffset).getUint32(12, true)).toBe(44100)
    expect(pages[1].flags).toBe(0)
    expect(pages[1].granule).toBe(0n)
    expect(new TextDecoder().decode(pages[1].body.subarray(0, 8))).toBe('OpusTags')

    const audio = pages.slice(2)
    expect(audio.map((page) => page.lacing.length)).toEqual([50, 50, 20])
    expect(audio.map((page) => page.granule)).toEqual([312n + 50n * 960n, 312n + 100n * 960n, BigInt(312 + totalSamples)])
    expect(audio.map((page) => page.flags)).toEqual([0, 0, 0x04])
  })

  it('starts a new page before 255 segments', () => {
    // 2.5 ms packets of one segment each: 300 of them are under a second.
    const packets = Array.from({ length: 300 }, () => new Uint8Array([16 << 3, 1, 2]))
    const pages = readPages(oggOpusFile({ packets, preSkip: 0, inputSampleRate: 48000, totalSamples: 300 * 120, serial: 1 }))
    expect(pages.slice(2).map((page) => page.lacing.length)).toEqual([255, 45])
    expect(pages.slice(2).map((page) => page.granule)).toEqual([255n * 120n, 300n * 120n])
  })

  it('refuses to write a file with no audio', () => {
    expect(() => oggOpusFile({ packets: [], preSkip: 0, inputSampleRate: 48000, totalSamples: 0, serial: 1 })).toThrow()
  })
})
