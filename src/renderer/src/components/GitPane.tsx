import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  GitActionResult,
  GitChangeKind,
  GitDiffResult,
  GitFile,
  GitGraphNode,
  GitSnapshot
} from '../../../shared/types'
import { useWorkspace } from '../workspace'
import { CodeDiff } from './CodeDiff'
import { IconButton } from './icons'
import { ReorderGrip } from './ReorderGrip'

const empty: GitSnapshot = {
  projectId: null,
  chatId: null,
  path: null,
  available: false,
  reason: 'no-folder',
  error: null,
  branch: null,
  detached: false,
  ahead: 0,
  behind: 0,
  dirtyCount: 0,
  files: [],
  graph: [],
  merge: null
}

const LANE_COLORS = ['#c4a35a', '#7aa2c4', '#8fbf8f', '#c47aa2', '#c48f5a', '#8f8fc4']

function letter(kind: GitChangeKind | null): string {
  if (kind === 'conflict') return 'U'
  if (kind === 'untracked') return '?'
  if (kind === 'added') return 'A'
  if (kind === 'deleted') return 'D'
  if (kind === 'renamed') return 'R'
  if (kind === 'copied') return 'C'
  if (kind === 'modified') return 'M'
  return ''
}

function reasonCopy(snapshot: GitSnapshot): string {
  if (snapshot.reason === 'no-folder') return 'Attach a folder to this project to use git.'
  if (snapshot.reason === 'not-a-repo') return 'Not a git repository.'
  if (snapshot.reason === 'error') return snapshot.error || 'Could not read git status.'
  return 'Select a project.'
}

function Graph({ nodes }: { nodes: GitGraphNode[] }): React.JSX.Element {
  const maxLane = Math.max(0, ...nodes.map((node) => Math.max(node.lane, ...node.openLanes)))
  const laneW = 14
  const rowH = 30
  const pad = 8
  const width = (maxLane + 1) * laneW + pad * 2
  const height = Math.max(rowH, nodes.length * rowH)

  return (
    <svg width={width} height={height} className="shrink-0" aria-hidden="true">
      {nodes.map((node, index) => {
        const y = index * rowH + rowH / 2
        const x = pad + node.lane * laneW
        return (
          <g key={node.sha}>
            {node.openLanes.map((lane) => (
              <line
                key={`${node.sha}-l${lane}`}
                x1={pad + lane * laneW}
                y1={index * rowH}
                x2={pad + lane * laneW}
                y2={(index + 1) * rowH}
                stroke={LANE_COLORS[lane % LANE_COLORS.length]}
                strokeWidth="1.4"
                opacity="0.55"
              />
            ))}
            <circle
              cx={x}
              cy={y}
              r={node.isHead ? 4.5 : 3.5}
              fill={node.isHead ? 'var(--color-accent)' : LANE_COLORS[node.lane % LANE_COLORS.length]}
              stroke="var(--color-sidebar)"
              strokeWidth="1"
            />
          </g>
        )
      })}
    </svg>
  )
}

