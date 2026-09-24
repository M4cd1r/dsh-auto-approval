import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { apply } from '../src/index.ts'
import type { ConfigFields } from '../src/config.ts'
import { DENY_REASON } from '../src/rules.ts'
import type { AutomodeDecisionEvent } from '../src/audit.ts'

/** The fake session's projection-visible state: intent (autoApprovalIntent) and turn (turnBoundary). */
interface FakeSession {
  id: string
  intent: string | null
  lastTurn?: number
  append(type: string, data: unknown): void
}

interface FakeAgent {
  agent: Agent
  session: FakeSession
  audited: Array<{ type: string; data: AutomodeDecisionEvent }>
}

let sessionSeq = 0
/** Build an agent whose session the projection stub answers for; intent is a harness argument, not a log event. */
function fakeAgent(intent: string | null = null): FakeAgent {
  const audited: FakeAgent['audited'] = []
  const session: FakeSession = {
    id: `session-${++sessionSeq}`,
    intent,
    append(type: string, data: unknown) {
      audited.push({ type, data: data as AutomodeDecisionEvent })
    },
  }
  return { agent: { session } as unknown as Agent, session, audited }
}

let callSeq = 0
function makeExec(name: string, args: unknown, agent?: Agent): ToolExecution {
  return {
    callId: `call-${++callSeq}`, name, arguments: args, agent,
    signal: new AbortController().signal, token: Symbol('t'),
  } as unknown as ToolExecution
}

const ALLOW: PreToolDecision = { kind: 'allow' }

/** Let cordis attach inject callbacks (the projection registration lands in a microtask). */
const flush = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

/** The sessionProjections stub: register() gates stateOf(), values come from the fake session. */
interface ProjectionStub {
  registered: Set<string>
  register(key: string): void
}

function provideProjections(ctx: Context): ProjectionStub {
  const registered = new Set<string>()
  const registry = {
    register(definition: { key: string }) {
      registered.add(definition.key)
      return () => { registered.delete(definition.key) }
    },
    stateOf(session: unknown, key: string) {
      if (!registered.has(key)) return undefined
      const fake = session as FakeSession
      if (key === 'autoApprovalIntent') return { intent: fake.intent ?? null }
      if (key === 'turnBoundary') return { lastTurn: fake.lastTurn ?? 0 }
      return undefined
    },
  }
  ctx.provide('sessionProjections', registry)
  return {
    registered,
    register: (key: string) => { registry.register({ key }) },
  }
}

interface Harness {
  ctx: Context
  guards: Array<(exec: Readonly<ToolExecution>) => string | undefined>
  projections: ProjectionStub
  run(exec: ToolExecution): Promise<PreToolDecision>
}

/** Build a Cordis root context, stub tools + permissionPresets +
 * sessionProjections, and load the plugin. The preset defaults to `automode`
 * (plugin active); passing undefined simulates an absent service (the plugin
 * bypasses entirely). run() attaches a default agent when none is passed —
 * real calls always have a session, and the plugin's switch is the session
 * preset, so it by design takes over nothing without one. */
function harness(config: ConfigFields = {}, preset: string | null = 'automode'): Harness {
  const ctx = new Context()
  const guards: Harness['guards'] = []
  ctx.provide('tools', {
    guard(g: (exec: Readonly<ToolExecution>) => string | undefined) {
      guards.push(g)
      return () => {}
    },
  })
  if (preset !== null) ctx.provide('permissionPresets', { current: () => preset })
  const projections = provideProjections(ctx)
  apply(ctx, config)
  const fallback = fakeAgent()
  return {
    ctx, guards, projections,
    run: async exec => {
      await flush()
      return ctx.waterfall(
        'tools/pre-execute',
        exec.agent === undefined ? { ...exec, agent: fallback.agent } : exec,
        async (): Promise<PreToolDecision> => ALLOW,
      )
    },
  }
}

