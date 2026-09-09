/**
 * 决策历史环形缓冲 + 累计计数（per agent）。
 *
 * 给 client 伴侣包的弹窗表格提供最近决策（时间 / 工具 / 阶段 / 结论 /
 * 命中的 pattern），给 chip 的 hover tooltip 提供累计统计（approvals /
 * denials）。
 *
 * 与 tracker 的分工：tracker 只算「本 turn deny 计数」（chip 的本 turn 显示），
 * 这里算「插件加载以来的累计决策」。无 agent 的调用不记录（与 tracker
 * fail-closed 一致）。
 * @module dsh-auto-approval/history
 */

import type { AgentLike } from './tracker.ts'
import type { DecisionStage } from './audit.ts'

/** 单条决策记录（UI 展示用；不含 callId 等调试细节）。 */
export interface DecisionRecord {
  /** ISO 时间戳。 */
  readonly time: string
  /** tool 名。 */
  readonly tool: string
  /** 判定来源阶段。 */
  readonly stage: DecisionStage
  /** 二态结论（全托管：原 ask 已并入 deny）。 */
  readonly decision: 'allow' | 'deny'
  /** 命中的 pattern 原文（仅 L0-* 阶段）。 */
  readonly pattern?: string
  /** 补充说明（L1 rationale / fail-closed 原因 / pause 计数）。 */
  readonly detail?: string
}

/** 累计决策统计（插件加载以来，per agent）。 */
export interface DecisionCounts {
  readonly approvals: number
  readonly denials: number
}

/** 内部可变计数（对外暴露只读接口）。 */
interface MutableCounts {
  approvals: number
  denials: number
}

interface AgentHistory {
  records: DecisionRecord[]
  counts: MutableCounts
}

/**
 * per-agent 决策历史。记录 append-only，超容量丢最旧的（环形语义）；
 * 累计计数不受容量截断影响（记录被丢但计数保留）。
 */
export class DecisionHistory {
  private readonly states = new WeakMap<object, AgentHistory>()

  constructor(private readonly capacity = 100) {}

  /** 记录一条决策。无 agent（无 session）的调用不记录、不计数。 */
  record(agent: AgentLike | undefined, event: Omit<DecisionRecord, 'time'>): void {
    if (agent === undefined) return
    let state = this.states.get(agent)
    if (state === undefined) {
      state = { records: [], counts: { approvals: 0, denials: 0 } }
      this.states.set(agent, state)
    }
    state.records.push({ time: new Date().toISOString(), ...event })
    if (state.records.length > this.capacity) state.records.shift()
    switch (event.decision) {
      case 'allow': state.counts.approvals += 1; break
      case 'deny': state.counts.denials += 1; break
    }
  }

  /** 该 agent 的最近决策（新→旧，最多 capacity 条）。无 agent 返回空数组。 */
  records(agent: AgentLike | undefined): readonly DecisionRecord[] {
    if (agent === undefined) return []
    const records = this.states.get(agent)?.records
    if (records === undefined) return []
    // 内部 append-only（旧→新），对外暴露新→旧（UI 表格最新在最上）。
    return [...records].reverse()
  }

  /** 该 agent 的累计统计。无 agent 返回全零。 */
  counts(agent: AgentLike | undefined): DecisionCounts {
    if (agent === undefined) return { approvals: 0, denials: 0 }
    const state = this.states.get(agent)
    if (state === undefined) return { approvals: 0, denials: 0 }
    return state.counts
  }
}
