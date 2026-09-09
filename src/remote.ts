/**
 * host→browser 状态通道：把 automode 的"运行态"（armed 配置摘要 +
 * 当前 agent 本 turn 的 deny 计数 / 暂停状态 / 累计决策统计 + 最近决策
 * 历史）通过 Typert remote 方法暴露给浏览器伴侣包，供权限选择器旁的
 * chip 读取（hover 统计 + 点击弹窗表格）。
 *
 * 选 remote 而非投影：chip 要的是运行态，投影必须从 session 事件 fold——
 * 写自定义事件会踩 08-12 final 的 `KNOWN_SESSION_EVENT_TYPES` 白名单
 * （第三方 `Session.append()` 无 ignorable 通道）。remote 直接读 host 内存态，
 * 不落 session 事件，且无 allowlist 限制。
 *
 * `@Remote` 方法里的 `Agent` 参数走 typert lookup：client 侧传 sessionId，
 * gateway 自动解析成 Agent 对象（与 `commands.list(agent)` 同机制）。
 * 只读服务：开关是权限 preset，不再有 setEnabled 写路径。
 * @module dsh-auto-approval/remote
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { DecisionRecord } from './history.ts'

/** wire 上传输的 automode 状态快照（纯 JSON，无运行态引用）。 */
export interface AutomodeStatus {
  /** L0 deny 规则数。 */
  readonly denyPatterns: number
  /** L0 legacy ask 规则数（命中即 deny，全托管不转人工）。 */
  readonly askPatterns: number
  /** 免审工具白名单数量。 */
  readonly autoApproveTools: number
  /** L1 classifier 路由（`provider/model`），未配置时为 `'disabled'`。 */
  readonly classifier: string
  /** 当前 agent 本 turn 内累计被 deny 的次数。 */
  readonly denials: number
  /** 累计放行次数（插件加载以来）。 */
  readonly approvals: number
  /** 累计 deny 次数（插件加载以来）。 */
  readonly totalDenials: number
}

/** 状态读取 thunk：由 apply 闭包提供（读 resolved config + tracker + history）。 */
export type StatusReader = (agent: Agent | undefined) => AutomodeStatus

/** 最近决策读取 thunk：由 apply 闭包提供（读 history）。 */
export type HistoryReader = (agent: Agent | undefined) => readonly DecisionRecord[]

/** remote 服务依赖的 host 闭包集合。 */
export interface AutomodeRemoteHooks {
  readonly read: StatusReader
  readonly history: HistoryReader
}

/**
 * automode 状态 remote 服务。注册为 Cordis 服务并绑定 Typert Gateway，
 * client 侧通过 `ctx.remote.automodeStatus.getStatus(sessionId)` /
 * `getHistory(sessionId)` 调用。
 */
export class AutomodeStatusService extends TypertRemoteService {
  private readonly hooks: AutomodeRemoteHooks

  constructor(ctx: Context, hooks: AutomodeRemoteHooks) {
    super(ctx, 'automodeStatus')
    this.hooks = hooks
  }

  /** 当前 agent 的 automode 状态快照（无 agent 则 denials/统计归零）。 */
  @Remote
  getStatus(agent: Agent): AutomodeStatus {
    return this.hooks.read(agent)
  }

  /** 当前 agent 的最近决策历史（新→旧，最多 100 条；无 agent 返回空数组）。 */
  @Remote
  getHistory(agent: Agent): DecisionRecord[] {
    return [...this.hooks.history(agent)]
  }
}
