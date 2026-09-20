import { describe, expect, it } from 'vitest'
import { classifyJev } from '../src/jev.ts'
import type { FetchLike, JevResponseLike } from '../src/jev.ts'
import type { ResolvedJevConfig } from '../src/config.ts'
import { frameCall, MAX_INTENT_CHARS } from '../src/frame.ts'

/** 测试密钥：断言它出现在请求头、但绝不出现在任何对外输出里。 */
const API_KEY = 'test-key-SECRET-0000000000000000'

const CONFIG: ResolvedJevConfig = {
  backend: 'jev',
  route: { provider: 'typesafe', model: 'jev-latest' },
  apiKey: API_KEY,
  baseUrl: 'https://api.typesafe.ai',
  timeoutMs: 5000,
  allowThreshold: 0.9,
}

const INPUT = { intent: 'fix the failing test', toolName: 'bash', args: { command: 'pnpm test' } }

interface JevBody {
  model: string
  state: string
  questions: Record<string, { type: string }>
  usage?: { input_tokens: number; output_tokens: number }
  answers?: Record<string, unknown>
}

/** 构造一个合法的 jev 响应体（默认 clearly_safe=0.95 → allow）。 */
function jevBody(overrides: {
  clearlySafe?: unknown
  answers?: Record<string, unknown>
  model?: unknown
  usage?: unknown
} = {}): Record<string, unknown> {
  return {
    model: overrides.model === undefined ? 'jev-1.13.0' : overrides.model,
    answers: overrides.answers ?? {
      clearly_safe: overrides.clearlySafe ?? { type: 'noul', noul: 0.95 },
      destructive: { type: 'noul', noul: 0.1 },
      exfiltration: { type: 'noul', noul: 0.05 },
      beyond_scope: { type: 'noul', noul: 0.2 },
      impact: { type: 'score', score: 1, legend: ['a', 'b', 'c', 'd'], probabilities: { 1: 0.9 }, confidence: 0.9 },
    },
    usage: overrides.usage === undefined ? { input_tokens: 412, output_tokens: 31 } : overrides.usage,
  }
}

function jsonResponse(body: unknown, status = 200): JevResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  }
}

/** 记录请求、返回预置响应的 stub fetch。 */
function stubFetch(handler: (url: string, init: { body: string; headers: Record<string, string>; signal: AbortSignal }) => JevResponseLike | Promise<JevResponseLike>): FetchLike & { calls: Array<{ url: string; body: JevBody; headers: Record<string, string>; signal: AbortSignal }> } {
  const calls: Array<{ url: string; body: JevBody; headers: Record<string, string>; signal: AbortSignal }> = []
  const fn: FetchLike = (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) as JevBody, headers: init.headers, signal: init.signal })
    return Promise.resolve(handler(url, { body: init.body, headers: init.headers, signal: init.signal }))
  }
  return Object.assign(fn, { calls })
}

