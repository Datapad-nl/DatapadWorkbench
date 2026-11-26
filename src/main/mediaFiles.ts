import { existsSync, realpathSync, statSync } from 'fs'
import { homedir } from 'os'
import { isAbsolute, join, normalize, sep } from 'path'
import { fileURLToPath } from 'url'
import { mediaExtension } from '../shared/media'

function inside(root: string, target: string): boolean {
  const base = root.endsWith(sep) ? root : root + sep
  return target === root || target.startsWith(base)
}

function real(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

function candidatesFor(roots: string[], src: string): string[] {
  if (src.startsWith('file:')) {
    try {
      return [fileURLToPath(src)]
    } catch {
      return []
    }
  }
  if (src === '~' || src.startsWith('~/')) {
    return [join(homedir(), src.slice(2))]
  }
  if (isAbsolute(src)) return [src]
  const rel = src.replace(/^\.\//, '')
  return roots.map((root) => join(root, rel))
}

/**
 * The real file `src` names inside one of `roots`, and the root it is in, when `accept` takes it. A path,
 * encoded or symlinked, that ends outside every root resolves to nothing, as does a directory.
 */
export function resolveRootFile(
  roots: string[],
  rawSrc: string,
  accept: (file: string) => boolean = () => true
): { root: string; file: string } | null {
  const src = rawSrc.trim()
  if (!src || src.length > 4096 || /^(https?:|data:|blob:)/i.test(src)) return null
  const realRoots = roots.map((root) => real(root)).filter((root): root is string => Boolean(root))
  if (realRoots.length === 0) return null
  for (const candidate of candidatesFor(realRoots, src)) {
    const normalized = normalize(candidate)
    if (!existsSync(normalized)) continue
    try {
      if (!statSync(normalized).isFile()) continue
    } catch {
      continue
    }
    const target = real(normalized)
    if (!target || !accept(target)) continue
    const root = realRoots.find((item) => inside(item, target))
    if (!root) continue
    return { root, file: target }
  }
  return null
}

export function resolveMediaFile(roots: string[], rawSrc: string): string | null {
  return resolveRootFile(roots, rawSrc, (file) => Boolean(mediaExtension(file)))?.file ?? null
}
