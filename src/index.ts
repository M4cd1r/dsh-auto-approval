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
 * - Denial counting reads the `turnBoundary` projection (DSH 0.1.7 deprecated
 *   synchronous session history scans)
 * - L1 一切失败 fail-closed 转 deny，绝不默认放行
 *
 * @module dsh-auto-approval
 */

import { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the `loader/volatile-update` event declaration.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { PreToolDecision, ToolExecution, ToolGuard } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { describeClassifier, resolveConfig } from './config.ts'
import type { ConfigFields, ResolvedConfig } from './config.ts'
import { classifyL1 } from './classifier.ts'
import type { ClassifierOutcome, LlmLike } from './classifier.ts'
import { classifyJev } from './jev.ts'
import { createDenyGuard, DENY_REASON, extractMatchableText, matchBashPrefix, matchFirst, matchSelfKill, selfKillDenyReason } from './rules.ts'
import { audit, auditArmed, auditFileOnly } from './audit.ts'
import type { AutomodeDecisionEvent, DecisionStage } from './audit.ts'
import { AutomodeStatusService } from './remote.ts'
import type { HistoryReader, StatusReader } from './remote.ts'
import { isAutomode } from './preset.ts'
import { remoteManifest } from './remote-manifest.ts'
import { autoApprovalIntentProjection } from './projection.ts'
import { DenialTracker } from './tracker.ts'
import type { AgentLike } from './tracker.ts'
import { DecisionHistory } from './history.ts'

export const name = 'auto-approval'

/**
 * Legacy settings namespace alias. Since DSH 0.1.7 the Settings surface keys
 * one form per profile entry id (generated from this plugin's Config schema),
 * so nothing reads this constant anymore; it stays exported as a public API
 * for older companion code.
 */
export const NS = 'auto-approval'

export { Config } from './config.ts'

/** L1 不可用（无模型服务或无用户意图上下文）时 fail-closed 的 deny 文案。 */
const L1_UNAVAILABLE_REASON = 'automode: automatic classifier is unavailable; the call is denied.'

/** L1 判定失败（超时/解析失败）时 fail-closed 的 deny 文案。 */
const L1_FAILED_REASON = 'automode: automatic classifier failed; the call is denied.'

/** 未配置 L1 路由时的 deny 文案（fail-closed，避免橡皮图章）。 */
const L1_UNCONFIGURED_REASON = 'automode: no classifier is configured; only trusted tools and allowlisted commands may run. Configure classifierFastProvider/classifierFastModel to enable automode.'

/**
 * Read the latest real user message text (the L1 intent input) from the
 * `autoApprovalIntent` projection — DSH 0.1.7 deprecated synchronous session
 * history scans, so the fold unit in `projection.ts` replaces the old log
 * scan (same semantics: only `source.kind === 'user'` messages count, plugin
 * injections never authorize). Registry or key absent → undefined, and L1
 * fails closed exactly as before.
 */
function latestUserIntent(ctx: Context, agent: Agent | undefined): string | undefined {
  if (agent === undefined) return undefined
  const registry = ctx.get('sessionProjections') as SessionProjectionRegistry | undefined
  return registry?.stateOf(agent.session, 'autoApprovalIntent')?.intent ?? undefined
}

/** 一次调用的决策上下文：tracker/audit 共用的 agent 与 callId 提取。 */
function callFacts(exec: ToolExecution): { agent: Agent | undefined; callId: string } {
  return { agent: exec.agent, callId: String(exec.callId) }
}

/**
 * Plugin entry: mounts the `tools/pre-execute` waterfall (prepend runs first)
 * plus the monotonic L0 deny guard. Invalid configuration throws at load
 * (fail-loud, M1).
 *
 * **The switch is a permission preset, not a plugin setting**: the plugin only
 * takes over while the session runs the `automode` preset (the fourth entry
 * this bundle's patch adds to the official preset table); selecting any other
 * preset bypasses it entirely. The user-visible model stays 3 + 1: three
 * sandbox tiers plus one fully-managed tier.
 *
 * Since DSH 0.1.7 the configuration is the profile entry's `config` (edited in
 * Settings → Plugins, or by hand in `$DSH_HOME/profiles/web/cordis.patch.yml`):
 * the Host builds the form from this plugin's own Config schema (all fields
 * volatile), commits edits into the running references, and emits
 * `loader/volatile-update` — live, without a remount. Volatile fields reach
 * `apply` as refs; every event re-resolves the whole config, and an invalid
 * update (bad regex, unpaired route, out-of-range threshold) is rejected while
 * the last good config stays armed — access is never silently widened.
 */
export function apply(ctx: Context, config: ConfigFields = {}): void {
  let resolved: ResolvedConfig = resolveConfig(config)
  /** Reads the current turn from the `turnBoundary` projection (dsh-agent-loop's unit); undefined without it. */
  const readTurn = (agent: AgentLike): number | undefined => {
    const registry = ctx.get('sessionProjections') as SessionProjectionRegistry | undefined
    return registry?.stateOf(agent.session as Session, 'turnBoundary')?.lastTurn
  }
  let tracker = new DenialTracker(readTurn)
  const history = new DecisionHistory()
  const logger = ctx.logger('auto-approval')

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
        : describeClassifier(resolved.classifier),
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
        : `, L1 ${describeClassifier(resolved.classifier)}`),
    )
    auditArmed(ctx, {
      deny: resolved.deny.length,
      ask: resolved.ask.length,
      autoApproveTools: resolved.autoApproveTools.size,
      classifier: resolved.classifier === undefined
        ? 'disabled'
        : describeClassifier(resolved.classifier),
    })
  }

  // Register the intent fold unit when the registry service is present
  // (optional registration, dsh-schedule's pattern): the registration rides
  // the fiber as an effect, so no manual disposer bookkeeping beyond what
  // `register` returns.
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register(autoApprovalIntentProjection)
  })

  // DSH 0.1.7 volatile settings: the Host commits profile-entry config edits
  // into the running refs and emits `loader/volatile-update`. Re-resolve the
  // whole config (refs are the live source; the `paths` argument is ignored —
  // a full re-resolve is cheap). An invalid update (bad regex, unpaired route,
  // out-of-range threshold) is rejected here and the previous `resolved`/
  // armed state stays untouched — invalid config can never silently widen
  // access.
  ctx.on('loader/volatile-update', () => {
    try {
      const next = resolveConfig(config)
      resolved = next
      // Hot config update: rebuild the tracker (per-turn deny count and turn state reset).
      tracker = new DenialTracker(readTurn)
      arm()
    } catch (error: unknown) {
      logger.warn(`config update rejected, keeping the last good config: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  arm()

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

    // ---- L1 classifier（配置后启用；backend: 'llm' 两阶段文本判定 / 'jev' 类型化概率） ----
    if (resolved.classifier !== undefined) {
      const classifier = resolved.classifier
      const intent = latestUserIntent(ctx, agent)
      // jev backend 不依赖 ctx.llm（直连 HTTP）；llm backend 需要模型服务。
      const llm = classifier.backend === 'llm' ? ctx.get('llm') as LlmLike | undefined : undefined
      if (intent === undefined || (classifier.backend === 'llm' && llm === undefined)) {
        const detail = intent === undefined ? 'no user intent available (autoApprovalIntent projection absent or empty)' : 'no ctx.llm service'
        auditDecision(ctx, agent, { tool: exec.name, callId, stage: 'L1-fail-closed', decision: 'deny', detail })
        return { kind: 'deny', reason: L1_UNAVAILABLE_REASON }
      }
      const classifierInput = {
        intent,
        toolName: exec.name,
        args: exec.arguments as JsonValue,
        ...agent === undefined ? {} : { sessionId: agent.session.id },
        signal: exec.signal,
      }
      const outcome: ClassifierOutcome = classifier.backend === 'jev'
        ? await classifyJev({ fetch }, classifier, classifierInput)
        : await classifyL1(llm as LlmLike, classifier, classifierInput)
      if (outcome.status === 'fail-closed') {
        logger.warn(`L1 ${outcome.stage} failed for ${exec.name} (${callId}): ${outcome.error}`)
        auditDecision(ctx, agent, { tool: exec.name, callId, stage: 'L1-fail-closed', decision: 'deny', detail: outcome.error })
        return { kind: 'deny', reason: L1_FAILED_REASON }
      }
      const stage: DecisionStage = outcome.stage
      // jev 的审计元数据（原始信号 / usage.input_tokens / 实际 model 版本号）
      // 只进文件日志，不进 session 事件（避免 session 事件体积膨胀）。
      // apiKey 不在其中——它永不进任何日志。
      if (outcome.stage === 'L1-jev') {
        logger.info(`L1-jev ${outcome.status} ${exec.name} (${callId}): ${outcome.rationale} · model=${outcome.model} · input_tokens=${outcome.inputTokens ?? 'n/a'}`)
        auditFileOnly(ctx, 'jev', {
          tool: exec.name, callId, decision: outcome.status,
          signals: outcome.signals, model: outcome.model,
          ...outcome.inputTokens === undefined ? {} : { inputTokens: outcome.inputTokens },
        })
      }
      if (outcome.status === 'deny') {
        tracker.recordDenial(agent)
        logger.info(`L1 deny ${exec.name} (${callId})${'rationale' in outcome ? `: ${outcome.rationale}` : ''}`)
        auditDecision(ctx, agent, {
          tool: exec.name, callId, stage, decision: 'deny', route: outcome.route,
          latencyMs: outcome.latencyMs,
          ...'rationale' in outcome ? { detail: outcome.rationale } : {},
        })
        return { kind: 'deny', reason: DENY_REASON }
      }
      auditDecision(ctx, agent, {
        tool: exec.name, callId, stage, decision: outcome.status, route: outcome.route,
        latencyMs: outcome.latencyMs,
        ...'rationale' in outcome ? { detail: outcome.rationale } : {},
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
}

export default apply
