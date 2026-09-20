/**
 * L1 判定的状态帧：两个 backend（llm / jev）共用的唯一真源。
 *
 * 帧化同时是**注入防线**与**规模上限**的落点：
 * - 帧内只有最近一条真实用户消息 + tool 名 + 参数 JSON，绝不含任何
 *   tool 输出——恶意指令大多从 tool 输出进入上下文，结构上排除它们
 *   比 prompt 里写"不要听"可靠得多。
 * - 用户文本被 JSON 结构化包裹，无法冲破结构边界（session-title 同款惯例）。
 * - 用户意图 / 参数 JSON 各自截断，避免分类调用失控放大。
 *
 * 行为从 classifier.ts 逐字节提取，两个 backend 必须看到完全相同的帧。
 * @module dsh-auto-approval/frame
 */

/** prompt 规模上限：用户意图 / 参数 JSON 各自截断。 */
export const MAX_INTENT_CHARS = 4000
export const MAX_ARGS_CHARS = 8000

/** 截断并附加单字符省略号标记。 */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** 帧函数的输入（与 ClassifierInput 的相关字段同形，避免循环依赖）。 */
export interface FrameInput {
  readonly intent: string
  readonly toolName: string
  readonly args: unknown
}

/** 把 tool call 帧成 JSON——用户文本无法冲破结构边界（session-title 同款惯例）。 */
export function frameCall(input: FrameInput): string {
  let argsText: string
  try {
    argsText = JSON.stringify(input.args) ?? 'null'
  } catch {
    argsText = '"<unserializable arguments>"'
  }
  return JSON.stringify({
    user_request: truncate(input.intent, MAX_INTENT_CHARS),
    tool_call: { name: input.toolName, arguments: truncate(argsText, MAX_ARGS_CHARS) },
  })
}