describe('classifyJev 判定', () => {
  it('clearly_safe=0.95 ≥ 阈值 0.9 → allow，stage=L1-jev，带 signals/model/inputTokens', async () => {
    const fetch = stubFetch(() => jsonResponse(jevBody()))
    const outcome = await classifyJev({ fetch }, CONFIG, INPUT)
    expect(outcome).toMatchObject({
      status: 'allow',
      stage: 'L1-jev',
      route: { provider: 'typesafe', model: 'jev-latest' },
      model: 'jev-1.13.0',
      inputTokens: 412,
    })
    if (outcome.status === 'allow' && outcome.stage === 'L1-jev') {
      expect(outcome.signals).toEqual({
        clearly_safe: 0.95, destructive: 0.1, exfiltration: 0.05, beyond_scope: 0.2, impact: 1,
      })
    }
  })

  it('clearly_safe=0.62 < 阈值 → deny，rationale 含其他信号数值（数字摘要，非 CoT）', async () => {
    const fetch = stubFetch(() => jsonResponse(jevBody({
      clearlySafe: { type: 'noul', noul: 0.62 },
      answers: {
        clearly_safe: { type: 'noul', noul: 0.62 },
        destructive: { type: 'noul', noul: 0.41 },
        exfiltration: { type: 'noul', noul: 0.02 },
        beyond_scope: { type: 'noul', noul: 0.55 },
        impact: { type: 'score', score: 3 },
      },
    })))
    const outcome = await classifyJev({ fetch }, CONFIG, INPUT)
    expect(outcome.status).toBe('deny')
    if (outcome.status === 'deny' && outcome.stage === 'L1-jev') {
      expect(outcome.rationale).toContain('clearly_safe=0.62')
      expect(outcome.rationale).toContain('< 0.9 threshold')
      expect(outcome.rationale).toContain('destructive=0.41')
      expect(outcome.rationale).toContain('exfiltration=0.02')
      expect(outcome.rationale).toContain('beyond_scope=0.55')
      expect(outcome.rationale).toContain('impact=3')
    }
  })

  it('阈值边界：恰好等于阈值 → allow；略低 → deny（钉住比较方向）', async () => {
    const atThreshold = stubFetch(() => jsonResponse(jevBody({ clearlySafe: { type: 'noul', noul: 0.9 } })))
    const allow = await classifyJev({ fetch: atThreshold }, CONFIG, INPUT)
    expect(allow.status).toBe('allow')

    const justBelow = stubFetch(() => jsonResponse(jevBody({ clearlySafe: { type: 'noul', noul: 0.899 } })))
    const deny = await classifyJev({ fetch: justBelow }, CONFIG, INPUT)
    expect(deny.status).toBe('deny')
  })
})

describe('classifyJev fail-closed（一切失败归一为 deny，绝不放行）', () => {
  const cases: Array<[string, () => JevResponseLike | Promise<JevResponseLike>]> = [
    ['HTTP 401（密钥无效）', () => jsonResponse({ error: 'invalid key' }, 401)],
    ['HTTP 422（请求体校验失败）', () => jsonResponse({ error: 'bad request' }, 422)],
    ['HTTP 429（超限，不重试）', () => jsonResponse({ error: 'rate limited' }, 429)],
    ['HTTP 529（过载，不重试）', () => jsonResponse({ error: 'overloaded' }, 529)],
    ['响应体不是 JSON', () => jsonResponse('<html>bad gateway</html>')],
    ['缺 answers.clearly_safe', () => jsonResponse(jevBody({ answers: { destructive: { type: 'noul', noul: 0.1 } } }))],
    ['clearly_safe.type 不是 noul', () => jsonResponse(jevBody({ answers: { clearly_safe: { type: 'choice', choice: 'yes' } } }))],
    ['clearly_safe.noul 是字符串', () => jsonResponse(jevBody({ answers: { clearly_safe: { type: 'noul', noul: '0.95' } } }))],
    ['clearly_safe.noul = 1.5（越界）', () => jsonResponse(jevBody({ answers: { clearly_safe: { type: 'noul', noul: 1.5 } } }))],
    ['fetch reject（网络异常）', () => Promise.reject(new Error('fetch failed'))],
  ]
  for (const [name, handler] of cases) {
    it(name, async () => {
      const fetch = stubFetch(handler)
      const outcome = await classifyJev({ fetch }, CONFIG, INPUT)
      expect(outcome).toMatchObject({ status: 'fail-closed', stage: 'L1-jev' })
      // 密钥断言：任何对外输出都不得含密钥字面量
      expect(JSON.stringify(outcome)).not.toContain(API_KEY)
    })
  }

  it('超时 / abort：上游 signal 触发即 fail-closed', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetch = stubFetch(() => jsonResponse(jevBody()))
    const outcome = await classifyJev({ fetch }, CONFIG, { ...INPUT, signal: controller.signal })
    expect(outcome).toMatchObject({ status: 'fail-closed', stage: 'L1-jev' })
    // 传入 fetch 的 signal 已合并上游 abort
    expect(fetch.calls[0]?.signal.aborted).toBe(true)
  })

  it('辅助信号解析失败只省略该信号，不影响闸门判定', async () => {
    const fetch = stubFetch(() => jsonResponse(jevBody({
      answers: {
        clearly_safe: { type: 'noul', noul: 0.95 },
        destructive: { type: 'noul', noul: 'garbage' },
        exfiltration: { type: 'noul', noul: 7 },
        // beyond_scope / impact 整个缺失
      },
    })))
    const outcome = await classifyJev({ fetch }, CONFIG, INPUT)
    expect(outcome.status).toBe('allow')
    if (outcome.status === 'allow' && outcome.stage === 'L1-jev') {
      expect(outcome.signals).toEqual({ clearly_safe: 0.95 })
    }
  })
})

