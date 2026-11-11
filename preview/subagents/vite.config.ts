import { resolve } from 'path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// A page that plays a scripted job through the real subagents panel, without Electron.
// Run `npm run preview:subagents` and open the address it prints.
export default defineConfig({
  root: resolve(__dirname, '../..'),
  plugins: [react(), tailwindcss()],
  resolve: {
    // The panel reads the workspace; here it reads the script instead.
    alias: [{ find: /^\.\.\/workspace$/, replacement: resolve(__dirname, 'workspace.ts') }]
  },
  server: { port: 5199, strictPort: true, open: false }
})
