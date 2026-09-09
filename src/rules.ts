/**
 * L0 规则引擎：预编译正则的匹配原语、tool call 的文本提取，以及单调
 * deny guard（M3）的纯逻辑。全部同步、无状态，便于单测。
 * @module dsh-auto-approval/rules
 */

import type { ToolExecution, ToolGuard } from '@deepseek-ai/dsh-tools'
import type { ResolvedConfig } from './config.ts'

/**
 * 一次命中：命中的正则下标（对应 ResolvedConfig.*Sources 取原文）。
 * pattern 原文只进审计/日志，不进返回给模型的 reason（M2）。
 */
export interface PatternHit {
  readonly index: number
}

/** 返回第一个命中的正则下标，未命中返回 undefined。 */
export function matchFirst(text: string, patterns: readonly RegExp[]): PatternHit | undefined {
  for (let index = 0; index < patterns.length; index++) {
    const pattern = patterns[index]
    if (pattern !== undefined && pattern.test(text)) return { index }
  }
  return undefined
}

/**
 * 提取 tool call 里要做规则匹配的文本：bash 类的 `command`，或 Code Mode
 * `run_code` 的 `code`。其它参数形态不做 L0 匹配（交给 L1 / 人工）。
 * `ToolExecution.arguments` 是 unknown，必须显式收窄。
 */
export function extractMatchableText(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const record = args as Record<string, unknown>
  if (typeof record.command === 'string') return record.command
  if (typeof record.code === 'string') return record.code
  return undefined
}

/**
 * bash 命令前缀白名单：command 以任一前缀开头且不含 shell 元字符时放行。
 * 元字符排除是安全底线——`ls | rm`、`ls > f`、`ls; rm`、`$(...)` 都不是
 * 纯只读调用，即使前缀匹配也拒绝。前缀要求词边界（`less` 不会命中 `ls`）。
 */
const SHELL_META = /[|<>;&`$\n]/

export function matchBashPrefix(command: string | undefined, prefixes: readonly string[]): boolean {
  if (command === undefined || prefixes.length === 0) return false
  if (SHELL_META.test(command)) return false
  const trimmed = command.trim()
  return prefixes.some(prefix => {
    const candidate = prefix.trim()
    if (candidate.length === 0) return false
    return trimmed === candidate || trimmed.startsWith(`${candidate} `)
  })
}

/**
 * 进程自毁护栏的匹配原语：识别会终止宿主进程（node）的进程终止命令。
 * 纯正则做不了「目标 == 当前进程」的判断，所以 kill 类命令只提取 PID，
 * 由调用方与 `process.pid` 比较决定（逃生通道：非宿主 PID 放行）。
 * 匹配覆盖 Unix/Windows 两侧常见写法，大小写不敏感（Windows 命令语义）。
 *
 * 整类命中（不带 node 目标限定）：killall/pkill/taskkill/Stop-Process 的目标
 * 不可控——pkill -f 匹配完整命令行、killall 匹配进程名，宿主命令行
 * （node apps/cli/lib/bin.js ...）可被 `pkill -f dsh`/`pkill -f automode`
 * 等模式绕过 node 名过滤直击；且这类命令一旦出错波及面不可预测。
 * 一律 deny，清理遗留进程走逃生通道 `kill <pid>`（非宿主 PID 放行）。
 * 命令边界 `(?:^|[;&|]\s+)` 防 `echo killall node` 这类字符串误报。
 */
const KILLALL = /(?:^|[;&|]\s+)killall(?:\s|$)/i
const PKILL = /(?:^|[;&|]\s+)pkill(?:\s|$)/i
const TASKKILL = /(?:^|[;&|]\s+)taskkill(?:\s|$)/i
const STOPPROC = /(?:^|[;&|]\s+)stop-process(?:\s|$)/i
const KILL_PID = /kill\s+(?:-\S+(?:\s+\S+)?\s+)*(\d+)\b/

/** 一次自毁命中的结果。 */
export interface SelfKillMatch {
  /** kill 类命令中显式出现的目标 PID；整类终止命令（killall/pkill/taskkill/Stop-Process）无此字段。 */
  readonly pid?: number
}

/**
 * 识别进程终止命令：
 * - `killall node` / `pkill -f anything` / `taskkill /IM nginx.exe` / `Stop-Process -Name python`
 *   整类命中（目标不可控，含宿主）——返回空对象
 * - `kill <pid>` 只返回 pid，由调用方与宿主 PID 比较（逃生通道）
 * - 其它命令返回 undefined
 */
export function matchSelfKill(command: string): SelfKillMatch | undefined {
  if (KILLALL.test(command) || PKILL.test(command)
    || TASKKILL.test(command) || STOPPROC.test(command)) {
    return {}
  }
  const pid = KILL_PID.exec(command)
  if (pid !== null) return { pid: Number(pid[1]) }
  return undefined
}

/** 自毁护栏的 deny 文案：注入宿主 PID，给「清理遗留进程」留一条逃生路。 */
export function selfKillDenyReason(hostPid: number): string {
  return (
    'automode: this call was denied by the automode security policy because it would ' +
    `terminate processes by name or pattern, which can include the DSH host process (pid ${hostPid}). ` +
    'Do not retry it or attempt an alternative. ' +
    `If you meant to reclaim resources from leftover processes, kill a specific PID other than ${hostPid}. ` +
    'Report the denial to the user and ask how to proceed.'
  )
}

/** deny 返回给模型的通用文案：不含命中规则（M2），但把模型行为收窄成确定动作。
 * 旧文案「choose a safer alternative or ask」是开放决策——v4-flash 面对"为什么被拒
 * （不可知）+ 替代方案（可能不存在）"会陷入长时间 reasoning；改为直接报告+询问，
 * 模型无需自行规划。
 *
 * 全托管模式下无 ask 路径：不确定的调用统一 deny（含原 L0-askPatterns 命中、
 * L1 判定 ASK、fail-closed），模型报告结果即可，无人介入。 */
export const DENY_REASON =
  'automode: this call was denied by the automode security policy. ' +
  'Do not retry it or attempt an alternative. Report the denial to the user and ask how to proceed.'

/**
 * M3：由 L0 deny 规则构造单调 guard。guard 在所有 `tools/pre-execute`
 * listener 之后、tool body 之前执行，只能 deny 不能 allow——即使另一个
 * prepend 插件把我们的瀑布 listener 旁路掉，L0 硬底线依然生效。
 * @param getConfig - 每次调用重读的配置 thunk；返回 undefined 表示本次调用
 *   不在 automode preset 下，guard 直接放行。
 * @returns 可直接传给 `ctx.tools.guard()` 的同步 guard。
 */
export function createDenyGuard(
  getConfig: (execution: Readonly<ToolExecution>) => ResolvedConfig | undefined,
): ToolGuard {
  return (execution: Readonly<ToolExecution>): string | undefined => {
    const config = getConfig(execution)
    if (config === undefined) return undefined
    const text = extractMatchableText(execution.arguments)
    if (text === undefined) return undefined
    if (matchFirst(text, config.deny) !== undefined) return DENY_REASON
    if (config.selfKillGuard) {
      const selfKill = matchSelfKill(text)
      if (selfKill !== undefined && (selfKill.pid === undefined || selfKill.pid === process.pid)) {
        return selfKillDenyReason(process.pid)
      }
    }
    return undefined
  }
}
