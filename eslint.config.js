import customConfig from 'eslint-config-custom';

export default [
  ...customConfig,
  {
    ignores: ['**/dist/', '**/node_modules/', '**/.turbo/'],
  },
];
