export type StreamStatus = { status: 'idle' | 'streaming' | 'error'; error: string | null }

/**
 * Each chat's status and error, without the reply text that grows many times a second.
 * Returns `prev` itself while none of them changed, so what reads it does not render again.
 */
export function streamStatuses(
  prev: Record<string, StreamStatus>,
  streams: Record<string, StreamStatus>
): Record<string, StreamStatus> {
  const ids = Object.keys(streams)
  const same =
    ids.length === Object.keys(prev).length &&
    ids.every((id) => prev[id]?.status === streams[id].status && prev[id]?.error === streams[id].error)
  if (same) return prev
  return Object.fromEntries(ids.map((id) => [id, { status: streams[id].status, error: streams[id].error }]))
}
