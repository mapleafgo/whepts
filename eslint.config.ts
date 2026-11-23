import antfu from '@antfu/eslint-config'

export default antfu(
  {
    type: 'lib',
    formatters: true,
    pnpm: true,
    ignores: [
      '**/*.md',
    ],
    rules: {
      'n/prefer-global/process': ['error', 'always'],
      // 调试构建保留 debug 级提示；生产构建由 terser 剥离全部 console。
      'no-console': ['error', { allow: ['warn', 'error', 'debug'] }],
    },
  },
)
