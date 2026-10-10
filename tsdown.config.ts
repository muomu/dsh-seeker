/**
 * dsh-seeker build: node-half lib (host plugin: skr tools + protocol prompt
 * section) + browser client bundle (the Seeker 全屏工作台) speaking the dsh
 * module-loader protocol (`window.__ModuleLoader__.load`). Pattern follows
 * dsh-genui's tsdown config, simplified (inline CSS strings, no lazy assets).
 */
import type { UserConfig } from 'tsdown'

const ID = 'dsh-seeker'

/** Module-table entries the client bundle may leave external: platform seed
 * rows answered by the loader's require. The client runtime imports only
 * react family + ui-primitives (MarkdownText); every @deepseek-ai/* type
 * import is erased at compile time. */
const EXTERNALS = [
  'react', 'react/jsx-runtime', 'react-dom/client', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-primitives',
]

/** Forbid any other @deepseek-ai/* value import in the client bundle
 * (cross-plugin value imports are forbidden; collaborate via cordis). */
function purityGate(): NonNullable<UserConfig['plugins']>[number] {
  return {
    name: 'dsh-client-bundle-purity',
    resolveId(source: string) {
      if (!source.startsWith('@deepseek-ai/')) return null
      if (EXTERNALS.includes(source)) return null
      throw new Error(
        `client bundle purity: "${source}" is not in the module table (EXTERNALS) — ` +
        'cross-plugin value imports are forbidden; use type-only imports or cordis services',
      )
    },
  }
}

const clientConfig: UserConfig = {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  minify: true,
  sourcemap: false,
  clean: false,
  deps: {
    neverBundle: [...EXTERNALS],
    alwaysBundle: (id: string) => !EXTERNALS.includes(id),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  plugins: [purityGate()],
  outputOptions: {
    entryFileNames: 'client.js',
    codeSplitting: false,
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

const libConfig: UserConfig = {
  name: ID,
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  outputOptions: { entryFileNames: '[name].js' },
  // Cleanup happens in the build script (rm -rf lib before tsc): tsdown must
  // never wipe lib/types (tsc's declaration output) mid-pipeline.
  clean: false,
}

export default [
  libConfig,
  clientConfig,
]
