import type { EditClash } from '../shared/types'
import type { PermissionParams } from './permissions'
import { filesThisTurn, pathsFromUpdate } from './checkpoints'
import { uncommittedPaths } from './git'
import { listChatEdits, listProjects, type ChatEdits } from './store'

/** The chat itself and the chats it works with: the ones that started it, it started, or it continues or hands off to. */
function family(chatId: string, chats: ChatEdits[]): Set<string> {
  const byId = new Map(chats.map((chat) => [chat.id, chat]))
  const ids = new Set([chatId])
  let grew = true
  while (grew) {
    grew = false
    for (const chat of chats) {
      const linked = [chat.parentChatId, chat.handoffFrom, chat.handoffTo].filter(
        (id): id is string => Boolean(id) && byId.has(id!)
      )
      const inside = ids.has(chat.id)
      if (inside) {
        for (const id of linked) {
          if (!ids.has(id)) {
            ids.add(id)
            grew = true
          }
        }
      } else if (linked.some((id) => ids.has(id))) {
        ids.add(chat.id)
        grew = true
      }
    }
  }
  return ids
}

/**
 * The other chat that last changed one of `paths`, and which of them it holds. A file is held by
 * whoever touched it last, so once this chat (or its family) has edited a file, it is no longer asked.
 * `paths` are relative to the project folder; only chats working in that folder count.
 */
export function findHolder(input: {
  chatId: string
  chats: ChatEdits[]
  paths: string[]
  thisTurn: (chatId: string) => string[]
}): { holder: ChatEdits; files: string[] } | null {
  const me = input.chats.find((chat) => chat.id === input.chatId)
  if (!me) return null
  const ours = family(me.id, input.chats.filter((chat) => chat.projectId === me.projectId))
  const inFolder = input.chats.filter((chat) => chat.projectId === me.projectId && !chat.worktreePath)
  const running = new Map(inFolder.map((chat) => [chat.id, new Set(input.thisTurn(chat.id))]))
  const touchedAt = (chat: ChatEdits, path: string): number => {
    if (running.get(chat.id)?.has(path)) return Number.POSITIVE_INFINITY
    const at = chat.touched[path]
    return at ? Date.parse(at) : Number.NEGATIVE_INFINITY
  }

  let holder: ChatEdits | null = null
  const files: string[] = []
  for (const path of input.paths) {
    let ourLast = Number.NEGATIVE_INFINITY
    let theirs: ChatEdits | null = null
    let theirLast = Number.NEGATIVE_INFINITY
    for (const chat of inFolder) {
      const at = touchedAt(chat, path)
      if (ours.has(chat.id)) ourLast = Math.max(ourLast, at)
      else if (at > theirLast) {
        theirLast = at
        theirs = chat
      }
    }
    if (!theirs || theirLast <= ourLast) continue
    if (holder && theirs.id !== holder.id) continue
    holder = theirs
    files.push(path)
  }
  return holder ? { holder, files } : null
}

/** The clash an edit by `chatId` would cause, or null when no other chat holds the files it changes. */
export async function findEditClash(
  chatId: string,
  toolCall: NonNullable<PermissionParams['toolCall']>,
  isRunning: (chatId: string) => boolean
): Promise<EditClash | null> {
  const chats = await listChatEdits()
  const me = chats.find((chat) => chat.id === chatId)
  // A chat in its own worktree shares its files with nobody outside its family.
  if (!me || me.worktreePath) return null
  if (!chats.some((chat) => chat.id !== chatId && chat.projectId === me.projectId && !chat.worktreePath)) {
    return null
  }
  const project = (await listProjects()).find((item) => item.id === me.projectId)
  if (!project?.path) return null
  const paths = pathsFromUpdate({ sessionUpdate: 'tool_call', ...toolCall }, project.path)
  const changed = await uncommittedPaths(project.path, paths)
  if (changed.length === 0) return null
  const found = findHolder({ chatId, chats, paths: changed, thisTurn: filesThisTurn })
  if (!found) return null
  return {
    chatId: found.holder.id,
    chatTitle: found.holder.title,
    files: found.files,
    running: isRunning(found.holder.id)
  }
}
