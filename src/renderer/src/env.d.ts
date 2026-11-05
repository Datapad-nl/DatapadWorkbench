/// <reference types="vite/client" />

/** `version` from package.json, injected by electron.vite.config.ts. */
declare const __APP_VERSION__: string

declare module '*?url' {
  const src: string
  export default src
}
