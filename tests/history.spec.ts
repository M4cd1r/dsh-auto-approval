import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { DecisionHistory } from '../src/history.ts'

function fakeAgent(): Agent {
  const session = {
    id: 'session-h',
    snapshotEvents: () => [] as SessionEvent[],
    append() {},
  }
  return { session } as unknown as Agent
}

function event(overrides: Partial<{
  tool: string
  stage: 'L0-deny' | 'L0-ask' | 'whitelist' | 'L1-unconfigured'
  decision: 'allow' | 'deny'
  pattern: string
  detail: string
}> = {}) {
  return {
    tool: overrides.tool ?? 'bash',
    stage: overrides.stage ?? 'L0-deny',
    decision: overrides.decision ?? 'deny',
    ...(overrides.pattern === undefined ? {} : { pattern: overrides.pattern }),
    ...(overrides.detail === undefined ? {} : { detail: overrides.detail }),
  }
}

describe('DecisionHistory', () => {
  it('无 agent 的调用不记录也不计数', () => {
    const h = new DecisionHistory()
    h.record(undefined, event())
    expect(h.records(undefined)).toEqual([])
    expect(h.counts(undefined)).toEqual({ approvals: 0, denials: 0 })
  })

  it('记录按 agent 隔离', () => {
    const h = new DecisionHistory()
    const a = fakeAgent()
    const b = fakeAgent()
    h.record(a, event({ decision: 'deny' }))
    h.record(b, event({ decision: 'allow', stage: 'whitelist' }))
    expect(h.counts(a)).toEqual({ approvals: 0, denials: 1 })
    expect(h.counts(b)).toEqual({ approvals: 1, denials: 0 })
    expect(h.records(a)).toHaveLength(1)
    expect(h.records(b)).toHaveLength(1)
  })

  it('累计计数不受环形截断影响', () => {
    const h = new DecisionHistory(2)
    const a = fakeAgent()
    h.record(a, event({ decision: 'allow', stage: 'whitelist' }))
    h.record(a, event({ decision: 'deny', stage: 'L0-ask' }))
    h.record(a, event({ decision: 'deny' }))
    expect(h.records(a)).toHaveLength(2)
    expect(h.records(a)[0]).toMatchObject({ decision: 'deny' })
    expect(h.records(a)[1]).toMatchObject({ decision: 'deny' })
    expect(h.counts(a)).toEqual({ approvals: 1, denials: 2 })
  })

  it('记录带 ISO 时间和可选字段', () => {
    const h = new DecisionHistory()
    const a = fakeAgent()
    h.record(a, event({ decision: 'deny', pattern: 'rm\\s' }))
    const record = h.records(a)[0]
    expect(typeof record.time).toBe('string')
    expect(new Date(record.time).getTime()).not.toBeNaN()
    expect(record).toMatchObject({ tool: 'bash', stage: 'L0-deny', decision: 'deny', pattern: 'rm\\s' })
  })
})
