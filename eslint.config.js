// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    // ui/ is a separate workspace with its own eslint.config.js and
    // dependency tree (React/Vite, different plugins) -- ignored here so
    // the root `eslint .` doesn't try to load it against this config's
    // node_modules. Run its lint separately: `cd ui && npm run lint`.
    ignores: ['dist/**', 'node_modules/**', 'ui/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  {
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
);
