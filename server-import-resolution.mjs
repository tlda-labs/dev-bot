import fs from 'fs'
import path from 'path'
import { builtinModules } from 'module'

// The live image installs dependencies from `server/package.json`, not from the
// repo root -- `Dockerfile.live` does `COPY server/package.json ./package.json`
// then `npm install --production`. A package declared only in the ROOT
// package.json is therefore present for `tsc`, for `node --test` and for every
// local run, because all three resolve against the root `node_modules`, and
// absent in production. It surfaces as a boot crash-loop after deploy.
//
// That happened on 2026-08-08: a `server/` file imported `fflate`, declared at
// the root only, and crash-looped testing for eleven minutes behind a clean
// typecheck and a green suite.
//
// SCOPE: the boot graph, not the shipped tree. Walking every shipped file finds
// true-but-unactionable things -- `scripts/e2e-test.mjs` ships and imports
// `puppeteer-core`, which is genuinely absent from the image and never executed
// there. Reporting those is how an alarm earns a mute. Only what actually runs
// is followed, reached transitively from the entrypoints below.
const ENTRYPOINTS = [
  'server/unified-server.mjs',
  'bin/build-worker.mjs',
  'bin/feelings-export.mjs',
]

// The COPY lines in `Dockerfile.live`. A relative import that leaves these
// resolves locally and is absent in the image, which fails the same way. Those
// lines carry a comment pointing at this array; if a COPY is added or removed
// there and not here, this check goes quietly out of date, which is exactly the
// failure mode it exists to stop.
const SHIPPED_PATHS = [
  'server/lib', 'server/routes', 'server/unified-server.mjs',
  'server/qualifications-default.json', 'server/build-info.json',
  'shared', 'scripts', 'config/deployments',
  'agent-launch', 'agent-runtime', 'daemon', 'migrations', 'cli/lib',
  'bin/feelings-export.mjs', 'bin/build-worker.mjs', 'dist',
]

const BUILTINS = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`)])
const RESOLVE_EXTENSIONS = ['', '.mjs', '.js', '.ts', '.mts', '.cjs', '/index.mjs', '/index.js', '/index.ts']

// Anchored at a line-start `import`/`export`, which is what a static import
// statement always is. An unanchored `from '...'` also matches SQL inside the
// template literals this codebase is full of -- the first version of this check
// reported 27 of those as missing packages, a ~99% false-positive rate on its
// own first run. The bounded `[\s\S]{0,400}?` spans a multi-line specifier list
// without spanning into the next statement.
// The span between the keyword and `from` excludes quotes, backticks and
// semicolons. A real import clause never contains one -- `import { a, b } from`,
// `export * from` -- while every false positive here was a line-start `export`
// whose template literal happened to contain the word `from` followed by a
// quote, several hundred characters later, inside SQL.
const SPECIFIER_PATTERNS = [
  /^\s*(?:import|export)(?![\w$])[^'"`;]{0,400}?\bfrom\s*['"]([^'"]+)['"]/gm,
  /^\s*import\s*['"]([^'"]+)['"]/gm,
  /^\s*(?:const|let|var)?[^'"`;]{0,120}?\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gm,
]

export function specifiersIn(source) {
  const found = new Set()
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) found.add(match[1])
  }
  return [...found]
}

// `@scope/name/sub` -> `@scope/name`; `name/sub` -> `name`; relative -> null.
export function packageOfSpecifier(specifier) {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/')) return null
  if (BUILTINS.has(specifier)) return null
  const segments = specifier.split('/')
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
}

function resolveRelative(fromFile, specifier, exists) {
  const base = path.resolve(path.dirname(fromFile), specifier)
  for (const extension of RESOLVE_EXTENSIONS) {
    const candidate = base + extension
    if (exists(candidate)) return candidate
  }
  return null
}

function isShipped(repoRoot, absolute) {
  const relative = path.relative(repoRoot, absolute)
  if (relative.startsWith('..')) return false
  return SHIPPED_PATHS.some(shipped => relative === shipped || relative.startsWith(`${shipped}/`))
}

export function checkServerImports({
  repoRoot,
  readFile = (file) => fs.readFileSync(file, 'utf8'),
  exists = (file) => { try { return fs.statSync(file).isFile() } catch { return false } },
} = {}) {
  const manifestPath = path.join(repoRoot, 'server', 'package.json')
  let manifest
  try {
    manifest = JSON.parse(readFile(manifestPath))
  } catch (e) {
    throw new Error(`cannot read ${manifestPath}: ${e.message}`)
  }
  const declared = new Set([
    ...Object.keys(manifest.dependencies || {}),
    ...Object.keys(manifest.optionalDependencies || {}),
  ])

  const missing = []
  const unshipped = []
  const unresolved = []
  const visited = new Set()
  const queue = ENTRYPOINTS.map(entry => path.join(repoRoot, entry)).filter(exists)

  while (queue.length) {
    const file = queue.pop()
    if (visited.has(file)) continue
    visited.add(file)
    let source
    try {
      source = readFile(file)
    } catch (e) {
      throw new Error(`cannot read ${file}: ${e.message}`)
    }
    for (const specifier of specifiersIn(source)) {
      const pkg = packageOfSpecifier(specifier)
      if (pkg) {
        if (!declared.has(pkg)) missing.push({ file: path.relative(repoRoot, file), specifier, pkg })
        continue
      }
      if (!specifier.startsWith('.')) continue
      const target = resolveRelative(file, specifier, exists)
      if (!target) {
        unresolved.push({ file: path.relative(repoRoot, file), specifier })
        continue
      }
      if (!isShipped(repoRoot, target)) {
        unshipped.push({ file: path.relative(repoRoot, file), specifier, target: path.relative(repoRoot, target) })
        continue
      }
      queue.push(target)
    }
  }

  return { reachable: visited.size, declared: declared.size, missing, unshipped, unresolved }
}

export function describeServerImportFailures({ missing, unshipped, unresolved }) {
  const blocks = []
  if (missing.length) {
    blocks.push([
      '**Imported on the server boot path, not declared in `server/package.json`:**',
      '',
      ...missing.map(entry => `- \`${entry.pkg}\` — \`${entry.file}\` imports \`${entry.specifier}\``),
      '',
      'The live image installs from `server/package.json`, so these resolve locally against the root `node_modules` and are absent in production. A typecheck and the test suite pass; the deploy crash-loops.',
    ].join('\n'))
  }
  if (unshipped.length) {
    blocks.push([
      '**On the boot path, not copied into the image by `Dockerfile.live`:**',
      '',
      ...unshipped.map(entry => `- \`${entry.file}\` imports \`${entry.specifier}\` → \`${entry.target}\``),
    ].join('\n'))
  }
  if (unresolved.length) {
    blocks.push([
      '**On the boot path, does not resolve to a file at all:**',
      '',
      ...unresolved.map(entry => `- \`${entry.file}\` imports \`${entry.specifier}\``),
    ].join('\n'))
  }
  return blocks.join('\n\n')
}
