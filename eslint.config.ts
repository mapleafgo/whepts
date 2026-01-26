import antfu from '@antfu/eslint-config'

export default antfu(
  {
    type: 'lib',
    formatters: true,
    pnpm: true,
    ignores: [
      '*.md',
    ],
    rules: {
      'n/prefer-global/process': ['error', 'always'],
    },
  },
)
