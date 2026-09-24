import { afterEach, describe, expect, it, vi } from 'vitest'
import { describeClassifier, resolveConfig } from '../src/config.ts'
import {
  createDenyGuard,
  DENY_REASON,
  extractMatchableText,
  hasEscalationArgs,
  matchBashPrefix,
  matchFirst,
  matchSelfKill,
  selfKillDenyReason,
} from '../src/rules.ts'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

describe('resolveConfig（M1 fail-loud）', () => {
  it('非法 deny 正则在启动时直接 throw', () => {
    expect(() => resolveConfig({ denyPatterns: ['(unclosed'] })).toThrow(/invalid deny pattern/)
  })

  it('非法 ask 正则在启动时直接 throw', () => {
    expect(() => resolveConfig({ askPatterns: ['['] })).toThrow(/invalid ask pattern/)
  })

  it('provider/model 不成对即 throw', () => {
    expect(() => resolveConfig({ classifierFastModel: 'm' })).toThrow(/together/)
    expect(() => resolveConfig({ classifierFastProvider: 'p' })).toThrow(/together/)
  })

  it('deep 不能脱离 fast 单独配置', () => {
    expect(() => resolveConfig({
      classifierDeepProvider: 'p', classifierDeepModel: 'm',
    })).toThrow(/requires classifierFast/)
  })

  it('fast 配置后 deep 缺省沿用 fast', () => {
    const resolved = resolveConfig({ classifierFastProvider: 'p', classifierFastModel: 'm' })
    expect(resolved.classifier?.fast).toEqual({ provider: 'p', model: 'm' })
    expect(resolved.classifier?.deep).toEqual({ provider: 'p', model: 'm' })
  })

  it('未配置 fast 时 L1 关闭', () => {
    expect(resolveConfig({}).classifier).toBeUndefined()
  })

  it('默认 backend 为 llm，现有解析结果不变', () => {
    const resolved = resolveConfig({ classifierFastProvider: 'p', classifierFastModel: 'm' })
    expect(resolved.classifier).toMatchObject({ backend: 'llm' })
    expect(describeClassifier(resolved.classifier!)).toBe('p/m')
  })
})

describe('resolveConfig · jev backend', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  it('jev + 无密钥（配置与 TYPESAFE_API_KEY 都没有）→ throw，错误同时点明两个来源', () => {
    vi.stubEnv('TYPESAFE_API_KEY', undefined as unknown as string)
    expect(() => resolveConfig({ classifierBackend: 'jev' }))
      .toThrow(/jevApiKey.*TYPESAFE_API_KEY|TYPESAFE_API_KEY.*jevApiKey/)
  })

  it('jevApiKey 配置优先于 TYPESAFE_API_KEY 环境变量', () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'env-key')
    const resolved = resolveConfig({ classifierBackend: 'jev', jevApiKey: 'config-key' })
    expect(resolved.classifier).toMatchObject({ backend: 'jev', apiKey: 'config-key' })
  })

  it('TYPESAFE_API_KEY 环境变量作为密钥回退', () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'env-key')
    const resolved = resolveConfig({ classifierBackend: 'jev' })
    expect(resolved.classifier).toMatchObject({
      backend: 'jev',
      apiKey: 'env-key',
      route: { provider: 'typesafe', model: 'jev-latest' },
      baseUrl: 'https://api.typesafe.ai',
      allowThreshold: 0.9,
    })
    expect(describeClassifier(resolved.classifier!)).toBe('typesafe/jev-latest')
  })

  it('jevAllowThreshold 取 0 / 1 / NaN → throw（必须在开区间 (0,1)）', () => {
    for (const jevAllowThreshold of [0, 1, Number.NaN]) {
      expect(() => resolveConfig({ classifierBackend: 'jev', jevApiKey: 'k', jevAllowThreshold }))
        .toThrow(/jevAllowThreshold/)
    }
  })

  it('jev 同时配了 classifierFastProvider → throw（两个 backend 同配是歧义）', () => {
    expect(() => resolveConfig({
      classifierBackend: 'jev',
      jevApiKey: 'k',
      classifierFastProvider: 'p',
      classifierFastModel: 'm',
    })).toThrow(/cannot be combined/)
  })
})