describe('pre-execute 拦截（L0 规则引擎）', () => {
  it('命中 deny 规则 → deny，reason 不泄露 pattern，pattern 进审计', async () => {
    const { run } = harness({ denyPatterns: ['top-secret-regex'], auditSessionEvents: true })
    const { agent, audited } = fakeAgent()
    const decision = await run(makeExec('bash', { command: 'echo top-secret-regex' }, agent))
    expect(decision).toEqual({ kind: 'deny', reason: DENY_REASON })
    expect((decision as { reason: string }).reason).not.toContain('top-secret-regex')
    expect(audited.at(-1)?.data).toMatchObject({ stage: 'L0-deny', decision: 'deny', pattern: 'top-secret-regex' })
  })

  it('命中 ask 规则 → deny（全托管：原转人工改为直接拒绝，不确定即拒）', async () => {
    const { run } = harness()
    const decision = await run(makeExec('bash', { command: 'sudo apt install x' }))
    expect(decision).toMatchObject({ kind: 'deny', reason: DENY_REASON })
    expect((decision as { reason?: string }).reason).not.toMatch(/sudo/)
  })

  it('白名单工具直接放行（走 next）', async () => {
    const { run } = harness()
    expect(await run(makeExec('read', { path: '/tmp/x' }))).toBe(ALLOW)
  })

  it('未配置分类器：白名单之外 fail-closed deny', async () => {
    const { run } = harness()
    // 免检工具仍直接放行
    expect(await run(makeExec('read', { path: '/tmp/x' }))).toBe(ALLOW)
    // bash 前缀白名单（显式配置）仍直接放行
    const withPrefix = harness({ bashCommandPrefixes: ['pnpm test'] })
    expect(await withPrefix.run(makeExec('bash', { command: 'pnpm test' }))).toBe(ALLOW)
    // 其余命令：没有分类器时不再默认放行
    const decision = await run(makeExec('bash', { command: 'echo arbitrary-command' }))
    expect(decision).toMatchObject({ kind: 'deny' })
    expect((decision as { reason?: string }).reason).toContain('no classifier is configured')
  })

  it('非 automode preset 完全旁路（deny 规则也不生效）', async () => {
    const { run } = harness({ denyPatterns: ['rm\\s+-rf\\s+/'] }, 'workspace-write')
    expect(await run(makeExec('bash', { command: 'rm -rf /' }))).toBe(ALLOW)
  })

  it('bypasses entirely when the permissionPresets service is absent (no session-log fallback)', async () => {
    const { run } = harness({ denyPatterns: ['preset-secret'] }, null)
    const { agent } = fakeAgent('some intent')
    expect(await run(makeExec('bash', { command: 'preset-secret' }, agent))).toBe(ALLOW)
  })
})

describe('sessionProjections registration and reads', () => {
  it('registers the autoApprovalIntent projection via the optional inject', async () => {
    const { projections } = harness()
    expect(projections.registered.has('autoApprovalIntent')).toBe(false)
    await flush()
    expect(projections.registered.has('autoApprovalIntent')).toBe(true)
  })

  it('denials in getStatus count per turn via the turnBoundary projection', async () => {
    const harness_ = harness({ denyPatterns: ['forbidden'] })
    const { agent } = fakeAgent()
    await harness_.run(makeExec('bash', { command: 'forbidden' }, agent))
    const service = harness_.ctx.get('automodeStatus') as unknown as { getStatus(agent: Agent): { denials: number } }
    // turnBoundary not registered (dsh-agent-loop absent from the stub): no reliable boundary → 0.
    expect(service.getStatus(agent).denials).toBe(0)
    // Register turnBoundary as dsh-agent-loop would: the reader picks it up live.
    harness_.projections.register('turnBoundary')
    await harness_.run(makeExec('bash', { command: 'forbidden' }, agent))
    expect(service.getStatus(agent).denials).toBe(1)
  })
})

describe('L0 deny 单调 guard（M3）', () => {
  it('apply 时注册 guard，且 guard 独立命中 deny 规则', async () => {
    const { guards } = harness({ denyPatterns: ['guard-secret'] })
    const agent = fakeAgent().agent
    expect(guards).toHaveLength(1)
    expect(guards[0]?.(makeExec('bash', { command: 'guard-secret' }, agent))).toBe(DENY_REASON)
    expect(guards[0]?.(makeExec('bash', { command: 'echo ok' }, agent))).toBeUndefined()
  })
})

describe('escalation 参数（sandbox_permissions + justification）', () => {
  it('不再豁免：带升级参数的调用同样受 legacy ask 规则约束', async () => {
    const { run } = harness()
    const decision = await run(makeExec('bash', {
      command: 'sudo apt install x', // 命中 legacy ask 规则
      sandbox_permissions: 'danger-full-access',
      justification: 'need root to install',
    }))
    expect(decision).toMatchObject({ kind: 'deny' })
  })

  it('带升级参数的调用同样受 L0 deny 约束', async () => {
    const { run } = harness()
    const decision = await run(makeExec('bash', {
      command: 'rm -rf /',
      sandbox_permissions: 'danger-full-access',
      justification: 'need it',
    }))
    expect(decision).toMatchObject({ kind: 'deny' })
  })
})

