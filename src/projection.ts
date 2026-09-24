/**
 * Host-only `autoApprovalIntent` projection: folds the latest real user
 * message text that L1 uses as its intent input.
 *
 * DSH 0.1.7 deprecated synchronous session history reads (event-log scans):
 * state must be reconstructable from projections, never from history scans.
 * This unit keeps the old scan's exact semantics — only messages with
 * `source.kind === 'user'` count, so plugin-injected content (ask-user tool
 * returns, agent.inject context) never counts as authorization — and caps the
 * stored text at {@link MAX_INTENT_CHARS} (the classifier frame re-truncates
 * to the same bound, so persisting the capped form is behavior-preserving and
 * keeps the checkpoint small).
 *
 * Host-only: no `SessionProjectionMap` entry and no `wire` block — the client
 * never sees the user's raw intent.
 * @module dsh-auto-approval/projection
 */

import { z } from 'zod'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { MAX_INTENT_CHARS, truncate } from './frame.ts'

/** The projection state: the latest real user message text, or null before the first one. */
export interface AutoApprovalIntentState {
  readonly intent: string | null
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    autoApprovalIntent: AutoApprovalIntentState
  }
}

/**
 * The intent fold unit. `apply` must return the SAME state reference for
 * events it does not own (the registry's `Object.is` gate suppresses all
 * downstream work for unchanged references) — including a repeated identical
 * intent.
 */
export const autoApprovalIntentProjection: ProjectionDefinition<'autoApprovalIntent'> = {
  key: 'autoApprovalIntent',
  stateSchema: z.object({ intent: z.string().nullable() }).strict(),
  stateVersion: 1,
  init: () => ({ intent: null }),
  apply: (state, event) => {
    if (event.type !== 'user/message' || event.data.source.kind !== 'user') return state
    const text = event.data.content
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim()
    if (text.length === 0) return state
    const intent = truncate(text, MAX_INTENT_CHARS)
    return intent === state.intent ? state : { intent }
  },
}
