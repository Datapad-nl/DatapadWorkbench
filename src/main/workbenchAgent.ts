import { app } from 'electron'
import { join } from 'path'
import { forkAgent, type AgentProcess } from './claudeCli'

/** Where the app's own agent keeps its transcripts, so a chat on it can be loaded again. */
function workbenchAgentHome(): string {
  return join(app.getPath('userData'), 'workbench', 'agent')
}

/**
 * Starts the app's own agent, which runs the providers' models, in a utility process. It is built next to
 * the main bundle and needs no CLI and no sign-in.
 */
export function startWorkbenchAgent(): AgentProcess {
  const env: NodeJS.ProcessEnv = { ...process.env, WB_AGENT_HOME: workbenchAgentHome() }
  // Inherited from a shell, it would start the utility process's Electron as plain Node.
  delete env.ELECTRON_RUN_AS_NODE
  return forkAgent(join(__dirname, 'workbenchAgent.js'), [], env, 'Workbench agent')
}
