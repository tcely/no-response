import github from 'eslint-plugin-github';
import tsParser from '@typescript-eslint/parser';

export default [
  {
    // Global ignores must be in their own object without a 'files' key
    ignores: ["bin/**", "lib/**", "dist/**", "node_modules/**"]
  },
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    plugins: {
      github: github,
      // Define 'import' so the inline comments in no-response.ts work
      import: {
        rules: {
          'no-unresolved': {},
          'named': {}
        }
      }
    },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: null, // Bun handles TS, so we don't need the full project service here
        ecmaVersion: 'latest',
        sourceType: 'module'
      }
    },
    linterOptions: {
      // This stops the "Unused eslint-disable directive" warning
      reportUnusedDisableDirectives: "off"
    },
    rules: {
      'no-console': 'warn'
    }
  }
];