describe('resolveConfig · volatile refs (0.1.7 profile config)', () => {
  it('dereferences a ConfigRef value', () => {
    const resolved = resolveConfig({ denyPatterns: { get: () => ['ref-secret'] } })
    expect(resolved.denySources).toEqual(['ref-secret'])
    expect(resolved.deny[0]?.source).toBe('ref-secret')
  })

  it('a ref whose get() returns undefined falls back to the schema default', () => {
    const resolved = resolveConfig({
      denyPatterns: { get: () => ['ref-secret'] },
      selfKillGuard: { get: () => undefined },
      jevModel: { get: () => undefined },
    })
    expect(resolved.selfKillGuard).toBe(true)
    // jevModel is only observable through the jev backend route; assert via a
    // resolved jev config instead.
    const jev = resolveConfig({ classifierBackend: 'jev', jevApiKey: 'k', jevModel: { get: () => undefined } })
    expect(jev.classifier).toMatchObject({ route: { model: 'jev-latest' } })
    // The denyPatterns ref that did resolve is unaffected by the other defaults.
    expect(resolved.denySources).toEqual(['ref-secret'])
  })

  it('an invalid ref value still throws the same fail-loud error', () => {
    expect(() => resolveConfig({ denyPatterns: { get: () => ['(broken'] } }))
      .toThrow(/invalid deny pattern/)
    expect(() => resolveConfig({
      classifierFastProvider: { get: () => 'p' },
    })).toThrow(/together/)
  })
})

describe('matchFirst / extractMatchableText', () => {
  it('返回第一个命中的下标', () => {
    const patterns = [/foo/, /bar/]
    expect(matchFirst('xx bar yy', patterns)).toEqual({ index: 1 })
    expect(matchFirst('nothing', patterns)).toBeUndefined()
  })

  it('提取 command 或 code，其它形态返回 undefined', () => {
    expect(extractMatchableText({ command: 'ls' })).toBe('ls')
    expect(extractMatchableText({ code: 'print(1)' })).toBe('print(1)')
    expect(extractMatchableText({ path: '/tmp' })).toBeUndefined()
    expect(extractMatchableText('string')).toBeUndefined()
    expect(extractMatchableText(undefined)).toBeUndefined()
  })
})

describe('matchBashPrefix（bash 命令前缀白名单）', () => {
  const ls = ['ls']

  it('精确命令与前缀 + 参数都命中', () => {
    expect(matchBashPrefix('ls', ls)).toBe(true)
    expect(matchBashPrefix('ls -la /tmp', ls)).toBe(true)
    expect(matchBashPrefix('  ls -la  ', ls)).toBe(true)
  })

  it('词边界：less 不命中 ls；git push 不命中 git status', () => {
    expect(matchBashPrefix('less big.log', ls)).toBe(false)
    expect(matchBashPrefix('git push', ['git status'])).toBe(false)
    expect(matchBashPrefix('git status --short', ['git status'])).toBe(true)
  })

  it('shell 元字符一律拒绝（管道/重定向/拼接/命令替换）', () => {
    expect(matchBashPrefix('ls | rm -rf /', ls)).toBe(false)
    expect(matchBashPrefix('ls > /tmp/out', ls)).toBe(false)
    expect(matchBashPrefix('ls; rm -rf /', ls)).toBe(false)
    expect(matchBashPrefix('ls &', ls)).toBe(false)
    expect(matchBashPrefix('ls $(echo x)', ls)).toBe(false)
    expect(matchBashPrefix('echo `whoami`', ['echo'])).toBe(false)
    expect(matchBashPrefix('ls\nrm -rf /', ls)).toBe(false)
  })

  it('无前缀列表或空命令不命中', () => {
    expect(matchBashPrefix('ls', [])).toBe(false)
    expect(matchBashPrefix(undefined, ls)).toBe(false)
    expect(matchBashPrefix('', ls)).toBe(false)
    expect(matchBashPrefix('ls', ['  '])).toBe(false)
  })
})