describe('volatile config updates (loader/volatile-update)', () => {
  function refHarness(patterns: () => string[], config: ConfigFields = {}) {
    const ctx = new Context()
    const guards: Array<(exec: Readonly<ToolExecution>) => string | undefined> = []
    ctx.provide('tools', {
      guard(g: (exec: Readonly<ToolExecution>) => string | undefined) { guards.push(g); return () => {} },
    })
    ctx.provide('permissionPresets', { current: () => 'automode' })
    provideProjections(ctx)
    apply(ctx, { denyPatterns: { get: patterns }, ...config })
    const run = async (exec: ToolExecution) => {
      await flush()
      return ctx.waterfall('tools/pre-execute', exec, async (): Promise<PreToolDecision> => ALLOW)
    }
    const fire = () => { ctx.emit('loader/volatile-update', []) }
    return { guards, run, fire }
  }

  it('a denyPatterns ref update takes effect immediately on the waterfall and the monotonic guard', async () => {
    let patterns = ['hot-secret']
    const { guards, run, fire } = refHarness(() => patterns)
    const agent = fakeAgent().agent
    const exec = (command: string) => makeExec('bash', { command }, agent)

    expect(await run(exec('hot-secret'))).toMatchObject({ kind: 'deny' })
    expect(guards[0]?.(exec('hot-secret'))).toBe(DENY_REASON)

    patterns = ['other-secret']
    fire()
    expect(await run(exec('other-secret'))).toMatchObject({ kind: 'deny' })
    expect(guards[0]?.(exec('other-secret'))).toBe(DENY_REASON)
    // The old pattern is gone from L0: without a classifier the call falls through to L1-unconfigured.
    const decision = await run(exec('hot-secret'))
    expect(decision).toMatchObject({ kind: 'deny' })
    expect((decision as { reason?: string }).reason).toContain('no classifier is configured')
    expect(guards[0]?.(exec('hot-secret'))).toBeUndefined()
  })

  it('removing the deny patterns falls through to the L1-unconfigured deny', async () => {
    let patterns = ['hot-secret']
    const { guards, run, fire } = refHarness(() => patterns)
    const agent = fakeAgent().agent
    const exec = (command: string) => makeExec('bash', { command }, agent)

    patterns = []
    fire()
    const decision = await run(exec('hot-secret'))
    expect(decision).toMatchObject({ kind: 'deny' })
    expect((decision as { reason?: string }).reason).toContain('no classifier is configured')
    expect(guards[0]?.(exec('hot-secret'))).toBeUndefined()
  })

  it('an invalid update is rejected and the previous resolved config stays active', async () => {
    let patterns = ['ok-pattern']
    const { guards, run, fire } = refHarness(() => patterns, { auditSessionEvents: true })
    const { agent, audited } = fakeAgent()
    const exec = (command: string) => makeExec('bash', { command }, agent)

    expect(await run(exec('ok-pattern'))).toMatchObject({ kind: 'deny' })

    patterns = ['(broken']
    fire()
    // The rejected update must not take effect: the last good deny still matches (L0, not L1-unconfigured).
    const decision = await run(exec('ok-pattern'))
    expect(decision).toMatchObject({ kind: 'deny' })
    expect(audited.at(-1)?.data).toMatchObject({ stage: 'L0-deny', decision: 'deny', pattern: 'ok-pattern' })
    expect(guards[0]?.(exec('ok-pattern'))).toBe(DENY_REASON)
  })
})

