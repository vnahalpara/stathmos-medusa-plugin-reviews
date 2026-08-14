import fs from 'node:fs'
import path from 'node:path'
import { builtinModules } from 'node:module'

/**
 * Every package this plugin imports at RUNTIME must be declared in
 * `dependencies` or `peerDependencies`, not merely present in
 * node_modules.
 *
 * `multer` was the live example: `src/api/store/reviews/middlewares.ts`
 * imports it, but it was declared nowhere - it resolved only because npm
 * hoists it out of `@medusajs/medusa`, which is a *peer* of this plugin.
 * That works on npm and yarn and fails outright on a host using pnpm's
 * default isolated linker, where the import throws `Cannot find module` at
 * route-load time and takes the entire store upload surface down with it.
 * pnpm hosts are a concrete target for this plugin, not a hypothetical -
 * the README documents a `public-hoist-pattern` workaround for exactly
 * that linker. It would also break silently if Medusa swapped multer out
 * in a minor release, since nothing here pins it.
 *
 * A test rather than a one-time fix, because the next undeclared import is
 * invisible in local development for exactly the same reason this one was.
 */
const SRC_DIR = path.join(__dirname, '..')

const IGNORED_DIRS = new Set(['__tests__', 'admin', 'migrations'])

const builtins = new Set(builtinModules)

function tsFiles(dir: string): string[] {
  const found: string[] = []

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) {
        continue
      }
      found.push(...tsFiles(path.join(dir, entry.name)))
      continue
    }

    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      found.push(path.join(dir, entry.name))
    }
  }

  return found
}

/**
 * `import type ...` is erased by the compiler and never resolved at
 * runtime, so it is deliberately not matched here - `knex` is imported
 * that way in the module service purely to name an EntityManager shape.
 */
const IMPORT_RE = /^\s*import\s+(?!type\s)[^'"]*from\s+['"]([^'"]+)['"]/gm
const BARE_IMPORT_RE = /^\s*import\s+['"]([^'"]+)['"]/gm
const REQUIRE_RE = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g

function packageNameOf(specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    return null
  }

  if (specifier.startsWith('node:')) {
    return null
  }

  const segments = specifier.split('/')
  const name = specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]

  return builtins.has(name) ? null : name
}

describe('runtime dependencies', () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(SRC_DIR, '..', 'package.json'), 'utf8')
  ) as {
    dependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
  }

  const declared = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ])

  const imported = new Set<string>()

  for (const file of tsFiles(SRC_DIR)) {
    const source = fs.readFileSync(file, 'utf8')

    for (const re of [IMPORT_RE, BARE_IMPORT_RE, REQUIRE_RE]) {
      re.lastIndex = 0
      let match: RegExpExecArray | null

      while ((match = re.exec(source)) !== null) {
        const name = packageNameOf(match[1])

        if (name) {
          imported.add(name)
        }
      }
    }
  }

  it('finds the imports it is supposed to be checking', () => {
    // Guards the scanner itself: a regex that silently matched nothing
    // would make every assertion below vacuously true.
    expect(imported.has('multer')).toBe(true)
    expect(imported.has('sharp')).toBe(true)
    expect(imported.has('@medusajs/framework')).toBe(true)
  })

  it('declares every package src/ imports at runtime', () => {
    const undeclared = [...imported].filter((name) => !declared.has(name)).sort()

    expect(undeclared).toEqual([])
  })

  it('declares multer as a real dependency, not just its types', () => {
    expect(Object.keys(pkg.dependencies ?? {})).toContain('multer')
  })
})
