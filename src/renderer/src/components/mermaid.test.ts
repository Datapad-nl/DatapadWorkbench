import { describe, expect, it } from 'vitest'
import { isDarkColor, mermaidSource } from './mermaid'

const pre = (className: unknown, value: unknown): unknown => ({
  tagName: 'pre',
  children: [{ tagName: 'code', properties: { className }, children: [{ type: 'text', value }] }]
})

describe('mermaidSource', () => {
  it('takes the source of a mermaid block without its last newline', () => {
    expect(mermaidSource(pre(['language-mermaid'], 'graph TD\nA-->B\n'))).toBe('graph TD\nA-->B')
  })

  it('is null for other blocks and other nodes', () => {
    expect(mermaidSource(pre(['language-ts'], 'const a = 1'))).toBeNull()
    expect(mermaidSource(pre(undefined, 'graph TD'))).toBeNull()
    expect(mermaidSource({ tagName: 'pre', children: [{ tagName: 'span' }] })).toBeNull()
    expect(mermaidSource(undefined)).toBeNull()
  })
})

describe('isDarkColor', () => {
  it('tells dark from light', () => {
    expect(isDarkColor('rgb(20, 20, 20)')).toBe(true)
    expect(isDarkColor('rgb(250, 250, 248)')).toBe(false)
    expect(isDarkColor('rgba(255, 255, 255, 1)')).toBe(false)
  })

  it('counts a colour it cannot read as dark', () => {
    expect(isDarkColor('oklch(0.9 0.01 90)')).toBe(true)
  })
})