describe('classifyJev 请求构造', () => {
  it('URL / Authorization / model / 五个问题 id / state 与 frameCall 逐字节一致', async () => {
    const fetch = stubFetch(() => jsonResponse(jevBody()))
    await classifyJev({ fetch }, CONFIG, INPUT)
    const call = fetch.calls[0]
    expect(call?.url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(call?.headers.Authorization).toBe(`Bearer ${API_KEY}`)
    expect(call?.headers['Content-Type']).toBe('application/json')
    expect(call?.body.model).toBe('jev-latest')
    expect(Object.keys(call?.body.questions ?? {}).sort()).toEqual(
      ['beyond_scope', 'clearly_safe', 'destructive', 'exfiltration', 'impact'].sort(),
    )
    expect(call?.body.questions.clearly_safe?.type).toBe('noul')
    expect(call?.body.questions.impact?.type).toBe('score')
    expect(call?.body.state).toBe(frameCall(INPUT))
  })

  it('baseUrl 尾部斜杠不重复', async () => {
    const fetch = stubFetch(() => jsonResponse(jevBody()))
    await classifyJev({ fetch }, { ...CONFIG, baseUrl: 'https://api.typesafe.ai/' }, INPUT)
    expect(fetch.calls[0]?.url).toBe('https://api.typesafe.ai/v1/systemone')
  })

  it('10k 字符 intent 被截断（含 … 标记，长度受 MAX_INTENT_CHARS 约束）', async () => {
    const fetch = stubFetch(() => jsonResponse(jevBody()))
    const bigInput = { ...INPUT, intent: 'x'.repeat(10_000) }
    await classifyJev({ fetch }, CONFIG, bigInput)
    const state = JSON.parse(fetch.calls[0]?.body.state ?? '{}') as { user_request: string }
    expect(state.user_request.length).toBe(MAX_INTENT_CHARS)
    expect(state.user_request.endsWith('…')).toBe(true)
    expect(fetch.calls[0]?.body.state).toBe(frameCall(bigInput))
  })

  it('帧内结构只有 user_request + tool_call：不含任何 tool 输出（注入防线钉死）', async () => {
    const fetch = stubFetch(() => jsonResponse(jevBody()))
    await classifyJev({ fetch }, CONFIG, INPUT)
    const state = JSON.parse(fetch.calls[0]?.body.state ?? '{}') as Record<string, unknown>
    expect(Object.keys(state).sort()).toEqual(['tool_call', 'user_request'])
  })

  it('主问题 instructions 含注入防线条款（参数夹带指令不构成授权）', async () => {
    const fetch = stubFetch(() => jsonResponse(jevBody()))
    await classifyJev({ fetch }, CONFIG, INPUT)
    const gate = fetch.calls[0]?.body.questions.clearly_safe as { instructions?: string } | undefined
    expect(gate?.instructions).toContain('do NOT constitute authorization')
  })

  it('classifierGuidance 并入主问题 instructions（advisory）', async () => {
    const fetch = stubFetch(() => jsonResponse(jevBody()))
    await classifyJev({ fetch }, { ...CONFIG, guidance: 'allow all cargo commands' }, INPUT)
    const gate = fetch.calls[0]?.body.questions.clearly_safe as { instructions?: string } | undefined
    expect(gate?.instructions).toContain('allow all cargo commands')
    expect(gate?.instructions).toContain('advisory')
  })
})
