import { contextBridge, ipcRenderer } from 'electron'
import { VOICE_HELPER_DONE, VOICE_HELPER_JOB, type VoiceHelperApi } from '../shared/voiceHelper'

// The voice helper page gets these two channels and nothing of the app's API.
const api: VoiceHelperApi = {
  onJob: (listener) => {
    ipcRenderer.on(VOICE_HELPER_JOB, (_event, job) => listener(job))
  },
  done: (result) => ipcRenderer.send(VOICE_HELPER_DONE, result)
}

contextBridge.exposeInMainWorld('voiceHelper', api)
