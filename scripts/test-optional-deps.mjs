#!/usr/bin/env node
/**
 * Capability-probe tests for the soft peer loader.
 *
 * Why these exist: `optional-deps.js` degrades when a peer is ABSENT, but a peer
 * can also be present and TOO OLD. cosmokit only grew `isVolatile` in 1.8.4 and
 * schemastery only grew `.volatile()` in 3.18.3, so a profile carrying an older
 * copy resolves the module, passes a truthy check, and then throws on the first
 * call — the degradation this file exists to guarantee never runs. That is not
 * hypothetical: a profile whose local dependency tree pinned cosmokit 1.8.2 made
 * the settings page fail with `cosmokit.isVolatile is not a function` (2026-10-16).
 *
 * Each case builds a real package tree in a temp dir — a copy of `lib/` beside a
 * stub `@deepseek-ai/cosmokit` — and imports the module under test for real, so
 * what runs here is the same resolution the plugin gets at load time.
 *
 * The same suite runs against two targets:
 *
 *   node scripts/test-optional-deps.mjs                        # this checkout
 *   node scripts/test-optional-deps.mjs <path/to/optional-deps.js>   # installed copy
 *
 * Exit code 0 when every check passes, 1 otherwise.
 */

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const target = process.argv[2] ?? fileURLToPath(new URL('../lib/optional-deps.js', import.meta.url))

const failures = []
let passed = 0

async function test(name, run) {
  try {
    await run()
    passed += 1
    console.log(`  ✓  ${name}`)
  } catch (error) {
    failures.push(name)
    console.log(`  ✗  ${name}\n      ${error instanceof Error ? error.message : String(error)}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** A cosmokit from before the volatile module: resolvable, truthy, no isVolatile. */
const OLD_COSMOKIT = `export const clone = (value) => value
export const Time = { millisecond: 1 }
`

/** A cosmokit at 1.8.4+: the same shared-symbol protocol the real library uses. */
const CURRENT_COSMOKIT = `const write = Symbol.for('cosmokit.volatile.write')
export const createVolatile = (value) => {
  let current = value
  return Object.freeze({ get: () => current, [write]: (next) => { current = next } })
}
export const isVolatile = (value) => typeof value === 'object' && value !== null && write in value
`

/**
 * Lay out a resolvable tree: this package's `lib/`, plus a stub cosmokit beside it.
 * @param {string} source - module source of the stub cosmokit
 * @returns {string} the optional-deps.js to import inside that tree
 */
function sandbox(source) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-superpowers-capability-'))
  const lib = join(root, 'pkg', 'lib')
  mkdirSync(lib, { recursive: true })
  for (const name of ['optional-deps.js', 'settings-schema.js', 'records.js', 'index.js', 'client.js', 'skill-delegation.js']) {
    try {
      cpSync(join(dirname(target), name), join(lib, name))
    } catch {
      /* a target that ships fewer modules still gets exercised on what it has */
    }
  }
  const stub = join(root, 'node_modules', '@deepseek-ai', 'cosmokit')
  mkdirSync(stub, { recursive: true })
  writeFileSync(
    join(stub, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/cosmokit', version: '0.0.0-stub', type: 'module', exports: { '.': './index.js' } }),
  )
  writeFileSync(join(stub, 'index.js'), source)
  return join(lib, 'optional-deps.js')
}

console.log(`\n能力探测测试 — ${target}\n`)

await test('cosmokit 装得上但没有 isVolatile 时退回本地判断，不抛错', async () => {
  const mod = await import(pathToFileURL(sandbox(OLD_COSMOKIT)).href)
  assert(typeof mod.isVolatile === 'function', '应导出 isVolatile 函数')
  let verdict
  try {
    verdict = mod.isVolatile({ skill: 'test-driven-development' })
  } catch (error) {
    throw new Error(`库在但能力不在时应降级，实际抛出：${error instanceof Error ? error.message : String(error)}`)
  }
  assert(verdict === false, `明文值应判为非引用，实际 ${String(verdict)}`)
})

await test('cosmokit 提供 isVolatile 时以它的判断为准', async () => {
  const stubRoot = sandbox(CURRENT_COSMOKIT)
  const mod = await import(pathToFileURL(stubRoot).href)
  const stub = await import(
    pathToFileURL(join(dirname(dirname(stubRoot)), '..', 'node_modules', '@deepseek-ai', 'cosmokit', 'index.js')).href
  )
  assert(mod.isVolatile(stub.createVolatile({ skill: 'x' })) === true, '库自己的引用应判为引用')
  assert(mod.isVolatile({ skill: 'x' }) === false, '明文值不应判为引用')
})

console.log(
  failures.length === 0
    ? `\n全部通过（${passed} 项）。\n`
    : `\n${failures.length} 项不通过：${failures.join('；')}。\n`,
)
process.exit(failures.length === 0 ? 0 : 1)
