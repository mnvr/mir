import path from 'node:path'
import { fileURLToPath } from 'node:url'
import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default [
  {
    ignores: ['dist'],
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir: __dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    linterOptions: {
      reportUnusedDisableDirectives: true,
    },
    rules: {
      ...tsPlugin.configs['flat/strict-type-checked'].rules,
    },
  },
]