describe('matchSelfKill（进程自毁护栏）', () => {
  it('killall 整类命中（含选项/Windows 名/非 node 目标）', () => {
    expect(matchSelfKill('killall node')).toEqual({})
    expect(matchSelfKill('killall -9 node')).toEqual({})
    expect(matchSelfKill('killall node.exe')).toEqual({})
    expect(matchSelfKill('killall python')).toEqual({})
    expect(matchSelfKill('killall -9 nginx')).toEqual({})
  })

  it('pkill 整类命中（含 -f 与组合选项/非 node 目标）', () => {
    expect(matchSelfKill('pkill node')).toEqual({})
    expect(matchSelfKill('pkill -f node')).toEqual({})
    expect(matchSelfKill('pkill -9 -f node')).toEqual({})
    expect(matchSelfKill('pkill -KILL -f node.exe')).toEqual({})
    // 命令行匹配可绕过 node 名过滤直击宿主，必须整类命中
    expect(matchSelfKill('pkill -f foo')).toEqual({})
    expect(matchSelfKill('pkill -f python')).toEqual({})
    expect(matchSelfKill('pkill -f dsh')).toEqual({})
    expect(matchSelfKill('pkill -f automode')).toEqual({})
  })

  it('taskkill 整类命中（含 /F 变体/非 node 目标）', () => {
    expect(matchSelfKill('taskkill /IM node.exe')).toEqual({})
    expect(matchSelfKill('taskkill /F /IM node.exe')).toEqual({})
    expect(matchSelfKill('taskkill /f /im node.exe')).toEqual({})
    expect(matchSelfKill('taskkill /IM nginx.exe')).toEqual({})
  })

  it('Stop-Process 整类命中（含 -Force 变体/非 node 目标）', () => {
    expect(matchSelfKill('Stop-Process -Name node')).toEqual({})
    expect(matchSelfKill('Stop-Process -Name node -Force')).toEqual({})
    expect(matchSelfKill('Stop-Process -Name python')).toEqual({})
  })

  it('kill <pid> 返回 pid（含 -9 等信号选项），由调用方比较宿主 PID', () => {
    expect(matchSelfKill('kill 1234')).toEqual({ pid: 1234 })
    expect(matchSelfKill('kill -9 1234')).toEqual({ pid: 1234 })
    expect(matchSelfKill('kill -s TERM 4321')).toEqual({ pid: 4321 })
  })

  it('非自毁命令不命中：普通命令 / job / 无 PID / 字符串误报', () => {
    expect(matchSelfKill('ls')).toBeUndefined()
    expect(matchSelfKill('node --version')).toBeUndefined()
    expect(matchSelfKill('kill %1')).toBeUndefined()
    expect(matchSelfKill('echo node')).toBeUndefined()
    expect(matchSelfKill('echo killall python')).toBeUndefined()
    expect(matchSelfKill('echo pkill -f dsh')).toBeUndefined()
  })

  it('命令边界：多条命令链中命中实际命令', () => {
    expect(matchSelfKill('echo hi; killall node')).toEqual({})
    expect(matchSelfKill('cd /tmp && pkill -f foo')).toEqual({})
  })
})

describe('selfKillDenyReason', () => {
  it('注入宿主 PID 且不含匹配细节（M2：不泄规则）', () => {
    const reason = selfKillDenyReason(12345)
    expect(reason).toContain('12345')
    expect(reason).toContain('kill a specific PID other than')
    expect(reason).not.toMatch(/killall|pkill|node/)
  })
})

describe('createDenyGuard（M2/M3）', () => {
  const exec = (command: string): ToolExecution => ({
    callId: 'c1', name: 'bash', arguments: { command },
    signal: new AbortController().signal, token: Symbol('t'),
  }) as unknown as ToolExecution

  it('命中 deny 规则返回通用文案，且不包含 pattern', () => {
    const guard = createDenyGuard(() => resolveConfig({ denyPatterns: ['secret-pattern'] }))
    const reason = guard(exec('run secret-pattern now'))
    expect(reason).toBe(DENY_REASON)
    expect(reason).not.toContain('secret-pattern')
  })

  it('未命中返回 undefined（单调：guard 永远不能 allow）', () => {
    const guard = createDenyGuard(() => resolveConfig({ denyPatterns: ['secret-pattern'] }))
    expect(guard(exec('echo hello'))).toBeUndefined()
  })

  it('thunk 返回 undefined（非 automode preset）时不拦截', () => {
    const guard = createDenyGuard(() => undefined)
    expect(guard(exec('rm -rf /'))).toBeUndefined()
  })

  it('自毁护栏：killall node 命中，reason 注入宿主 PID', () => {
    const guard = createDenyGuard(() => resolveConfig({}))
    const reason = guard(exec('killall node'))
    expect(reason).toContain(String(process.pid))
    expect(reason).toContain('denied by the automode security policy')
  })

  it('自毁护栏逃生通道：kill 非宿主 PID 放行', () => {
    const guard = createDenyGuard(() => resolveConfig({}))
    const otherPid = process.pid + 1
    expect(guard(exec(`kill ${otherPid}`))).toBeUndefined()
  })

  it('自毁护栏可关闭（selfKillGuard: false）', () => {
    const guard = createDenyGuard(() => resolveConfig({ selfKillGuard: false }))
    expect(guard(exec('killall node'))).toBeUndefined()
  })
})

describe('块设备直写补漏（默认 denyPatterns）', () => {
  it('shell 重定向直写块设备被默认规则拦截', () => {
    const deny = resolveConfig({}).deny
    expect(matchFirst('echo x > /dev/sda', deny)).toBeDefined()
    expect(matchFirst('echo x 1>/dev/sda', deny)).toBeDefined()
    expect(matchFirst('dd if=img of=/dev/disk2', deny)).toBeDefined()
  })

  it('普通重定向/读写不受影响', () => {
    const deny = resolveConfig({}).deny
    expect(matchFirst('echo hi > /tmp/x', deny)).toBeUndefined()
    expect(matchFirst('cat /dev/null', deny)).toBeUndefined()
    expect(matchFirst('ls', deny)).toBeUndefined()
  })
})
