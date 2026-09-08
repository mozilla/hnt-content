import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import memberLineComments from './eslint-rules/member-line-comments.js';

export default tseslint.config(
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    plugins: {
      hnt: { rules: { 'member-line-comments': memberLineComments } },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { vars: 'all', args: 'none' },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      // Every if/else/loop body is braced, so a statement added later can
      // never silently fall outside the condition.
      curly: ['error', 'all'],
      'hnt/member-line-comments': 'error',
      // Type annotations stay allowed for vitest's
      // `importOriginal<typeof import('x')>()` mocking idiom.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { disallowTypeAnnotations: false },
      ],
      '@typescript-eslint/consistent-type-definitions': ['error', 'interface'],
      'prefer-template': 'error',
    },
  },
  {
    ignores: ['**/dist/', '**/node_modules/', '**/.turbo/'],
  },
);
