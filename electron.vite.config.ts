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
  // The Workbench agent is a process of its own, built next to the main process.
  main: {
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts'), workbenchAgent: resolve('src/agent/main.ts') }
      }
    }
  },
  // The voice helper, a page with no window for Telegram's voice notes, has its own preload and page.
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts'), voiceHelper: resolve('src/preload/voiceHelper.ts') }
      }
    }
  },
  renderer: {
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html'), voiceHelper: resolve('src/renderer/voiceHelper.html') }
      }
    },
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
