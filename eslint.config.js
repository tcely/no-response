import github from 'eslint-plugin-github'
import tsParser from '@typescript-eslint/parser'

export default [
  {
    // Global ignores must be in their own object without a 'files' key
    ignores: ["bin/**", "lib/**", "dist/**", "node_modules/**"]
  },
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    plugins: {
      github: github
    },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: null, // Bun handles TS, so we don't need the full project service here
        ecmaVersion: 'latest',
        sourceType: 'module'
      }
    },
    rules: {
      ...github.configs.recommended.rules,
      'import/no-unresolved': 'off', // Bun handles imports natively
      'no-console': 'warn'
    }
  }
]
