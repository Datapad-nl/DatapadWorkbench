import type { WorkbenchApi } from './index'

declare global {
  interface Window {
    workbench: WorkbenchApi
  }
}

export {}
