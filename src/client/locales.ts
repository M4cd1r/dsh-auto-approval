/**
 * `automode` locale namespace dictionaries for the status chip.
 *
 * The framework injects a `t` seat into the chip's props when its slot
 * registration declares `locale: 'automode'` (see `./index.ts`), and the
 * browser follows the DSH locale preference — no plugin-side language switch.
 * `zh` is the key-set source of truth; `en` is checked complete against it.
 */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'chip.label': 'Auto',
  'chip.loading': 'Automode：加载中…',
  'chip.error': 'Automode：{message}',
  'chip.counts': '✓ 已放行 {approved} 次 · ✗ 已拦截 {denied} 次',
  'dialog.title': 'Automode',
  'dialog.close': '关闭',
  'ack.title': 'Automode 已开启',
  'ack.body': '这个会话运行在完全权限上，每次工具调用都由分类器判定，不再弹审批。如果没配置审查模型（classifierFastProvider / classifierFastModel），只有免检工具和白名单命令能跑，其余一律拒绝。',
  'ack.confirm': '我知道了',
  'dialog.loading': '正在读取 automode 状态…',
  'dialog.unavailable': '状态不可用：{message}',
  'config.safetyRules': '安全规则',
  'config.reviewModel': '审查模型',
  'config.trustedTools': '免检工具',
  'config.off': '未启用',
  'stat.approved': '已放行',
  'stat.denied': '已拦截',
  'history.title': '最近决策',
  'history.count': '显示 {count} 条 · 最新在前',
  'history.empty': '本会话还没有 automode 决策记录。',
  'table.time': '时间',
  'table.tool': '工具',
  'table.stage': '阶段',
  'table.verdict': '判定',
  'table.detail': '详情',
  'verdict.allow': '允许',
  'verdict.deny': '拒绝',
} satisfies Record<string, string>

/** The `automode` namespace key union. */
export type AutomodeKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'chip.label': 'Auto',
  'chip.loading': 'Automode: loading…',
  'chip.error': 'Automode: {message}',
  'chip.counts': '✓ {approved} approved · ✗ {denied} denied',
  'dialog.title': 'Automode',
  'dialog.close': 'Close',
  'ack.title': 'Automode is on',
  'ack.body': 'This session runs on full access; every tool call is decided by the classifier, with no approval prompts. Without a review model configured (classifierFastProvider / classifierFastModel), only trusted tools and allowlisted commands run — everything else is denied.',
  'ack.confirm': 'Got it',
  'dialog.loading': 'Loading automode status…',
  'dialog.unavailable': 'Status unavailable: {message}',
  'config.safetyRules': 'Safety rules',
  'config.reviewModel': 'Review model',
  'config.trustedTools': 'Trusted tools',
  'config.off': 'off',
  'stat.approved': 'Approved',
  'stat.denied': 'Denied',
  'history.title': 'Recent decisions',
  'history.count': '{count} shown · newest first',
  'history.empty': 'No automode decisions recorded for this session yet.',
  'table.time': 'Time',
  'table.tool': 'Tool',
  'table.stage': 'Stage',
  'table.verdict': 'Verdict',
  'table.detail': 'Detail',
  'verdict.allow': 'allow',
  'verdict.deny': 'deny',
} satisfies Record<AutomodeKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The automode chip's copy. */
    'automode': AutomodeKey
  }
}
