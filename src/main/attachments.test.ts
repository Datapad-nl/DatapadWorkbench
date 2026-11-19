import { describe, expect, it } from 'vitest'
import type { Attachment } from '../shared/types'
import { attachmentTitle, promptForAttachments, safeFileName } from './attachments'

const image: Attachment = { id: 'i1', mimeType: 'image/png', data: 'AAAA' }
const pdf: Attachment = { id: 'f1', mimeType: 'application/pdf', data: '', name: 'report.pdf', path: '/data/a/f1/report.pdf' }
const zip: Attachment = { id: 'f2', mimeType: 'application/zip', data: '', name: 'site.zip', path: '/data/a/f2/site.zip' }
const block = 'The user attached these files. Read them before answering.\n- /data/a/f1/report.pdf\n- /data/a/f2/site.zip'

describe('promptForAttachments', () => {
  it('sends images as images and leaves the text alone', () => {
    expect(promptForAttachments('Look at this', [image])).toEqual({ text: 'Look at this', images: [image] })
  })

  it('lists files as paths before the text and sends no image', () => {
    expect(promptForAttachments('Summarise', [pdf, zip])).toEqual({ text: `${block}\n\nSummarise`, images: [] })
  })

  it('splits a mix of images and files', () => {
    const { text, images } = promptForAttachments('Compare', [image, pdf, zip])
    expect(images).toEqual([image])
    expect(text).toBe(`${block}\n\nCompare`)
  })

  it('keeps a slash command at the start of the prompt', () => {
    expect(promptForAttachments('/review now', [pdf, zip]).text).toBe(`/review now\n\n${block}`)
  })

  it('makes the list the whole prompt when there is no text', () => {
    expect(promptForAttachments('', [pdf, zip]).text).toBe(block)
    expect(promptForAttachments('  ', [pdf, zip]).text).toBe(block)
    expect(promptForAttachments('', []).text).toBe('')
  })

  it('treats an attachment from an old chat, without a path, as an image', () => {
    expect(promptForAttachments('Hi').images).toEqual([])
    expect(promptForAttachments('Hi', [image]).images).toEqual([image])
  })
})

describe('safeFileName', () => {
  it('keeps only the last part of a path', () => {
    expect(safeFileName('notes.md')).toBe('notes.md')
    expect(safeFileName('../../etc/passwd')).toBe('passwd')
    expect(safeFileName('C:\\Users\\me\\a.zip')).toBe('a.zip')
  })

  it('falls back to a name for an empty or dot name', () => {
    expect(safeFileName('')).toBe('file')
    expect(safeFileName('  ')).toBe('file')
    expect(safeFileName('..')).toBe('file')
    expect(safeFileName('dir/')).toBe('file')
  })
})

describe('attachmentTitle', () => {
  it('names a message by its first file, or as a screenshot', () => {
    expect(attachmentTitle([image, pdf])).toBe('report.pdf')
    expect(attachmentTitle([image])).toBe('Screenshot')
  })
})
