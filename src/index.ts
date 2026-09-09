/**
 * DSH 权限自动审批插件 — `dsh-auto-approval`
 *
 * 在 `tools/pre-execute` 瀑布最前挂一个两态 classifier，给 dsh 的 approval
 * policy 增加第三档 `auto`（现有：`ask` / `never`）：
 *
 *   L0 规则引擎（硬底线）→ L1 LLM classifier（意图对齐，可配）
 *
 * 全托管模式：决策收敛为 allow/deny 两态，不转人工。不确定的调用
 * （原 askPatterns 命中、L1 判定 ASK、fail-closed）一律 deny。
 *
 * 设计要点（详见 README「方案设计」）：
 * - L0 deny 同时走 `ctx.tools.guard()` 单调注册（M3），prepend 旁路不掉
 * - deny 的 reason 是通用文案，pattern 只进审计与日志（M2）
 * - 检测到 sandbox escalation 参数即豁免 L1，避免双重审批（M5）
 * - 本 turn deny 计数（tracker）从 session log 的 turn/start 惰性推导
 * - L1 一切失败 fail-closed 转 deny，绝不默认放行
 *
 * @module dsh-auto-approval
 */

import { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution, ToolGuard } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-settings'
import { Config, resolveConfig } from './config.ts'
import type { ResolvedConfig } from './config.ts'
import { classifyL1 } from './classifier.ts'
import type { LlmLike } from './classifier.ts'
import { createDenyGuard, DENY_REASON, extractMatchableText, matchBashPrefix, matchFirst, matchSelfKill, selfKillDenyReason } from './rules.ts'
import { audit, auditArmed } from './audit.ts'
import type { AutomodeDecisionEvent, DecisionStage } from './audit.ts'
import { AutomodeStatusService } from './remote.ts'
import type { HistoryReader, StatusReader } from './remote.ts'
import { isAutomode } from './preset.ts'
import { remoteManifest } from './remote-manifest.ts'
import { DenialTracker } from './tracker.ts'
import { DecisionHistory } from './history.ts'

export const name = 'auto-approval'

/** settings 命名空间：settings.yaml 的 section 名，也是 Web UI 设置页的 section。 */
export const NS = 'auto-approval'

export { Config } from './config.ts'

/** L1 不可用（无模型服务或无用户意图上下文）时 fail-closed 的 deny 文案。 */
const L1_UNAVAILABLE_REASON = 'automode: automatic classifier is unavailable; the call is denied.'

/** L1 判定失败（超时/解析失败）时 fail-closed 的 deny 文案。 */
const L1_FAILED_REASON = 'automode: automatic classifier failed; the call is denied.'

/** 未配置 L1 路由时的 deny 文案（fail-closed，避免橡皮图章）。 */
const L1_UNCONFIGURED_REASON = 'automode: no classifier is configured; only trusted tools and allowlisted commands may run. Configure classifierFastProvider/classifierFastModel to enable automode.'

/**
 * 从 session log 提取最近一条真实用户消息的文本（L1 的意图输入）。
 * 只看 `source.kind === 'user'` 的消息：plugin 注入（ask-user 类工具的
 * 返回、agent.inject 上下文）都不算授权。往回扫到 log 开头为止；这条
 * 路径只在 L1 启用且未被 L0/白名单短路时走到，频率低，线性扫可接受。
 */
function latestUserIntent(agent: Agent | undefined): string | undefined {
  if (agent === undefined) return undefined
  const events = agent.session.snapshotEvents()
  for (let seq = events.length - 1; seq >= 0; seq--) {
    const event = events[seq]
    if (event === undefined || event.type !== 'user/message' || event.data.source.kind !== 'user') continue
    const text = event.data.content
      .map(block => block.type === 'text' ? block.text : `[${block.type} content]`)
      .join('\n')
      .trim()
    if (text.length > 0) return text
  }
  return undefined
}

/** 一次调用的决策上下文：tracker/audit 共用的 agent 与 callId 提取。 */
function callFacts(exec: ToolExecution): { agent: Agent | undefined; callId: string } {
  return { agent: exec.agent, callId: String(exec.callId) }
}

