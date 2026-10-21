import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'coverage']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Tests and the dev-only mock are not hot-reloaded component modules.
    files: ['**/*.test.{ts,tsx}', 'src/test/**', 'src/api/mock/**'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
  {
    // The service worker runs in its own global scope (DESIGN §6.21).
    files: ['src/sw/sw.ts'],
    languageOptions: {
      globals: globals.serviceworker,
    },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      globals: globals.browser,
      sourceType: 'script',
    },
  },
])
