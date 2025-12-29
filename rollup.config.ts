import commonjs from '@rollup/plugin-commonjs'
import eslint from '@rollup/plugin-eslint'
import terser from '@rollup/plugin-terser'
import typescript from '@rollup/plugin-typescript'
import del from 'rollup-plugin-delete'

const isProduction = process.env.NODE_ENV === 'production'

export default {
  input: 'src/index.ts',
  output: [
    {
      file: 'dist/index.js',
      format: 'es',
      sourcemap: !isProduction,
    },
  ],
  external: [],
  plugins: [
    del({ targets: 'dist' }),
    commonjs(),
    eslint({
      fix: true,
    }),
    typescript({
      importHelpers: true,
      sourceMap: !isProduction,
    }),
    isProduction && terser({
      compress: {
        drop_console: true,
        drop_debugger: true,
      },
      mangle: true,
    }),
  ].filter(Boolean),
}
