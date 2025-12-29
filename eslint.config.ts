import antfu from '@antfu/eslint-config'

export default antfu(
  {
    formatters: true,
    pnpm: true,
  },
  {
    rules: {
      'n/prefer-global/process': ['error', 'always'],
    },
  },
)
