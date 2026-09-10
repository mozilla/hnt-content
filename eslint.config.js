import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import stylistic from '@stylistic/eslint-plugin';

export default tseslint.config(
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    plugins: { '@stylistic': stylistic },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { vars: 'all', args: 'none' },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      // Every if/else/loop body is braced, so a statement added later can
      // never silently fall outside the condition.
      curly: ['error', 'all'],
      // Block comments are for JSDoc only (`separate-lines` exempts `/**`
      // blocks); every other comment is a `//` line with a space after it.
      '@stylistic/multiline-comment-style': ['error', 'separate-lines'],
      '@stylistic/spaced-comment': ['error', 'always'],
    },
  },
  {
    ignores: ['**/dist/', '**/node_modules/', '**/.turbo/'],
  },
);
