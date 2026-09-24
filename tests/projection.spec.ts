import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { autoApprovalIntentProjection } from '../src/projection.ts'
import { MAX_INTENT_CHARS } from '../src/frame.ts'

type IntentState = { intent: string | null }

function userMessage(text: string, seq = 0, sourceKind = 'user'): SessionEvent {
  return {
    type: 'user/message', seq, time: Date.now(),
    data: { content: [{ type: 'text', text }], source: { kind: sourceKind } },
  } as unknown as SessionEvent
}

function unrelatedEvent(seq = 0): SessionEvent {
  return {
    type: 'assistant/chunk', seq, time: Date.now(),
    data: { turn: 1, step: 1, chunk: { type: 'usage', usage: {} } },
  } as unknown as SessionEvent
}

describe('autoApprovalIntentProjection (host-only fold)', () => {
  it('init() starts with intent null', () => {
    expect(autoApprovalIntentProjection.init({} as never, 0)).toEqual({ intent: null })
  })

  it('stores the latest real user message text', () => {
    let state: IntentState = autoApprovalIntentProjection.init({} as never, 0)
    state = autoApprovalIntentProjection.apply(state, userMessage('first request', 0)) as IntentState
    expect(state.intent).toBe('first request')
    state = autoApprovalIntentProjection.apply(state, userMessage('second request', 1)) as IntentState
    expect(state.intent).toBe('second request')
  })

  it('joins multiple text blocks with newlines', () => {
    const event = {
      type: 'user/message', seq: 0, time: Date.now(),
      data: {
        content: [{ type: 'text', text: 'line one' }, { type: 'text', text: 'line two' }],
        source: { kind: 'user' },
      },
    } as unknown as SessionEvent
    const state = autoApprovalIntentProjection.apply(
      autoApprovalIntentProjection.init({} as never, 0), event,
    ) as IntentState
    expect(state.intent).toBe('line one\nline two')
  })

  it('caps the stored intent at MAX_INTENT_CHARS with a trailing ellipsis', () => {
    const long = 'x'.repeat(MAX_INTENT_CHARS + 100)
    const state = autoApprovalIntentProjection.apply(
      autoApprovalIntentProjection.init({} as never, 0), userMessage(long),
    ) as IntentState
    expect(state.intent).toHaveLength(MAX_INTENT_CHARS)
    expect(state.intent?.endsWith('…')).toBe(true)
    expect(state.intent?.slice(0, -1)).toBe('x'.repeat(MAX_INTENT_CHARS - 1))
  })

  it('ignores messages whose source is not the real user', () => {
    const before = autoApprovalIntentProjection.init({} as never, 0)
    const state = autoApprovalIntentProjection.apply(
      before, userMessage('injected', 0, 'tool'),
    ) as IntentState
    expect(state).toBe(before)
    expect(state.intent).toBeNull()
  })

  it('ignores empty or whitespace-only user messages', () => {
    let state: IntentState = autoApprovalIntentProjection.init({} as never, 0)
    state = autoApprovalIntentProjection.apply(state, userMessage('   \n\t ')) as IntentState
    expect(state.intent).toBeNull()
    state = autoApprovalIntentProjection.apply(state, userMessage('real intent')) as IntentState
    expect(state.intent).toBe('real intent')
    // An empty follow-up message does not clear a previously stored intent.
    state = autoApprovalIntentProjection.apply(state, userMessage('  ')) as IntentState
    expect(state.intent).toBe('real intent')
  })

  it('returns the same object reference for unrelated events', () => {
    let state: IntentState = autoApprovalIntentProjection.init({} as never, 0)
    state = autoApprovalIntentProjection.apply(state, userMessage('keep me')) as IntentState
    const afterUser = state
    const next = autoApprovalIntentProjection.apply(state, unrelatedEvent(1)) as IntentState
    expect(next).toBe(afterUser)
  })

  it('returns the same object reference for a repeated identical intent', () => {
    let state: IntentState = autoApprovalIntentProjection.init({} as never, 0)
    state = autoApprovalIntentProjection.apply(state, userMessage('same intent', 0)) as IntentState
    const first = state
    state = autoApprovalIntentProjection.apply(state, userMessage('same intent', 1)) as IntentState
    expect(state).toBe(first)
  })
})