export function GitPane(): React.JSX.Element {
  const {
    projects,
    chats,
    activeProjectId,
    activeChatId,
    showGit,
    showBrowser,
    showActivity,
    showKnowledge,
    setShowGit,
    swapRightPanes,
    selectProject
  } = useWorkspace()
  const [snapshot, setSnapshot] = useState<GitSnapshot>(empty)
  const [selected, setSelected] = useState<{ path: string; staged: boolean } | null>(null)
  const [diff, setDiff] = useState<GitDiffResult | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [branchName, setBranchName] = useState('')
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)

  const project = projects.find((item) => item.id === activeProjectId) ?? null
  const activeChat = chats.find((item) => item.id === activeChatId) ?? null
  const gitChat = activeChat?.projectId === activeProjectId ? activeChat : null
  const gitChatId = gitChat?.id ?? null
  const snapshotForProject =
    snapshot.projectId === activeProjectId && (snapshot.chatId ?? null) === gitChatId
      ? snapshot
      : empty
  const otherPanes = showBrowser || showActivity || showKnowledge
  const viewKey = `${activeProjectId}:${gitChatId}`
  const viewRef = useRef(viewKey)

  useEffect(() => {
    viewRef.current = viewKey
  }, [viewKey])

  useEffect(() => {
    if (!showGit) {
      void window.workbench.setGitActiveProject(null)
      return
    }
    void window.workbench.setGitActiveProject(activeProjectId, gitChatId)
    return () => {
      void window.workbench.setGitActiveProject(null)
    }
  }, [showGit, activeProjectId, gitChatId])

  useEffect(() => {
    setSelected(null)
    setDiff(null)
    setError(null)
    setMessage('')
    setCreating(false)
    if (!activeProjectId) {
      setSnapshot(empty)
      return
    }
    let cancelled = false
    void window.workbench.getGitSnapshot(activeProjectId, gitChatId).then((next) => {
      if (!cancelled) setSnapshot(next)
    })
    const unsub = window.workbench.onGitSnapshot((next) => {
      if (next.projectId !== activeProjectId) return
      if ((next.chatId ?? null) !== gitChatId) return
      setSnapshot(next)
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [activeProjectId, gitChatId])

  useEffect(() => {
    if (!activeProjectId || !selected) {
      setDiff(null)
      return
    }
    let cancelled = false
    void window.workbench
      .getGitDiff(activeProjectId, selected.path, selected.staged, gitChatId)
      .then((next) => {
        if (!cancelled) setDiff(next)
      })
    return () => {
      cancelled = true
    }
  }, [activeProjectId, gitChatId, selected, snapshot.files])

  const stagedCount = useMemo(
    () => snapshot.files.filter((file) => file.staged).length,
    [snapshot.files]
  )

  async function run(action: () => Promise<GitActionResult>): Promise<void> {
    if (!activeProjectId || busy) return
    const key = viewKey
    setBusy(true)
    setError(null)
    try {
      const result = await action()
      // A result for a project or chat the pane has since left is dropped.
      if (viewRef.current !== key) return
      setSnapshot(result.snapshot)
      setError(result.error)
    } catch (error) {
      if (viewRef.current !== key) return
      const raw = error instanceof Error ? error.message : 'Git action failed'
      setError(raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''))
    } finally {
      setBusy(false)
    }
  }

  async function checkout(ref: string, detach: boolean): Promise<void> {
    if (!activeProjectId) return
    if (detach && !confirm(`Check out ${ref.slice(0, 8)}? This detaches HEAD.`)) return
    await run(() => window.workbench.checkoutGit(activeProjectId, ref, gitChatId))
  }

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col bg-sidebar">
      <header className="drag shrink-0">
        <div className="flex h-titlebar items-center justify-between gap-2 border-b border-line px-3">
          {otherPanes && <ReorderGrip onSwap={swapRightPanes} label="Reorder panes" />}
          <div className="flex min-w-0 flex-1 items-baseline gap-2">
            <h1 className="shrink-0 text-[13px] font-semibold text-ink">Git</h1>
            <p className="no-drag min-w-0 truncate font-mono text-[11px] text-faint">
              {snapshotForProject.available
                ? `${project?.name ? `${project.name} · ` : ''}${
                    gitChat?.worktreeBranch ? 'isolated · ' : ''
                  }${snapshotForProject.detached ? 'detached' : snapshotForProject.branch ?? '—'} · ${
                    snapshotForProject.dirtyCount
                  } change${snapshotForProject.dirtyCount === 1 ? '' : 's'}`
                : project?.name ?? 'No project'}
            </p>
          </div>
          <div className="no-drag flex shrink-0 items-center gap-0.5">
            <IconButton
              icon="retry"
              label="Refresh"
              onClick={() => {
                if (!activeProjectId) return
                const key = viewKey
                void window.workbench.getGitSnapshot(activeProjectId, gitChatId).then((next) => {
                  if (viewRef.current === key) setSnapshot(next)
                })
              }}
            />
            <IconButton icon="close" label="Close Git" onClick={() => setShowGit(false)} />
          </div>
        </div>
      </header>

      {!activeProjectId || !snapshotForProject.available ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-[12px] text-muted">
          {snapshotForProject.projectId === activeProjectId || !activeProjectId
            ? reasonCopy(snapshotForProject)
            : null}
        </div>
      ) : (
        <div className="no-drag min-h-0 flex-1 overflow-y-auto">
          <div className="border-b border-line px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-[12px] font-medium text-ink">
                  {snapshot.detached ? 'Detached HEAD' : snapshot.branch}
                </div>
                <div className="mt-0.5 font-mono text-[10px] text-muted">
                  {snapshot.ahead > 0 ? `↑${snapshot.ahead} ` : ''}
                  {snapshot.behind > 0 ? `↓${snapshot.behind}` : ''}
                  {snapshot.ahead === 0 && snapshot.behind === 0 ? 'up to date with upstream' : ''}
                </div>
              </div>
              <button
                className="shrink-0 rounded-md px-2 py-1 text-[11px] text-muted hover:bg-raised hover:text-ink"
                onClick={() => setCreating((value) => !value)}
              >
                New branch
              </button>
            </div>
            {creating && (
              <form
                className="mt-2 flex gap-1"
                onSubmit={(event) => {
                  event.preventDefault()
                  void run(async () => {
                    const result = await window.workbench.createGitBranch(
                      activeProjectId,
                      branchName,
                      gitChatId
                    )
                    if (result.ok) {
                      setBranchName('')
                      setCreating(false)
                    }
                    return result
                  })
                }}
              >
                <input
                  className="min-w-0 flex-1 rounded-md border border-line bg-canvas px-2 py-1 font-mono text-[11px] text-ink outline-none focus:border-accent"
                  value={branchName}
                  placeholder="branch-name"
                  onChange={(event) => setBranchName(event.target.value)}
                />
                <button
                  className="rounded-md bg-accent px-2 py-1 text-[11px] text-accent-ink disabled:opacity-40"
                  disabled={!branchName.trim() || busy}
                >
                  Create
                </button>
              </form>
            )}
            {snapshot.merge && gitChatId && (
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="min-w-0 truncate font-mono text-[10px] text-muted">
                  {snapshot.merge.commits > 0
                    ? `${snapshot.merge.commits} commit${snapshot.merge.commits === 1 ? '' : 's'} not in ${snapshot.merge.into}`
                    : `${snapshot.merge.into} has every commit`}
                </span>
                <button
                  className="shrink-0 rounded-md bg-accent px-2 py-1 text-[11px] text-accent-ink disabled:opacity-40"
                  disabled={snapshot.merge.commits === 0 || busy}
                  onClick={() => {
                    const into = snapshot.merge?.into
                    if (!into || !window.confirm(`Merge this chat's branch into ${into} in the project folder?`)) return
                    void run(() => window.workbench.mergeChatBranch(activeProjectId, gitChatId))
                  }}
                >
                  Merge into {snapshot.merge.into}
                </button>
              </div>
            )}
          </div>

          {error && (
            <div className="border-b border-line px-3 py-2 text-[11px] text-danger">{error}</div>
          )}

          <section className="border-b border-line px-3 py-2">
            <div className="mb-1 flex items-center justify-between">
              <h2 className="text-[11px] font-semibold text-muted">
                Uncommitted
              </h2>
              <span className="font-mono text-[10px] text-muted">{snapshot.files.length}</span>
            </div>
            {snapshot.files.length === 0 ? (
              <p className="py-2 text-[12px] text-muted">Working tree clean.</p>
            ) : (
              <ul className="flex flex-col gap-px">
                {snapshot.files.map((file) => (
                  <FileRow
                    key={file.path}
                    file={file}
                    selected={selected}
                    onSelect={setSelected}
                    onStage={() =>
                      void run(() => window.workbench.stageGitPath(activeProjectId, file.path, gitChatId))
                    }
                    onUnstage={() =>
                      void run(() =>
                        window.workbench.unstageGitPath(activeProjectId, file.path, gitChatId)
                      )
                    }
                    onDiscard={() => {
                      if (!confirm(`Discard ${file.path}?`)) return
                      void run(() =>
                        window.workbench.discardGitPath(activeProjectId, file.path, gitChatId)
                      )
                    }}
                  />
                ))}
              </ul>
            )}
            {diff && (
              <div className="mt-2 select-text">
                <CodeDiff
                  diff={{ path: diff.path, oldText: diff.oldText, newText: diff.newText }}
                />
              </div>
            )}
          </section>

          <section className="border-b border-line px-3 py-2">
            <textarea
              className="min-h-[64px] w-full resize-y rounded-md border border-line bg-canvas px-2 py-1.5 text-[12px] text-ink outline-none focus:border-accent"
              placeholder="Commit message"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
            />
            <button
              className="mt-2 w-full rounded-md bg-accent px-2 py-1.5 text-[12px] font-medium text-accent-ink disabled:opacity-40"
              disabled={busy || stagedCount === 0 || !message.trim()}
              onClick={() =>
                void run(async () => {
                  const result = await window.workbench.commitGit(activeProjectId, message, gitChatId)
                  if (result.ok) setMessage('')
                  return result
                })
              }
            >
              {stagedCount === 0 ? 'Nothing staged' : `Commit ${stagedCount} staged`}
            </button>
          </section>

          <section className="px-2 py-2">
            <h2 className="mb-1 px-1 text-[11px] font-semibold text-muted">
              Branches
            </h2>
            {snapshot.graph.length === 0 ? (
              <p className="px-1 py-2 text-[12px] text-muted">No commits yet.</p>
            ) : (
              <div className="flex">
                <Graph nodes={snapshot.graph} />
                <ul className="min-w-0 flex-1">
                  {snapshot.graph.map((node) => (
                    <li key={node.sha} className="flex h-[30px] items-center gap-1">
                      <button
                        className={`min-w-0 flex-1 truncate text-left text-[11px] ${
                          node.isHead ? 'text-ink' : 'text-muted hover:text-ink'
                        }`}
                        title={node.subject}
                        onClick={() => void checkout(node.sha, !node.refs[0] || node.refs[0] !== snapshot.branch)}
                      >
                        <span className="font-mono text-[10px] text-accent/80">{node.shortSha}</span>{' '}
                        {node.subject}
                      </button>
                      {node.refs.map((ref) => (
                        <button
                          key={ref}
                          className="shrink-0 rounded bg-raised px-1.5 py-0.5 font-mono text-[9px] text-ink hover:bg-canvas"
                          onClick={() => {
                            selectProject(activeProjectId)
                            void checkout(ref, false)
                          }}
                        >
                          {ref}
                        </button>
                      ))}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        </div>
      )}
    </section>
  )
}

function FileRow({
  file,
  selected,
  onSelect,
  onStage,
  onUnstage,
  onDiscard
}: {
  file: GitFile
  selected: { path: string; staged: boolean } | null
  onSelect: (next: { path: string; staged: boolean }) => void
  onStage: () => void
  onUnstage: () => void
  onDiscard: () => void
}): React.JSX.Element {
  const active =
    selected?.path === file.path && selected.staged === Boolean(file.staged && !file.unstaged)
  return (
    <li
      className={`group flex items-center gap-1 rounded-md px-1 py-0.5 ${
        active ? 'bg-active' : 'hover:bg-raised/70'
      }`}
    >
      <button
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        onClick={() => onSelect({ path: file.path, staged: Boolean(file.staged && !file.unstaged) })}
      >
        <span className="w-4 shrink-0 text-center font-mono text-[10px] text-danger">
          {letter(file.unstaged)}
        </span>
        <span className="w-4 shrink-0 text-center font-mono text-[10px] text-diff-add">
          {letter(file.staged)}
        </span>
        <span className="min-w-0 truncate font-mono text-[11px] text-ink" title={file.path}>
          {file.path}
        </span>
      </button>
      <span className="hidden shrink-0 gap-1 group-hover:flex">
        {file.unstaged && (
          <button className="text-[10px] text-muted hover:text-ink" onClick={onStage}>
            Stage
          </button>
        )}
        {file.staged && (
          <button className="text-[10px] text-muted hover:text-ink" onClick={onUnstage}>
            Unstage
          </button>
        )}
        {(file.unstaged || file.staged) && (
          <button className="text-[10px] text-muted hover:text-danger" onClick={onDiscard}>
            Discard
          </button>
        )}
      </span>
    </li>
  )
}
