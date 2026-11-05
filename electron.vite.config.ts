import { existsSync, readFileSync, realpathSync } from 'fs'
import { resolve } from 'path'
import { defineConfig } from 'electron-vite'

const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string }

// register-mac-app.mjs links dist/Electron.app to the renamed app. macOS names the
// Dock icon after the folder it was launched from, so launch the real bundle.
const macApp = resolve('node_modules/electron/dist/Electron.app')
if (process.platform === 'darwin' && !process.env.ELECTRON_EXEC_PATH && existsSync(macApp)) {
  process.env.ELECTRON_EXEC_PATH = resolve(realpathSync(macApp), 'Contents/MacOS/Electron')
}
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version)
    },
    publicDir: resolve('src/renderer/public'),
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react(), tailwindcss()],
    optimizeDeps: {
      exclude: ['@huggingface/transformers']
    },
    assetsInclude: ['**/*.wasm'],
    // Voice workers are module workers, and the recognition worker loads Whisper lazily.
    worker: { format: 'es' }
  }
})
