/**
 * Per-turn deny counter (per agent): feeds the remote/chip's "denials this
 * turn" display.
 *
 * Since DSH 0.1.7 the turn boundary is no longer derived lazily from the
 * session log (synchronous history reads are deprecated): a constructor-
 * injected turn reader supplies it instead — the `lastTurn` value of the
 * `turnBoundary` projection (the unit dsh-agent-loop registers). When the
 * reader returns undefined (this composition has no turnBoundary projection)
 * there is no reliable boundary, so the tracker reports 0 and does not count:
 * leaking a count across turns is worse than having no count. Cumulative
 * statistics stay owned by DecisionHistory and are unaffected.
 *
 * A call without an agent (`exec.agent === undefined`) has no session and
 * fails closed: it does not participate in counting.
 * @module dsh-auto-approval/tracker
 */

/** Minimal agent shape the tracker needs (structural typing; tests mock it directly). */
export interface AgentLike {
  readonly session: object
}

/** Reads the current turn number for one agent's session; undefined when no reliable boundary exists. */
export type TurnReader = (agent: AgentLike) => number | undefined

interface AgentState {
  /** Turn number seen at the latest read. */
  turn: number
  /** Times this plugin denied a call within the current turn. */
  denials: number
}

export class DenialTracker {
  private readonly states = new WeakMap<object, AgentState>()

  constructor(private readonly readTurn: TurnReader) {}

  /**
   * Sync one agent's turn state: a new turn reported by the reader resets the
   * deny counter (a new turn is a new user-intent context, so the count starts
   * over). A reader returning undefined drops that agent's state and returns
   * undefined (no reliable boundary → no counting).
   */
  private sync(agent: AgentLike): AgentState | undefined {
    const turn = this.readTurn(agent)
    if (turn === undefined) {
      this.states.delete(agent)
      return undefined
    }
    let state = this.states.get(agent)
    if (state === undefined) {
      state = { turn, denials: 0 }
      this.states.set(agent, state)
    } else if (turn !== state.turn) {
      state.turn = turn
      state.denials = 0
    }
    return state
  }

  /** Denials recorded within the agent's current turn (0 without an agent or a turn boundary). */
  denials(agent: AgentLike | undefined): number {
    if (agent === undefined) return 0
    return this.sync(agent)?.denials ?? 0
  }

  /** Record one deny emitted by this plugin; calls without an agent or a reliable turn boundary do not count. */
  recordDenial(agent: AgentLike | undefined): void {
    if (agent === undefined) return
    const state = this.sync(agent)
    if (state !== undefined) state.denials += 1
  }
}
