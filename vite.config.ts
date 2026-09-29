import { defineConfig } from 'vitest/config'
import type { Plugin } from 'vite'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PRECACHE_EXTRAS } from './src/sw/classify.js'

const projectRoot = dirname(fileURLToPath(import.meta.url))

// The `/*` block of public/_headers, as a header map. The SW's synthetic
// shell Response never traverses the edge, so the security headers Pages
// stamps on every real response (CSP above all — it is header-only, no
// <meta> fallback) must be baked into the precached shell at build time.
function parseRootHeaders(): Record<string, string> {
  const headers: Record<string, string> = {}
  let inRoot = false
  for (const line of readFileSync(resolve(projectRoot, 'public/_headers'), 'utf8').split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    if (!/^\s/.test(line)) {
      inRoot = line.trim() === '/*'
      continue
    }
    if (!inRoot) continue
    const sep = line.indexOf(':')
    if (sep > 0) headers[line.slice(0, sep).trim()] = line.slice(sep + 1).trim()
  }
  return headers
}

// Renders the src/sw/sw.js template into dist/sw.js: inlines classify.js,
// embeds index.html (plus the /* header block) as the shell document, and
// stamps a precache manifest whose version hash covers every precached
// byte — so any shell change ⇒ byte-different sw.js ⇒ browser update flow.
// A single writeBundle hook suffices: Vite 7 copies public/ at renderStart
// (order 'pre'), so index.html, the manifest, and the icons are all on
// disk here, and `bundle` is the authoritative emitted asset set.
// Design: dev-material/service-worker-design.md.
function swPrecache(): Plugin {
  return {
    name: 'pz-sw-precache',
    apply: 'build',
    writeBundle(options, bundle) {
      const outDir = options.dir ?? resolve(projectRoot, 'dist')
      const assetPaths = Object.keys(bundle)
        .filter((name) => name.startsWith('assets/'))
        .map((name) => `/${name}`)
        .sort()
      const shellHtml = readFileSync(resolve(outDir, 'index.html'), 'utf8')
      const shellHeaders = {
        ...parseRootHeaders(),
        'Content-Type': 'text/html; charset=utf-8',
      }
      const classifySrc = readFileSync(resolve(projectRoot, 'src/sw/classify.js'), 'utf8')
        .replace(/^export /gm, '')
      const template = readFileSync(resolve(projectRoot, 'src/sw/sw.js'), 'utf8')
      const assets = [...assetPaths, ...PRECACHE_EXTRAS]
      // The version names the whole SW generation (cache = pz-shell-<hash>),
      // so it must cover the SW's own code too: a template/classify-only
      // change would otherwise reuse the active generation's cache name, and
      // its install would overwrite entries a live SW is serving (plus a
      // failed install's cleanup would delete them outright).
      const hash = createHash('sha256')
        .update(shellHtml)
        .update(JSON.stringify(shellHeaders))
        .update(classifySrc)
        .update(template)
      for (const path of assets) {
        hash.update(path).update(readFileSync(resolve(outDir, path.slice(1))))
      }
      const manifest = {
        version: hash.digest('hex').slice(0, 16),
        shellHtml,
        shellHeaders,
        assets,
      }
      // Function replacements: the payloads contain `$`-sequences that
      // String.replace would otherwise expand.
      writeFileSync(
        resolve(outDir, 'sw.js'),
        template
          .replace('__CLASSIFY__', () => classifySrc)
          .replace('__PRECACHE_MANIFEST__', () => JSON.stringify(manifest)),
      )
    },
  }
}

// Perf-harness recordings live in <root>/recordings/ (gitignored) — captured
// session content (usernames, chat, message log) that must never ride a
// deploy. Keeping them outside public/ means no build output can ever
// contain them; this dev-server-only middleware is what makes ?replay=
// able to fetch them at /recordings/<name> during development.
function serveRecordings(): Plugin {
  return {
    name: 'pz-serve-recordings',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/recordings', (req, res, next) => {
        const name = decodeURIComponent((req.url ?? '').replace(/^\//, '').split('?')[0])
        if (!/^[\w.-]+\.json$/.test(name)) return next()
        // One read, one failure mode: anything unreadable (absent, a
        // directory named <name>.json, races) falls through to the next
        // middleware as a plain 404 rather than crashing the dev server.
        let body: Buffer
        try {
          body = readFileSync(resolve(projectRoot, 'recordings', name))
        } catch {
          return next()
        }
        res.setHeader('Content-Type', 'application/json')
        res.end(body)
      })
    },
  }
}

export default defineConfig({
  plugins: [swPrecache(), serveRecordings()],
  build: {
    sourcemap: false,
  },
  test: {
    environmentOptions: {
      happyDOM: {
        settings: {
          // The tile path (exercised by monster-list.test.ts) lazily appends
          // <script src=…/tileinfo-*.js> to load AMD tileinfo modules. happy-dom
          // can't execute external scripts and otherwise logs a noisy
          // DOMException per attempt. Treat the disabled load as a 'load'
          // event instead: the tile painters no-op without real atlas/module
          // loads, and those tests only assert DOM row structure.
          handleDisabledFileLoadingAsSuccess: true,
        },
      },
    },
    // That fake 'load' never reaches define(), so tile-loader's loadModule
    // rejects it ("… loaded without defining a module") and each caller's
    // fallback warns with a stack (~70 per screen-trace run). No script ever
    // executes here, so the message is always this artifact: drop it, let
    // every other log through.
    onConsoleLog: (log) => !log.includes('loaded without defining a module'),
  },
})
