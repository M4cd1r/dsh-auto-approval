/**
 * 审计：每次判定落一条 `auto-approval/decision` session 事件（可回放），
 * 命中的 pattern 原文只出现在这里和日志里，不进返回给模型的 reason（M2）。
 *
 * 审计是 best-effort：append 失败（如无 session、数据不可序列化）只记
 * warn，绝不影响审批决策本身。
 * @module dsh-auto-approval/audit
 */

import type { Context } from '@deepseek-ai/cordis'
import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ModelRoute } from './config.ts'
import type { AgentLike } from './tracker.ts'

/** 判定来源阶段。 */
export type DecisionStage =
  /** L0 deny 规则命中（含 guard 路径）。 */
  | 'L0-deny'
  /** L0 自毁护栏：终止宿主进程的命令。 */
  | 'L0-selfkill'
  /** L0 ask 规则命中（语义已改：askPatterns 命中即 deny）。 */
  | 'L0-ask'
  /** autoApproveTools 白名单。 */
  | 'whitelist'
  /** L1 Stage 1 fast 过滤直接放行。 */
  | 'L1-fast'
  /** L1 Stage 2 CoT 深查得出结论。 */
  | 'L1-deep'
  /** L1 不可用（无模型/无意图/超时/解析失败），fail-closed 转 deny。 */
  | 'L1-fail-closed'
  /** 未配置分类器路由：白名单之外 fail-closed deny。 */
  | 'L1-unconfigured'

/** `auto-approval/decision` 事件载荷（必须 lossless JSON）。
 * 全托管收敛为 allow/deny 两态：不确定的调用（原 askPatterns 命中、L1 ASK、
 * fail-closed）统一 deny。 */
export interface AutomodeDecisionEvent {
  /** tool 名。 */
  readonly tool: string
  /** 本次调用 id。 */
  readonly callId: string
  /** 判定来源阶段。 */
  readonly stage: DecisionStage
  /** 二态结论。 */
  readonly decision: 'allow' | 'deny'
  /** 命中的 pattern 原文（仅 L0-* 阶段；pattern 的唯一落点）。 */
  readonly pattern?: string
  /** L1 使用的模型路由（仅 L1-* 阶段）。 */
  readonly route?: ModelRoute
  /** L1 耗时（毫秒，仅 L1-* 阶段）。 */
  readonly latencyMs?: number
  /** 补充说明（如 fail-closed 的原因、pause 的计数）。 */
  readonly detail?: string
}

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /** automode 插件的每次 tool-call 判定记录（log-only，不进模型历史）。 */
    'auto-approval/decision': AutomodeDecisionEvent
  }
}

/**
 * 独立决策日志：`$DSH_HOME/logs/auto-approval.log`（默认 `~/.dsh/logs/...`）。
 * UI 没有任何通道渲染插件的决策（host 白名单 + toolviews 硬编码，见 issue 调研），
 * 文件日志是用户侧唯一不依赖 UI 的观测手段。每行一条 JSON，人读友好。
 *
 * 写入走串行队列（appendFile 本身无锁，同进程并发会交叉），失败只 warn，
 * 与 session 审计一样 best-effort，绝不阻塞审批决策。
 */
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
export const DECISION_LOG_PATH = join(DSH_HOME, 'logs', 'auto-approval.log')

/** 首次写入前的 mkdir 一次性准备。 */
let logReady: Promise<void> | undefined
function ensureLogReady(): Promise<void> {
  logReady ??= mkdir(join(DSH_HOME, 'logs'), { recursive: true }).then(() => undefined)
  return logReady
}

/** 串行写队列：前一条落盘后才写下一条，保证同进程内顺序。 */
let writeChain: Promise<void> = Promise.resolve()
function enqueueLogLine(ctx: Context, line: object): void {
  const logger = ctx.logger('auto-approval')
  writeChain = writeChain
    .then(async () => {
      await ensureLogReady()
      await appendFile(DECISION_LOG_PATH, `${JSON.stringify(line)}\n`, 'utf8')
    })
    .catch((error: unknown) => {
      logger.warn(`decision log append failed: ${error instanceof Error ? error.message : String(error)}`)
    })
}

/** 插件生命周期记录：arm（启用）时的配置摘要，第一行即可确认插件是否在跑。 */
export function auditArmed(ctx: Context, summary: {
  readonly deny: number
  readonly ask: number
  readonly autoApproveTools: number
  readonly classifier: string
}): void {
  enqueueLogLine(ctx, { type: 'auto-approval/armed', time: new Date().toISOString(), ...summary })
}

/**
 * 落一条审计事件。无 agent（无 session）时跳过；append 异常被吞掉并记
 * warn——审计永远不该阻断 tool 执行。
 *
 * 08-12 final 起 session 读取对未声明事件类型 fail-closed
 * （`KNOWN_SESSION_EVENT_TYPES` 白名单，`Session.append()` 无 ignorable
 * 通道），写自定义事件会使该 session 重启后无法打开——session 事件写入
 * 由 `auditSessionEvents` 开关控制（默认 false）；文件日志
 * `~/.dsh/logs/auto-approval.log` 始终记录，不受影响。
 */
export function audit(ctx: Context, agent: AgentLike | undefined, event: AutomodeDecisionEvent, sessionEvents: boolean): void {
  enqueueLogLine(ctx, { type: 'auto-approval/decision', time: new Date().toISOString(), ...event })
  if (agent === undefined || !sessionEvents) {
    if (agent === undefined) {
      ctx.logger('auto-approval').debug(`decision (agent-less, no session): ${JSON.stringify(event)}`)
    }
    return
  }
  try {
    // 结构化收窄：Session.append 的泛型签名无法直接赋入最小接口，这里只
    // 断言行存在（真实 Session 必有 append；mock 也会提供）。
    const session = agent.session as unknown as { append(type: string, data: AutomodeDecisionEvent): unknown }
    session.append('auto-approval/decision', event)
  } catch (error: unknown) {
    ctx.logger('auto-approval').warn(`audit append failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
