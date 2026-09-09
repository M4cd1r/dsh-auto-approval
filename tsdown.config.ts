import { defineConfig } from 'tsdown'

/**
 * Two artifacts, one package:
 *
 * - `lib/index.js` — the host half (ESM, Node). Dependencies and peers stay
 *   external, so `@deepseek-ai/*` resolves to the running harness.
 * - `lib/client.js` — the browser half served at `/plugins/dsh-auto-approval/client.js`
 *   by `client-modules`. It is a closure factory
 *   (`window.__ModuleLoader__.load({ id, factory })`) resolving externals
 *   through the injected `require` (the loader's frozen module table);
 *   everything else is inlined.
 */

const ID = 'dsh-auto-approval'

/** Module specifiers the shell shares into the frozen browser module table. */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
] as const

/** Documented temporary exemption: the snapshot-store engine rides the lazy CJS table. */
const RUNTIME_STORE_EXEMPTION = '@deepseek-ai/dsh-client-runtime/client'

const CLIENT_EXTERNALS: readonly string[] = [...PLATFORM_MODULES, RUNTIME_STORE_EXEMPTION]

const NODE_ENV = process.env.NODE_ENV ?? 'production'

export default defineConfig([
  {
    name: ID,
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    name: `${ID}/client`,
    entry: { client: 'lib/types/client/index.js' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    clean: false,
    external: [...CLIENT_EXTERNALS],
    define: {
      'process.env.NODE_ENV': JSON.stringify(NODE_ENV),
      'import.meta.env.MODE': JSON.stringify(NODE_ENV),
      'import.meta.env': JSON.stringify({ MODE: NODE_ENV }),
    },
    // tsdown auto-externalizes package dependencies; anything NOT in the
    // loader module table must inline instead (local modules, the hand-rolled
    // wire parsers).
    noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