describe('L1 LLM classifier', () => {
  const fastRoute = { classifierFastProvider: 'p', classifierFastModel: 'm' }

  function provideLlm(ctx: Context, ...texts: string[]): void {
    let seq = 0
    ctx.provide('llm', {
      stream() {
        const text = texts[seq++] ?? texts[texts.length - 1] ?? ''
        return (async function* (): AsyncGenerator<StreamChunk> {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    })
  }

  it('无 ctx.llm 服务 → fail-closed 转 deny', async () => {
    const { run } = harness({ ...fastRoute, auditSessionEvents: true })
    const { agent, audited } = fakeAgent('please deploy')
    const decision = await run(makeExec('bash', { command: 'pnpm test' }, agent))
    expect(decision).toMatchObject({ kind: 'deny' })
    expect(audited.at(-1)?.data).toMatchObject({ stage: 'L1-fail-closed', decision: 'deny' })
  })

  it('session 无用户消息（无意图上下文）→ fail-closed 转 deny', async () => {
    const { ctx, run } = harness(fastRoute)
    provideLlm(ctx, '0')
    const { agent } = fakeAgent()
    expect(await run(makeExec('bash', { command: 'pnpm test' }, agent))).toMatchObject({ kind: 'deny' })
  })

  it('fast 判定 0 → allow；审计含路由与阶段', async () => {
    const { ctx, run } = harness({ ...fastRoute, auditSessionEvents: true })
    provideLlm(ctx, '0')
    const { agent, audited } = fakeAgent('run the tests please')
    expect(await run(makeExec('bash', { command: 'pnpm test' }, agent))).toBe(ALLOW)
    expect(audited.at(-1)?.data).toMatchObject({
      stage: 'L1-fast', decision: 'allow', route: { provider: 'p', model: 'm' },
    })
  })

  it('deep 判定 DENY → deny', async () => {
    const { ctx, run } = harness(fastRoute)
    provideLlm(ctx, '1', 'dangerous\nVERDICT: DENY')
    const { agent } = fakeAgent('delete everything')
    expect(await run(makeExec('bash', { command: 'rm -rf ./build' }, agent))).toMatchObject({ kind: 'deny' })
    // L1 deny 只进 tracker 计数，白名单工具照常放行（无 pause）
    expect(await run(makeExec('read', { path: 'x' }, agent))).toBe(ALLOW)
  })

  it('L1 解析失败 → fail-closed 转 deny（绝不默认放行）', async () => {
    const { ctx, run } = harness(fastRoute)
    provideLlm(ctx, '1', 'no verdict in this output')
    const { agent } = fakeAgent('do something')
    expect(await run(makeExec('bash', { command: 'curl example.com' }, agent))).toMatchObject({ kind: 'deny' })
  })
})

describe('remote 状态 / 历史', () => {
  it('getStatus 返回配置摘要与累计统计', async () => {
    const ctx = new Context()
    ctx.provide('tools', { guard: () => () => {} })
    ctx.provide('permissionPresets', { current: () => 'automode' })
    provideProjections(ctx)
    apply(ctx, { denyPatterns: ['forbidden'] })
    const run = (exec: ToolExecution) => ctx.waterfall('tools/pre-execute', exec, async (): Promise<PreToolDecision> => ALLOW)
    const { agent } = fakeAgent()
    await run(makeExec('bash', { command: 'forbidden' }, agent))   // L0 deny
    await run(makeExec('bash', { command: 'sudo x' }, agent))      // legacy ask → deny
    await run(makeExec('read', { path: '/tmp/x' }, agent))         // whitelist allow
    await run(makeExec('bash', { command: 'pnpm test' }, agent))   // 无分类器 → L1-unconfigured deny
    const service = ctx.get('automodeStatus') as unknown as { getStatus(agent: Agent): unknown }
    const status = service.getStatus(agent) as { approvals: number; totalDenials: number }
    expect(status).toMatchObject({ approvals: 1, totalDenials: 3 })
  })

  it('getHistory 返回最近决策（新→旧，含 pattern）', async () => {
    const ctx = new Context()
    ctx.provide('tools', { guard: () => () => {} })
    ctx.provide('permissionPresets', { current: () => 'automode' })
    provideProjections(ctx)
    apply(ctx, { denyPatterns: ['forbidden'] })
    const run = (exec: ToolExecution) => ctx.waterfall('tools/pre-execute', exec, async (): Promise<PreToolDecision> => ALLOW)
    const { agent } = fakeAgent()
    await run(makeExec('bash', { command: 'forbidden' }, agent))
    await run(makeExec('read', { path: '/tmp/x' }, agent))
    const service = ctx.get('automodeStatus') as unknown as { getHistory(agent: Agent): Array<Record<string, unknown>> }
    const history = service.getHistory(agent)
    expect(history).toHaveLength(2)
    expect(history[0]).toMatchObject({ tool: 'read', stage: 'whitelist', decision: 'allow' })
    expect(history[1]).toMatchObject({ tool: 'bash', stage: 'L0-deny', decision: 'deny', pattern: 'forbidden' })
  })

})
