import { net } from 'electron'
import type { ChatAgent, Project } from '../shared/types'
import { promptIsolated } from './acp'
import { getClaudeCliInfo } from './claudeCli'
import { findProviderModel, firstProviderModelKey } from './providers'
import { grokBuildSignedIn } from './sessions'
import { getApiKey, getDefaultAgent, getModel } from './store'

export type AskTimeouts = { apiMs: number; agentMs: number }

const DEFAULT_TIMEOUTS: AskTimeouts = { apiMs: 20_000, agentMs: 75_000 }

async function askViaApi(prompt: string, timeoutMs: number): Promise<string | null> {
  const key = await getApiKey()
  if (!key) return null
  const model = await getModel()
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), timeoutMs)
  try {
    const response = await net.fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      credentials: 'omit',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      signal: abort.signal,
      body: JSON.stringify({
        model,
        temperature: 0.4,
        messages: [
          { role: 'system', content: 'Return JSON only. No markdown.' },
          { role: 'user', content: prompt }
        ]
      })
    })
    if (!response.ok) return null
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    return body.choices?.[0]?.message?.content ?? null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The agent for new chats when it can run, else whichever one can. The app's own agent needs no sign-in,
 * only a provider's model: it runs when that is picked in Settings, or when neither CLI is signed in.
 */
async function signedInAgent(): Promise<ChatAgent | null> {
  const preferred = await getDefaultAgent()
  if (preferred === 'workbench' && (await findProviderModel(await getModel()))) return 'workbench'
  const signedIn = { grok: grokBuildSignedIn(), claude: (await getClaudeCliInfo()).signedIn }
  if (preferred !== 'workbench' && signedIn[preferred]) return preferred
  if (signedIn.grok) return 'grok'
  if (signedIn.claude) return 'claude'
  return (await firstProviderModelKey()) ? 'workbench' : null
}

async function askViaAgent(
  project: Project,
  prompt: string,
  agent: ChatAgent,
  timeoutMs: number
): Promise<string | null> {
  if (!project.path) return null
  try {
    return await promptIsolated(project.path, prompt, [], undefined, undefined, {
      agent,
      timeoutMs,
      tools: false,
      rules:
        'Do not use tools. Do not read or edit files. The prompt already contains the project dossier. Reply with JSON only.'
    })
  } catch {
    return null
  }
}

/**
 * Asks the user's model once, without tools, for a JSON reply to a prompt that carries everything it needs.
 * Null when no model is signed in, no provider's model can stand in, or the call fails.
 */
export async function askOnce(
  project: Project,
  prompt: string,
  timeouts: AskTimeouts = DEFAULT_TIMEOUTS
): Promise<string | null> {
  const agent = await signedInAgent().catch(() => null)
  // The xAI key only stands in for Grok, so a Claude or provider default goes straight to its agent.
  const viaApi = agent === 'claude' || agent === 'workbench' ? null : await askViaApi(prompt, timeouts.apiMs).catch(() => null)
  return viaApi ?? (agent ? await askViaAgent(project, prompt, agent, timeouts.agentMs) : null)
}
