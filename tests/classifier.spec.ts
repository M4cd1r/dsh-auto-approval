import { describe, expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { classifyL1 } from '../src/classifier.ts'
import type { LlmLike } from '../src/classifier.ts'
import type { ResolvedClassifierConfig } from '../src/config.ts'

const CONFIG: ResolvedClassifierConfig = {
  fast: { provider: 'p', model: 'fast-m' },
  deep: { provider: 'p', model: 'deep-m' },
  timeoutMs: 5000,
}

const INPUT = { intent: 'fix the failing test', toolName: 'bash', args: { command: 'pnpm test' } }

function textChunks(text: string, finishKind: 'stop' | 'max-tokens' = 'stop'): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'finish', reason: { kind: finishKind } },
  ]
}

/** 按调用次序返回预置文本的 stub；calls 记录每次调用的路由。 */
function stubLlm(...responses: Array<string | ((options: GenerateOptions) => AsyncIterable<StreamChunk>)>): LlmLike & { calls: GenerateOptions[] } {
  const calls: GenerateOptions[] = []
  let seq = 0
  return {
    calls,
    stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      calls.push(options)
      const response = responses[seq++] ?? responses[responses.length - 1]
      if (typeof response === 'function') return response(options)
      const chunks = textChunks(response ?? '')
      return (async function* () { for (const chunk of chunks) yield chunk })()
    },
  }
}

describe('classifyL1 两阶段判定', () => {
  it('Stage 1 返回 0 → 直接 allow，不再调用 Stage 2', async () => {
    const llm = stubLlm('0')
    const outcome = await classifyL1(llm, CONFIG, INPUT)
    expect(outcome).toMatchObject({ status: 'allow', stage: 'L1-fast', route: CONFIG.fast })
    expect(llm.calls).toHaveLength(1)
    expect(llm.calls[0]?.model).toBe('fast-m')
    expect(llm.calls[0]?.maxTokens).toBe(16)
    expect(llm.calls[0]?.reasoningEffort).toBe('off')
  })

  it('Stage 1 max-tokens 截断但首字符为 0 → 仍直接 allow（截断不影响首字符判定）', async () => {
    const llm = stubLlm(() => (async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '0' }
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
    })())
    const outcome = await classifyL1(llm, CONFIG, INPUT)
    expect(outcome).toMatchObject({ status: 'allow', stage: 'L1-fast' })
    expect(llm.calls).toHaveLength(1)
  })

  it('Stage 1 max-tokens 截断且首字符非 0 → 进 Stage 2，deep 正常判定（保守方向）', async () => {
    const llm = stubLlm(
      () => (async function* (): AsyncGenerator<StreamChunk> {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: '1' }
        yield { type: 'finish', reason: { kind: 'max-tokens' } }
      })(),
      'Deletes files outside the request.\nVERDICT: DENY',
    )
    const outcome = await classifyL1(llm, CONFIG, INPUT)
    expect(outcome).toMatchObject({ status: 'deny', stage: 'L1-deep' })
    expect(llm.calls).toHaveLength(2)
  })

  it('Stage 2 max-tokens 截断但含 VERDICT 行 → 仍成功判定（verdict 提取兜底）', async () => {
    const llm = stubLlm('1', () => (async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Deletes files.\nVERDICT: DENY' }
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
    })())
    expect(await classifyL1(llm, CONFIG, INPUT)).toMatchObject({ status: 'deny', stage: 'L1-deep' })
  })

  it('Stage 2 max-tokens 截断且无 VERDICT → fail-closed（安全方向）', async () => {
    const llm = stubLlm('1', () => (async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'It is probably fine.' }
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
    })())
    expect(await classifyL1(llm, CONFIG, INPUT)).toMatchObject({ status: 'fail-closed', stage: 'L1-deep' })
  })

  it('Stage 1 flagged → Stage 2 CoT 深查，VERDICT: DENY', async () => {
    const llm = stubLlm('1', 'This deletes user data outside intent.\nVERDICT: DENY')
    const outcome = await classifyL1(llm, CONFIG, INPUT)
    expect(outcome).toMatchObject({ status: 'deny', stage: 'L1-deep', route: CONFIG.deep })
    expect(llm.calls).toHaveLength(2)
    expect(llm.calls[1]?.model).toBe('deep-m')
    if (outcome.status === 'deny') expect(outcome.rationale).toContain('deletes user data')
  })

  it('Stage 2 VERDICT: ASK 不是合法结论 → fail-closed（全托管无 ask 档，ASK 不匹配即拒绝）', async () => {
    const llm = stubLlm('1', 'unclear intent\nVERDICT: ASK')
    expect(await classifyL1(llm, CONFIG, INPUT)).toMatchObject({ status: 'fail-closed', stage: 'L1-deep' })
  })

  it('Stage 1 输出非 0（含垃圾输出）一律进 Stage 2', async () => {
    const llm = stubLlm('maybe?', 'VERDICT: ALLOW')
    const outcome = await classifyL1(llm, CONFIG, INPUT)
    expect(outcome).toMatchObject({ status: 'allow', stage: 'L1-deep' })
    expect(llm.calls).toHaveLength(2)
  })

  it('Stage 2 无 VERDICT 行 → fail-closed', async () => {
    const llm = stubLlm('1', 'I am not sure what to do here.')
    expect(await classifyL1(llm, CONFIG, INPUT)).toMatchObject({ status: 'fail-closed', stage: 'L1-deep' })
  })

  it('模型流抛错 → fail-closed，不向上抛', async () => {
    const llm = stubLlm(() => (async function* (): AsyncGenerator<StreamChunk> {
      throw new Error('connection reset')
    })())
    expect(await classifyL1(llm, CONFIG, INPUT)).toMatchObject({ status: 'fail-closed', stage: 'L1-fast' })
  })

  it('模型请求 tool-call → fail-closed（输出契约只允许文本）', async () => {
    const llm = stubLlm(() => (async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: 'x' as never, argumentsDelta: '{}' }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    })())
    expect(await classifyL1(llm, CONFIG, INPUT)).toMatchObject({ status: 'fail-closed' })
  })

  it('超时（deadline abort signal）→ fail-closed', async () => {
    const llm = stubLlm((options) => (async function* (): AsyncGenerator<StreamChunk> {
      // 模拟一个永不自然结束的流，只在 signal abort 时抛错（真实 adapter 的行为）
      await new Promise<never>((_, reject) => {
        options.signal?.addEventListener('abort', () => reject(options.signal?.reason ?? new Error('aborted')))
      })
    })())
    const outcome = await classifyL1(llm, { ...CONFIG, timeoutMs: 20 }, INPUT)
    expect(outcome).toMatchObject({ status: 'fail-closed' })
    expect(llm.calls[0]?.signal).toBeInstanceOf(AbortSignal)
  })

  it('guidance 注入 Stage 2 system prompt', async () => {
    const llm = stubLlm('1', 'VERDICT: ALLOW')
    await classifyL1(llm, { ...CONFIG, guidance: 'never allow network calls' }, INPUT)
    expect(llm.calls[1]?.system).toContain('never allow network calls')
  })
})
