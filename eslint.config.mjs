import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import { defineConfig } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default defineConfig(
  { ignores: ['out/**', 'dist/**', 'node_modules/**', 'knowledge/**'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['src/main/**', 'src/preload/**', 'scripts/**', '*.config.*'],
    languageOptions: { globals: globals.node }
  },
  {
    files: ['src/renderer/**'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
    }
  }
)
