import { describe, expect, it } from 'vitest'
import { DenialTracker } from '../src/tracker.ts'
import type { AgentLike } from '../src/tracker.ts'

function fakeAgent(): AgentLike {
  return { session: { id: 'session-1' } }
}

describe('DenialTracker (per-turn denial count via the injected turn reader)', () => {
  it('counts denials within one turn', () => {
    const tracker = new DenialTracker(() => 1)
    const agent = fakeAgent()
    expect(tracker.denials(agent)).toBe(0)
    tracker.recordDenial(agent)
    tracker.recordDenial(agent)
    expect(tracker.denials(agent)).toBe(2)
  })

  it('resets the count when the reader reports a new turn', () => {
    let turn = 1
    const tracker = new DenialTracker(() => turn)
    const agent = fakeAgent()
    tracker.recordDenial(agent)
    tracker.recordDenial(agent)
    expect(tracker.denials(agent)).toBe(2)
    turn = 2
    expect(tracker.denials(agent)).toBe(0)
    tracker.recordDenial(agent)
    expect(tracker.denials(agent)).toBe(1)
  })

  it('reports 0 and no-ops when the reader returns undefined (no turnBoundary projection)', () => {
    let turn: number | undefined = 1
    const tracker = new DenialTracker(() => turn)
    const agent = fakeAgent()
    tracker.recordDenial(agent)
    tracker.recordDenial(agent)
    expect(tracker.denials(agent)).toBe(2)
    turn = undefined
    // Without a reliable turn boundary a per-turn count must not leak across turns.
    expect(tracker.denials(agent)).toBe(0)
    tracker.recordDenial(agent)
    expect(tracker.denials(agent)).toBe(0)
  })

  it('counts independently per agent', () => {
    const turns = new Map<AgentLike, number>()
    const tracker = new DenialTracker(agent => turns.get(agent))
    const a = fakeAgent()
    const b = fakeAgent()
    turns.set(a, 1)
    turns.set(b, 1)
    tracker.recordDenial(a)
    tracker.recordDenial(a)
    tracker.recordDenial(b)
    expect(tracker.denials(a)).toBe(2)
    expect(tracker.denials(b)).toBe(1)
    turns.set(b, 2)
    expect(tracker.denials(b)).toBe(0)
    expect(tracker.denials(a)).toBe(2)
  })

  it('still reports 0 for an undefined agent', () => {
    const tracker = new DenialTracker(() => 1)
    tracker.recordDenial(undefined)
    expect(tracker.denials(undefined)).toBe(0)
  })
})
