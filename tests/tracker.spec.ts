import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { DenialTracker } from '../src/tracker.ts'
import type { AgentLike } from '../src/tracker.ts'

function fakeAgent(events: SessionEvent[] = []): AgentLike & { events: SessionEvent[] } {
  return { session: { snapshotEvents: () => events }, events }
}

function turnStart(turn: number): SessionEvent {
  return { type: 'turn/start', seq: 0, time: Date.now(), data: { turn } } as SessionEvent
}

describe('DenialTracker（本 turn deny 计数）', () => {
  it('recordDenial 累计本 turn 计数', () => {
    const tracker = new DenialTracker()
    const agent = fakeAgent()
    expect(tracker.denials(agent)).toBe(0)
    tracker.recordDenial(agent)
    tracker.recordDenial(agent)
    expect(tracker.denials(agent)).toBe(2)
  })

  it('新 turn 的 turn/start 事件重置计数', () => {
    const tracker = new DenialTracker()
    const agent = fakeAgent([turnStart(1)])
    tracker.recordDenial(agent)
    tracker.recordDenial(agent)
    expect(tracker.denials(agent)).toBe(2)
    // turn 2 开始：log 追加 turn/start，计数清零
    agent.events.push(turnStart(2))
    expect(tracker.denials(agent)).toBe(0)
  })

  it('游标增量扫描：同一 turn 内追加的其它事件不影响计数', () => {
    const tracker = new DenialTracker()
    const agent = fakeAgent([turnStart(1)])
    tracker.recordDenial(agent)
    agent.events.push({ type: 'assistant/chunk', seq: 1, time: Date.now(), data: { turn: 1, step: 1, chunk: { type: 'usage', usage: {} } } } as unknown as SessionEvent)
    expect(tracker.denials(agent)).toBe(1)
    tracker.recordDenial(agent)
    expect(tracker.denials(agent)).toBe(2)
  })

  it('无 agent 的调用不计数', () => {
    const tracker = new DenialTracker()
    tracker.recordDenial(undefined)
    tracker.recordDenial(undefined)
    expect(tracker.denials(undefined)).toBe(0)
  })
})
