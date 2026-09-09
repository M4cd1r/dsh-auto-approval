/**
 * 本 turn deny 计数（per agent）：给 remote/chip 显示"当前 turn 累计被
 * deny 次数"。
 *
 * turn 边界不从 agent 事件订阅，而是惰性读 session log 里最后一个
 * `turn/start`——append-only、seq 连续的 log 配上扫描游标，每次同步是
 * O(增量事件数)，且不存在订阅漏接/时序漂移问题。
 *
 * 无 agent 的调用（`exec.agent === undefined`）拿不到 session，fail-closed：
 * 不参与计数。
 * @module dsh-auto-approval/tracker
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** tracker 依赖的最小 agent 结构（structural typing，测试可直接 mock）。 */
export interface AgentLike {
  readonly session: {
    snapshotEvents(): readonly SessionEvent[]
  }
}

interface AgentState {
  /** 最近一次同步看到的 turn 号；-1 = 尚未看到任何 turn/start。 */
  turn: number
  /** 当前 turn 内被本插件 deny 的次数。 */
  denials: number
  /** session log 的扫描游标（log append-only，游标只会前进）。 */
  cursor: number
}

export class DenialTracker {
  private readonly states = new WeakMap<object, AgentState>()

  /**
   * 同步 agent 的 turn 状态：从游标处扫到 log 末尾，遇到 turn 号变化即
   * 清零 deny 计数（新 turn = 新的用户意图上下文，计数重新起算）。
   */
  private sync(agent: AgentLike): AgentState {
    let state = this.states.get(agent)
    if (state === undefined) {
      state = { turn: -1, denials: 0, cursor: 0 }
      this.states.set(agent, state)
    }
    const events = agent.session.snapshotEvents()
    for (let seq = state.cursor; seq < events.length; seq++) {
      const event = events[seq]
      if (event !== undefined && event.type === 'turn/start' && event.data.turn !== state.turn) {
        state.turn = event.data.turn
        state.denials = 0
      }
    }
    state.cursor = events.length
    return state
  }

  /** 该 agent 当前 turn 内累计被 deny 的次数（无 agent 返回 0）。 */
  denials(agent: AgentLike | undefined): number {
    if (agent === undefined) return 0
    return this.sync(agent).denials
  }

  /** 记录一次本插件发出的 deny。无 agent 的调用不计数。 */
  recordDenial(agent: AgentLike | undefined): void {
    if (agent === undefined) return
    this.sync(agent).denials += 1
  }
}