/**
 * 插件入口：挂载 `tools/pre-execute` 瀑布（prepend 最先跑）+ L0 deny 的
 * 单调 guard。配置非法直接 throw（fail-loud，M1）。
 *
 * **开关是权限 preset，不是插件设置**：只有会话处于 `automode` preset
 * （本 bundle 的 patch 往官方 preset 表里加的第四档）时才生效；选其它
 * preset 即完全旁路。这样用户可见的模型是 3 + 1：三档沙箱 + 一档“全托管”。
 *
 * 配置走 `ctx.settings.installSection`（settings 命名空间 `auto-approval`，
 * 只含分类器配置）：composition entry 是 base 层，`$DSH_HOME/settings.yaml`
 * 的 `automode:` section 是 user 层，改动热生效。`validate` 钩子让带非法
 * 正则 / 不成对路由的写在提交前被拒（fail-loud）。settings 服务缺席的
 * 组合（如 headless）自动回退 entry config。
 */
export function apply(ctx: Context, config: Config = {}): void {
  let current: () => Config = () => config
  let resolved: ResolvedConfig = resolveConfig(config)
  let tracker = new DenialTracker()
  const history = new DecisionHistory()
  const logger = ctx.logger('auto-approval')

  /** settings provider 引用（仅用于 arm 日志判断是否已挂 settings）。 */

  /** 本次工具调用是否处于 automode preset 下（无 session 则不接管）。 */
  const gated = (agent: Agent | undefined): boolean => isAutomode(ctx, agent?.session)

  /** 审计入口：文件日志始终写；session 事件按 `auditSessionEvents` 开关（默认关）
   * ——08-12 final 起 session 读取对未声明事件类型 fail-closed（KNOWN_SESSION_EVENT_TYPES
   * 白名单 + append() 无 ignorable 通道），写 session 事件会使该 session 重启后无法打开。
   * 同时把决策记入内存 history（供 remote getHistory / 累计统计），best-effort 不阻塞。 */
  const auditDecision = (ctx: Context, agent: Agent | undefined, event: AutomodeDecisionEvent): void => {
    audit(ctx, agent, event, resolved.auditSessionEvents ?? false)
    history.record(agent, event)
  }

  /** remote 状态读取：读 resolved 配置摘要 + tracker 的 per-agent 运行态 + history 累计统计，不落 session 事件。 */
  const readStatus: StatusReader = (agent) => {
    const counts = history.counts(agent)
    return {
      denyPatterns: resolved.deny.length,
      askPatterns: resolved.ask.length,
      autoApproveTools: resolved.autoApproveTools.size,
      classifier: resolved.classifier === undefined
        ? 'disabled'
        : `${resolved.classifier.fast.provider}/${resolved.classifier.fast.model}`,
      denials: tracker.denials(agent),
      approvals: counts.approvals,
      totalDenials: counts.denials,
    }
  }

  /** remote 最近决策读取：直接读内存 history（无 agent 返回空数组）。 */
  const readHistory: HistoryReader = (agent) => history.records(agent)

  // 注册 remote 服务：Cordis Service 构造器自 provide，并绑定 Typert Gateway。
  new AutomodeStatusService(ctx, { read: readStatus, history: readHistory })

  // 把严格描述符注册进运行时的 typert registry（strict dispatch）。
  // 不能走 SRC fallback（`@Remote` marker 的 WeakMap 是模块级状态，独立
  // 仓库的插件和运行时各持一份 `typert-protocol`，marker 跨不过去——
  // 双包危害）；strict descriptor 直接写进运行时的 registry，绕开共享状态。
  // `ctx.get` 读全局 store（`typert` 由 dsh-typert-registry 提供，是兄弟
  // entry，走 per-fiber store 链会找不到），注册时机早于任何 client 调用。
  // 把严格描述符注册进运行时的 typert registry（strict dispatch）。
  // 不能走 SRC fallback（`@Remote` marker 的 WeakMap 是模块级状态，独立
  // 仓库的插件和运行时各持一份 `typert-protocol`，marker 跨不过去——
  // 双包危害）；strict descriptor 直接写进运行时的 registry，绕开共享状态。
  // `typert` 由 dsh-typert-registry 提供（兄弟 entry），且激活晚于本插件，
  // 用 `ctx.inject` 等它就绪后再注册。
  ctx.inject(['typert'], (typertCtx) => {
    const typert = typertCtx.get('typert') as unknown as { register: (contribution: unknown) => () => void }
    typert.register(remoteManifest)
  })

  const arm = (): void => {
    if (resolved.classifier === undefined) {
      logger.warn(
        'automode: no classifier configured (classifierFastProvider/classifierFastModel) — ' +
        'only trusted tools and allowlisted commands will run; every other call is denied.',
      )
    }
    logger.info(
      `auto-approval armed: ${resolved.deny.length} deny patterns (+${resolved.ask.length} legacy ask patterns, now deny), ` +
      `${resolved.autoApproveTools.size} auto-approve tools, ${resolved.bashCommandPrefixes.length} bash prefixes, ` +
      (resolved.classifier === undefined
        ? ', L1 disabled (fail-closed outside the allowlists)'
        : `, L1 fast=${resolved.classifier.fast.provider}/${resolved.classifier.fast.model}`),
    )
    auditArmed(ctx, {
      deny: resolved.deny.length,
      ask: resolved.ask.length,
      autoApproveTools: resolved.autoApproveTools.size,
      classifier: resolved.classifier === undefined
        ? 'disabled'
        : `${resolved.classifier.fast.provider}/${resolved.classifier.fast.model}`,
    })
  }

  let settingsAttached = false
  // settings 注册是服务方法（0.1.2 起）：旧的独立 helper `installSettingsSection`
  // 已移除。必须在 `ctx.inject(['settings'], ...)` 回调里调用——settings 由兄弟
  // fiber 提供，且 installSection 要求 owner 是消费者自己的 ctx。
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, NS, Config, config, {
      setSource: (source) => { current = source },
      // 拒绝无法执行的写（非法正则、不成对路由）：throw 使 update/replace 失败，
      // 运行中的实例保留上一份好配置。
      validate: (value) => { resolveConfig(value) },
      onChange: () => {
        settingsAttached = true
        resolved = resolveConfig(current())
        // 配置热更新：重建 tracker（denials 计数与 turn 状态重置）。
        tracker = new DenialTracker()
        arm()
      },
    })
  })

  // M3：L0 deny 注册为单调 guard——在所有 pre-execute listener 之后执行，
  // 只能 deny 不能 allow，其它 prepend 插件旁路不掉这条硬底线。guard 读
  // thunk，settings 热更新即时生效。ctx.tools 缺席（罕见：core 未加载
  // tools）时降级为只挂瀑布并告警。用 `ctx.get('tools')` 而非 `ctx.tools`：
  // tools 由 dsh-tools entry（兄弟 fiber）提供，per-fiber store 链找不到，
  // 只有全局 store（`ctx.get`）能解析。
  const tools = ctx.get('tools') as { guard: (guard: ToolGuard) => () => void } | undefined
  if (tools !== undefined) {
    // guard 同样按 preset 门控：只有 automode 会话走 L0 硬底线。
    tools.guard(createDenyGuard(exec => gated(exec.agent) ? resolved : undefined))
  } else {
    logger.warn('ctx.tools is not available; L0 deny guard NOT registered (pre-execute listener still active)')
  }

  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const { agent, callId } = callFacts(exec)
    if (!gated(agent)) return next()
    const text = extractMatchableText(exec.arguments)

    // ---- L0 deny（硬底线，最高优先级；escalation 豁免不适用） ----
    if (text !== undefined) {
      const hit = matchFirst(text, resolved.deny)
      if (hit !== undefined) {
        tracker.recordDenial(agent)
        const pattern = resolved.denySources[hit.index]
        logger.info(`deny ${exec.name} (${callId}): matched deny pattern /${pattern ?? '?'}/`)
        auditDecision(ctx, agent, {
          tool: exec.name, callId, stage: 'L0-deny', decision: 'deny',
          ...pattern === undefined ? {} : { pattern },
        })
        return { kind: 'deny', reason: DENY_REASON }
      }
    }

    // ---- L0 自毁护栏：终止宿主进程（node）的命令，硬底线 deny。 ----
    // kill <pid> 仅当目标是宿主 PID 时 deny；其它具体 PID 放行（逃生通道）。
    if (text !== undefined && resolved.selfKillGuard) {
      const selfKill = matchSelfKill(text)
      if (selfKill !== undefined && (selfKill.pid === undefined || selfKill.pid === process.pid)) {
        tracker.recordDenial(agent)
        logger.info(`deny ${exec.name} (${callId}): self-kill guard matched (host pid ${process.pid})`)
        auditDecision(ctx, agent, {
          tool: exec.name, callId, stage: 'L0-selfkill', decision: 'deny',
          ...selfKill.pid === undefined ? {} : { detail: `target pid ${selfKill.pid}` },
        })
        return { kind: 'deny', reason: selfKillDenyReason(process.pid) }
      }
    }

    // ---- L0 legacy ask（语义已并入 deny：askPatterns 命中即拒绝） ----
    if (text !== undefined) {
      const hit = matchFirst(text, resolved.ask)
      if (hit !== undefined) {
        const pattern = resolved.askSources[hit.index]
        logger.info(`deny ${exec.name} (${callId}): matched legacy ask pattern /${pattern ?? '?'}/ (ask now denies)`)
        auditDecision(ctx, agent, {
          tool: exec.name, callId, stage: 'L0-ask', decision: 'deny',
          ...pattern === undefined ? {} : { pattern },
        })
        return { kind: 'deny', reason: DENY_REASON }
      }
    }

    // ---- 只读工具白名单 / bash 命令前缀白名单 ----
    if (resolved.autoApproveTools.has(exec.name)
      || (exec.name === 'bash' && matchBashPrefix(text, resolved.bashCommandPrefixes))) {
      auditDecision(ctx, agent, { tool: exec.name, callId, stage: 'whitelist', decision: 'allow' })
      return next()
    }

    // ---- L1 LLM classifier（配置 fast 路由后启用） ----
    if (resolved.classifier !== undefined) {
      const llm = ctx.get('llm') as LlmLike | undefined
      const intent = latestUserIntent(agent)
      if (llm === undefined || intent === undefined) {
        const detail = llm === undefined ? 'no ctx.llm service' : 'no user message in session log'
        auditDecision(ctx, agent, { tool: exec.name, callId, stage: 'L1-fail-closed', decision: 'deny', detail })
        return { kind: 'deny', reason: L1_UNAVAILABLE_REASON }
      }
      const outcome = await classifyL1(llm, resolved.classifier, {
        intent,
        toolName: exec.name,
        args: exec.arguments as JsonValue,
        ...agent === undefined ? {} : { sessionId: agent.session.id },
        signal: exec.signal,
      })
      if (outcome.status === 'fail-closed') {
        logger.warn(`L1 ${outcome.stage} failed for ${exec.name} (${callId}): ${outcome.error}`)
        auditDecision(ctx, agent, { tool: exec.name, callId, stage: 'L1-fail-closed', decision: 'deny', detail: outcome.error })
        return { kind: 'deny', reason: L1_FAILED_REASON }
      }
      const stage: DecisionStage = outcome.stage
      if (outcome.status === 'deny') {
        tracker.recordDenial(agent)
        logger.info(`L1 deny ${exec.name} (${callId})${outcome.stage === 'L1-deep' ? `: ${outcome.rationale}` : ''}`)
        auditDecision(ctx, agent, {
          tool: exec.name, callId, stage, decision: 'deny', route: outcome.route,
          latencyMs: outcome.latencyMs,
          ...outcome.stage === 'L1-deep' ? { detail: outcome.rationale } : {},
        })
        return { kind: 'deny', reason: DENY_REASON }
      }
      auditDecision(ctx, agent, {
        tool: exec.name, callId, stage, decision: outcome.status, route: outcome.route,
        latencyMs: outcome.latencyMs,
        ...outcome.stage === 'L1-deep' ? { detail: outcome.rationale } : {},
      })
      // L1 只剩 allow/deny 两态：deny 已在上方返回，这里只剩 allow → 放行。
      return next()
    }

    // ---- 未配置 L1：fail-closed ----
    // automode 的定义是“全权限 + 分类器兜底”；没有分类器时若默认放行，这道
    // 闸门就成了橡皮图章（什么都放行却看起来在审）。所以白名单之外一律 deny，
    // 逼用户先配 `classifierFastProvider` / `classifierFastModel`。
    tracker.recordDenial(agent)
    auditDecision(ctx, agent, { tool: exec.name, callId, stage: 'L1-unconfigured', decision: 'deny' })
    return { kind: 'deny', reason: L1_UNCONFIGURED_REASON }
  }, { prepend: true })

  // settings 服务缺席（无 inject 回调）时，entry config 已在上面手动 resolve。
  if (!settingsAttached) arm()
}

export default apply
