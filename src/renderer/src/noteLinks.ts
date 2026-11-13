import type { KnowledgeNode } from '../../shared/types'

/** The href of a link to a vault note, followed by the note's id. */
export const NOTE_HREF = '#note:'

const CODE = /(```[\s\S]*?```|`[^`\n]*`)/
// `![[...]]` embeds a file instead of linking to it.
const WIKI = /(?<!!)\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g
// `%% ... %%` is an Obsidian comment, which Obsidian does not show.
const COMMENT = /%%[\s\S]*?%%/g

/** The note a wiki-link points at, resolved the way the main process draws the graph's edges. */
export function resolveNote(from: string, target: string, nodes: KnowledgeNode[]): string | null {
  const name = target.split('#')[0].trim().replace(/\.md$/i, '').replace(/^\.\//, '')
  if (!name) return null
  const paths = new Set(nodes.map((node) => node.path))
  const dir = from.split('/').slice(0, -1).join('/')
  for (const candidate of [`${name}.md`, name, dir ? `${dir}/${name}.md` : null]) {
    if (candidate && paths.has(candidate)) return candidate
  }
  const key = name.toLowerCase()
  const hits = nodes.filter(
    (node) =>
      node.title.toLowerCase() === key ||
      (node.path.split('/').pop() ?? '').replace(/\.md$/i, '').toLowerCase() === key
  )
  return hits.length === 1 ? hits[0].path : null
}

/** Turns a note's wiki-links into Markdown links to the notes they point at and drops its comments. Code is left as written. */
export function linkNotes(body: string, from: string, nodes: KnowledgeNode[]): string {
  return body
    .split(CODE)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part.replace(COMMENT, '').replace(WIKI, (_match, target: string, alias: string | undefined) => {
            const label = (alias ?? target).trim().replace(/[[\]]/g, '\\$&')
            const id = resolveNote(from, target, nodes)
            // A link to no note reads as its text, as Obsidian shows it.
            if (!id) return label
            const href = encodeURIComponent(id).replace(/[()]/g, (paren) => `%${paren.charCodeAt(0).toString(16)}`)
            return `[${label}](${NOTE_HREF}${href})`
          })
    )
    .join('')
}
