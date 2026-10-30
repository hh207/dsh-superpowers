#!/usr/bin/env node
/**
 * Load-safety and degradation tests for the delegate tool module.
 *
 * Why these exist: a preset mount is whole-tree. If the module fails to
 * IMPORT, every sibling in the tree is rolled back and the web client retries
 * without backoff — one bad row turned into a resume storm on 2026-09-29. The
 * module therefore has two contracts that no runtime try/catch can cover and
 * only tests can:
 *
 *   1. it must load even where its peer dependencies are absent (the dev
 *      checkout has no node_modules — that exact situation is the historical
 *      bug), and
 *   2. apply() must never throw: a broken environment degrades to a tool that
 *      reports the failure instead of taking the tree down with it.
 *
 * The same suite runs against two targets:
 *
 *   node scripts/test.mjs                        # this checkout (no deps → degraded mode)
 *   node scripts/test.mjs <path/to/module.js>    # e.g. the installed copy (deps → happy mode)
 *
 * Which mode runs is decided by whether the target can resolve its peers, and
 * every run says which one it exercised — a suite that silently skipped its
 * happy path would be worse than no suite.
 *
 * Exit code 0 when every check passes, 1 otherwise.
 */

import { createRequire } from 'node:module'
import { readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const target = process.argv[2] ?? fileURLToPath(new URL('../lib/skill-delegation.js', import.meta.url))

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

async function rejectsWith(promise, pattern, message) {
  let error = null
  try {
    await promise
  } catch (caught) {
    error = caught
  }
  assert(error !== null, message)
  assert(pattern.test(error.message), `${message} — 实际报错：${error.message}`)
}

/**
 * A ctx that captures tool registrations and lets tests script the services.
 *
 * `get` answers for `configEditor` because that is where the delegate reads its
 * pins from: the row is mounted by the PRESET and carries no config of its own,
 * so it reads the profile's `superpowers-delegation-settings` row across through
 * the editor (DSH 0.2.x removed `settings.get()`). A stub without `get` failed
 * the two happy-path tests with `ctx.get is not a function` instead of testing
 * the delegation it exists to test — verified 2026-10-15.
 *
 * `api` picks which `ctx.subagents` seam the stub publishes, so both Host
 * generations stay covered: `'activation'` (DSH 0.2.1+, the current one) or
 * `'continuable'` (DSH 0.2.0). The spy always records what it was handed, so a
 * test can assert on the SPEC rather than on a request object whose shape
 * differs between the two.
 */
function captureCtx({ settings = {}, api = 'activation', onStart } = {}) {
  const registered = []
  const calls = []
  const record = async (spec) => {
    calls.push(spec)
    return onStart === undefined ? { childId: 'child-stub', result: Promise.resolve({}) } : onStart(spec)
  }
  const subagents = api === 'continuable'
    ? { startContinuable: record }
    : { startActivation: record }
  return {
    registered,
    calls,
    ctx: {
      effect(fn) {
        return fn()
      },
      logger: { info() {}, warn() {} },
      get: (service) =>
        service === 'configEditor'
          ? {
            entries: () => [{ options: { id: namespace }, fiber: { config: settings } }],
          }
          : undefined,
      tools: {
        register(tool) {
          registered.push(tool)
          return () => {}
        },
      },
      settings: {
        get: () => settings,
      },
      subagents,
    },
  }
}

// ---------- mode detection ----------

let depsPresent = false
try {
  createRequire(join(dirname(target), 'noop.js')).resolve('@deepseek-ai/dsh-tools')
  depsPresent = true
} catch {
  depsPresent = false
}

console.log(`\ndelegate 工具测试 — ${target}`)
console.log(`  运行模式：${depsPresent ? '依赖齐全（验正常路径）' : '依赖缺失（验降级路径）'}\n`)

// ---------- the two contracts, both modes ----------

let mod = null
let namespace = 'superpowers-delegation-settings'

await test('模块在任何环境下都能装载', async () => {
  mod = await import(pathToFileURL(target).href)
  assert(typeof mod.apply === 'function', '应导出 apply 函数')
  assert(mod.name === 'superpowers-delegate-skill', `name 应为 superpowers-delegate-skill，实际 ${mod.name}`)
  assert(Array.isArray(mod.DELEGABLE_SKILLS) && mod.DELEGABLE_SKILLS.length > 0, '应导出技能列表')
  const presetRoot = join(dirname(target), '..', 'preset', 'skills')
  const presetSkills = readdirSync(presetRoot)
    .filter((name) => {
      try {
        return statSync(join(presetRoot, name)).isDirectory()
          && statSync(join(presetRoot, name, 'SKILL.md')).isFile()
      } catch {
        return false
      }
    })
    .sort()
  assert(
    mod.DELEGABLE_SKILLS.length === presetSkills.length,
    `DELEGABLE_SKILLS 应与 preset/skills 一致（${mod.DELEGABLE_SKILLS.length} vs ${presetSkills.length}）`,
  )
  for (const skill of presetSkills) {
    assert(mod.DELEGABLE_SKILLS.includes(skill), `DELEGABLE_SKILLS 缺少 ${skill}`)
  }
  namespace = (await import(pathToFileURL(join(dirname(target), 'settings-schema.js')).href)).NAMESPACE
})

await test('resolveRoute：复用主会话哨兵优先于默认路由', async () => {
  const { resolveRoute } = await import(pathToFileURL(join(dirname(target), 'settings-schema.js')).href)
  const { ROUTE_USE_PARENT_SESSION } = await import(pathToFileURL(join(dirname(target), 'delegable-skills.js')).href)
  const sentinel = { provider: ROUTE_USE_PARENT_SESSION, model: ROUTE_USE_PARENT_SESSION }
  const settings = {
    defaultProvider: 'p0',
    defaultModel: 'm0',
    skillModels: {
      brainstorming: sentinel,
    },
  }
  assert(resolveRoute(settings, 'brainstorming') === null, '技能行哨兵应省略 agentOptions')
  assert(
    resolveRoute(settings, 'writing-skills')?.provider === 'p0',
    '未单独指定的技能应走默认对',
  )
  const defaultOnly = {
    defaultProvider: ROUTE_USE_PARENT_SESSION,
    defaultModel: ROUTE_USE_PARENT_SESSION,
    skillModels: {},
  }
  assert(resolveRoute(defaultOnly, null) === null, '其他子代理行哨兵应省略 agentOptions')
  assert(resolveRoute(defaultOnly, 'brainstorming') === null, '跟随默认且默认是哨兵时也应继承主会话')
})

await test('apply 在一切损坏时也不向外抛错', () => {
  const poison = {
    effect() {
      throw new Error('effect 不可用')
    },
    tools: {
      register() {
        throw new Error('register 不可用')
      },
    },
    settings: {
      get() {
        throw new Error('settings 不可用')
      },
    },
    subagents: {},
  }
  mod.apply(poison, {})
})

// ---------- degraded mode: no peers available ----------

if (!depsPresent) {
  await test('依赖缺失时登记的是降级工具，点开报错而不是连坐', async () => {
    const { registered, ctx } = captureCtx()
    mod.apply(ctx, {})
    assert(registered.length === 1, `应登记 1 个工具，实际 ${registered.length}`)
    const tool = registered[0]
    assert(tool.name === 'delegate_skill', `工具名应为 delegate_skill，实际 ${tool.name}`)
    assert(typeof tool.execute === 'function', '降级工具也要可调用，报错要从调用里看得见')
    assert(/degraded/i.test(tool.description), '降级工具的说明要写明它坏了')
    await rejectsWith(
      tool.execute({ task: 'x', brief: 'y' }, {}),
      /degraded/i,
      '降级工具调用时应报出清楚的原因',
    )
  })
}

// ---------- happy mode: peers available ----------

if (depsPresent) {
  await test('正常环境登记真工具', () => {
    const { registered, ctx } = captureCtx()
    mod.apply(ctx, {})
    assert(registered.length === 1, `应登记 1 个工具，实际 ${registered.length}`)
    const tool = registered[0]
    assert(tool.name === 'delegate_skill', `工具名应为 delegate_skill，实际 ${tool.name}`)
    assert(typeof tool.execute === 'function', '真工具应可调用')
  })

  await test('execute 校验调用方（没有 agent 就点名报错）', async () => {
    const { registered, ctx } = captureCtx()
    mod.apply(ctx, {})
    await rejectsWith(
      registered[0].execute({ task: 't', brief: 'b' }, {}),
      /requires a calling agent/,
      '缺 agent 的调用应点名报错',
    )
  })

  await test('派发走设置里的固定路由，返回值和台账都对', async () => {
    const settings = {
      defaultProvider: 'p0',
      defaultModel: 'm0',
      skillModels: {
        'test-driven-development': { provider: 'p1', model: 'm1' },
      },
    }
    const { registered, calls, ctx } = captureCtx({
      settings,
      onStart: async (spec) => ({ childId: 'child-1', result: Promise.resolve({}) }),
    })
    mod.apply(ctx, {})
    const result = await registered[0].execute(
      { skill: 'test-driven-development', task: '标签', brief: '简报' },
      { agent: { id: 'parent' }, signal: new AbortController().signal },
    )
    assert(result.childId === 'child-1', `childId 应为 child-1，实际 ${result.childId}`)
    assert(result.model === 'p1/m1', `model 应为 p1/m1，实际 ${result.model}`)
    assert(result.label === '[test-driven-development] 标签', `label 应带技能名，实际 ${result.label}`)
    assert(calls.length === 1, '应派发一次子代理')
    assert(
      calls[0].request.agentOptions?.provider === 'p1' && calls[0].request.agentOptions?.model === 'm1',
      '固定路由应作为 agentOptions 传给子代理',
    )
    const { allRoutes } = await import(pathToFileURL(join(dirname(target), 'records.js')).href)
    assert(allRoutes()['child-1']?.model === 'm1', '台账应记下子代理的实际路由')
  })

  await test('0.2.1 的 startActivation：signal 在 spec 上、request 里不带 signal/persona', async () => {
    const { registered, calls, ctx } = captureCtx({ api: 'activation' })
    mod.apply(ctx, {})
    await registered[0].execute(
      { task: '标签', brief: '简报' },
      { agent: { id: 'parent' }, signal: new AbortController().signal },
    )
    const spec = calls[0]
    assert(spec.delivery === 'parent', `delivery 应为 parent，实际 ${spec.delivery}`)
    assert(spec.signal instanceof AbortSignal, 'signal 应在 spec 顶层')
    assert(spec.request.signal === undefined, 'request 里不应再带 signal（0.2.1 的类型已移除）')
    assert(spec.request.persona === undefined, 'request 里不应再带 persona（0.2.1 的类型已移除）')
    assert(Array.isArray(spec.request.prompt) && spec.request.prompt[0]?.text === '简报', 'brief 应作为 prompt 传入')
  })

  await test('0.2.0 的 startContinuable：signal 与 persona 都在 request 里', async () => {
    const { registered, calls, ctx } = captureCtx({ api: 'continuable' })
    mod.apply(ctx, {})
    await registered[0].execute(
      { task: '标签', brief: '简报' },
      { agent: { id: 'parent' }, signal: new AbortController().signal },
    )
    const spec = calls[0]
    assert(spec.signal instanceof AbortSignal, 'signal 应在 spec 顶层')
    assert(spec.request.signal instanceof AbortSignal, 'request 里也应带 signal（0.2.0 要求）')
    assert(typeof spec.request.persona === 'string' && spec.request.persona.length > 0, '0.2.0 路径应转发 persona')
    assert(spec.delivery === undefined, '0.2.0 的 spec 没有 delivery 字段')
  })

  await test('Host 换名后不再静默：登记期就降级并报出原因', async () => {
    const { registered, ctx } = captureCtx()
    ctx.subagents = { getProvider() {}, list() { return [] } }
    mod.apply(ctx, {})
    assert(registered.length === 1, `应登记 1 个降级工具，实际 ${registered.length}`)
    assert(/degraded/i.test(registered[0].description), '降级说明要写明它坏了')
    await rejectsWith(
      registered[0].execute({ task: 'x', brief: 'y' }, {}),
      /neither startActivation|degraded/i,
      '降级工具调用时应报出接口不匹配',
    )
  })

  await test('有默认路由时，复用主会话哨兵仍不传 agentOptions', async () => {
    const { ROUTE_USE_PARENT_SESSION } = await import(pathToFileURL(join(dirname(target), 'delegable-skills.js')).href)
    const settings = {
      defaultProvider: 'p0',
      defaultModel: 'm0',
      skillModels: {
        brainstorming: { provider: ROUTE_USE_PARENT_SESSION, model: ROUTE_USE_PARENT_SESSION },
      },
    }
    const { registered, calls, ctx } = captureCtx({ settings })
    mod.apply(ctx, {})
    const result = await registered[0].execute(
      { skill: 'brainstorming', task: '标签', brief: '简报' },
      { agent: { id: 'parent' }, signal: new AbortController().signal },
    )
    assert(result.model === 'inherited', `model 应为 inherited，实际 ${result.model}`)
    assert(calls[0].request.agentOptions === undefined, '哨兵时不应写入 agentOptions')
  })
}

// ---------- summary ----------

console.log(
  failures.length === 0
    ? `\n全部通过（${passed} 项，${depsPresent ? '正常路径' : '降级路径'}）。\n`
    : `\n${failures.length} 项不通过：${failures.join('；')}。\n`,
)
process.exit(failures.length === 0 ? 0 : 1)
