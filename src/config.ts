/**
 * 配置 schema 与 fail-loud 解析：schemastery 负责默认值，{@link resolveConfig}
 * 负责 schema 表达不了的校验（正则预编译、provider/model 成对、数值边界）。
 * 任何非法配置在插件加载时直接 throw，绝不在运行时静默降级（M1）。
 * @module dsh-auto-approval/config
 */

import z from '@deepseek-ai/schemastery'

/** 插件配置（全部可选，schemastery schema 提供默认值——上游惯例）。 */
export interface Config {
  /** 命中即 deny 的正则列表（硬规则，匹配 command/code 全文，区分大小写）。 */
  denyPatterns?: string[]
  /** 自毁护栏：拦截 killall/pkill/taskkill/Stop-Process 整类终止命令及 kill 宿主 PID。默认开。 */
  selfKillGuard?: boolean
  /**
   * 把每次决策写进 session 事件（`auto-approval/decision`）。默认关：
   * 08-12 final 起 session 读取对未声明事件类型 fail-closed（
   * `KNOWN_SESSION_EVENT_TYPES` 白名单，append() 无 ignorable 通道），
   * 写 session 事件会使该 session 重启后无法打开。文件审计日志
   * `~/.dsh/logs/auto-approval.log` 不受影响，始终记录。
   */
  auditSessionEvents?: boolean
  /** 命中即 ask 的正则列表（已删：全托管无人工，不确定的调用直接 deny）。
   *  字段保留以向后兼容旧配置，语义已并入 deny——命中即拒绝。 */
  askPatterns?: string[]
  /**
   * 直接放行的 tool name 白名单。文件类工具（只读 + 写入）免检：写入有
   * 独立审查（代码 review / 沙箱边界），AA 不重复检查。
   * 主要检查对象是 bash / run_code（L0 deny + L1）。
   */
  autoApproveTools?: string[]
  /**
   * bash 命令前缀白名单：`bash` tool 的命令以这些前缀开头且不含 shell 元字符
   * （`|` `>` `<` `;` `&` 反引号 `$(`）时直接放行，跳过 L1。
   * 白名单按 tool 名匹配，bash 子命令（ls/cat/pwd 等）无法被 autoApproveTools
   * 豁免，这是给只读 shell 命令的唯一免 L1 通道。
   */
  bashCommandPrefixes?: string[]
  /** L1 Stage 1（fast 过滤）的 provider；须与 classifierFastModel 成对。 */
  classifierFastProvider?: string
  /** L1 Stage 1（fast 过滤）的 model；设置后启用 L1。 */
  classifierFastModel?: string
  /** L1 Stage 2（CoT 深查）的 provider；缺省沿用 fast。 */
  classifierDeepProvider?: string
  /** L1 Stage 2（CoT 深查）的 model；缺省沿用 fast。 */
  classifierDeepModel?: string
  /** L1 单次模型调用 / HTTP 请求的超时（毫秒），超时 fail-closed 转 deny。两个 backend 共用。 */
  classifierTimeoutMs?: number
  /** 用户自定义判定准则，作为 guidance 注入 L1（llm：prompt；jev：主问题 instructions 的 advisory 段）。不是硬规则。 */
  classifierGuidance?: string
  /**
   * L1 判定 backend：`'llm'`（默认，ctx.llm 两阶段文本判定）或
   * `'jev'`（TypeSafe System One，一次 HTTP 请求返回类型化概率，阈值判定）。
   */
  classifierBackend?: 'llm' | 'jev'
  /**
   * Jev backend 的 API 密钥。缺省回退环境变量 `TYPESAFE_API_KEY`。
   * ⚠️ 写在这里会**明文落进 settings.yaml**——推荐用环境变量。
   */
  jevApiKey?: string
  /** Jev API 根地址；缺省回退 `TYPESAFE_BASE_URL`，再缺省 `https://api.typesafe.ai`。 */
  jevBaseUrl?: string
  /** Jev 模型名，默认 `jev-latest`（响应会带实际版本号，进文件日志）。 */
  jevModel?: string
  /** Jev 放行阈值：`clearly_safe` 概率 ≥ 此值才 allow。必须在开区间 (0,1)。默认 0.9。 */
  jevAllowThreshold?: number
}

/**
 * The profile row's Config schema (schemastery fills defaults before
 * construction). Since DSH 0.1.7 every field is `volatile()`: the Host serves
 * exactly these fields as the plugin's Settings form, commits edits into the
 * running activation's references, and emits `loader/volatile-update` without
 * remounting. Unannotated on purpose: `.volatile()` rewrites each field's
 * output into its reference form, which the plain `z<Config>` annotation
 * rejects (dsh-usage pattern).
 */
export const Config = z.object({
  denyPatterns: z.array(z.string()).default([
    // 系统级破坏性操作
    'rm\\s+(-[a-z]*[fr][a-z]*\\s+)*/\\s*$',
    'mkfs\\.', 'dd\\s+if=.*of=/dev/', '>\\s*/dev/[a-zA-Z]+',
    // 管道直灌 shell（供应链风险）。`|` 写成 `\x7c`：正则语义完全一致，
    // 但源码里不再出现“下载 | 执行”的字面链路，上架静态扫描器不会把这条
    // **防御规则**误报成插件自己的下载执行行为（且 bundler 不会把字符类折回 `|`）。
    'curl\\s+[^|]*\\x7c\\s*(ba)?sh',
    'wget\\s+[^|]*\\x7c\\s*(ba)?sh',
  ]).volatile(),
  askPatterns: z.array(z.string()).default([
    // 写工作区外的系统路径
    'sudo\\s',
    '\\/etc\\/',
    '\\/usr\\/',
    '\\/var\\/',
    '\\/Library\\/',
    '\\/System\\/',
    'git\\s+push\\s+--force',
    'git\\s+reset\\s+--hard',
    'git\\s+clean\\s+-[a-z]*[fd][a-z]*',
    'drop\\s+table',
    'DROP\\s+TABLE',
  ]).volatile(),
  autoApproveTools: z.array(z.string()).default([
    // 只读工具
    'read', 'read_image', 'grep', 'find', 'ls', 'list_files', 'glob', 'search_symbols',
    // 文件写入工具：写代码/改文件有独立审查（代码 review + 沙箱边界），AA 不重复检查
    'write', 'edit', 'str_replace_editor',
  ]).volatile(),
  selfKillGuard: z.boolean().default(true).volatile(),
  auditSessionEvents: z.boolean().default(false).volatile(),
  bashCommandPrefixes: z.array(z.string()).default([]).volatile(),
  classifierFastProvider: z.string().volatile(),
  classifierFastModel: z.string().volatile(),
  classifierDeepProvider: z.string().volatile(),
  classifierDeepModel: z.string().volatile(),
  classifierTimeoutMs: z.number().default(20_000).volatile(),
  classifierGuidance: z.string().volatile(),
  classifierBackend: z.union(['llm', 'jev']).default('llm').volatile(),
  jevApiKey: z.string().volatile(),
  jevBaseUrl: z.string().volatile(),
  jevModel: z.string().default('jev-latest').volatile(),
  jevAllowThreshold: z.number().default(0.9).volatile(),
})

/** One volatile field reference the Host hands to an activation (dsh-usage pattern). */
export interface ConfigRef<T> {
  get(): T | undefined
}

/** A config field as the activation sees it: a live reference, a plain value, or absent. */
export type ConfigField<T> = ConfigRef<T> | T | undefined

/**
 * The activation's raw config fields: every field is optional and may arrive
 * as the live volatile reference the Host commits profile-entry edits into.
 * Field-by-field semantics are documented on {@link Config} above; this shape
 * only widens each field with the reference union.
 */
export interface ConfigFields {
  denyPatterns?: ConfigField<string[]>
  selfKillGuard?: ConfigField<boolean>
  auditSessionEvents?: ConfigField<boolean>
  askPatterns?: ConfigField<string[]>
  autoApproveTools?: ConfigField<string[]>
  bashCommandPrefixes?: ConfigField<string[]>
  classifierFastProvider?: ConfigField<string>
  classifierFastModel?: ConfigField<string>
  classifierDeepProvider?: ConfigField<string>
  classifierDeepModel?: ConfigField<string>
  classifierTimeoutMs?: ConfigField<number>
  classifierGuidance?: ConfigField<string>
  classifierBackend?: ConfigField<'llm' | 'jev'>
  jevApiKey?: ConfigField<string>
  jevBaseUrl?: ConfigField<string>
  jevModel?: ConfigField<string>
  jevAllowThreshold?: ConfigField<number>
}

/**
 * Read one activation field: a volatile ref goes through `get()`, a plain
 * value passes through, and an absent/undefined/null field falls back to the
 * schema default (the schema fills it in the next step).
 */
function readField<T>(field: ConfigField<T>): T | undefined {
  if (field === undefined || field === null) return undefined
  const ref = field as { get?: () => T | undefined }
  const value = typeof ref.get === 'function' ? ref.get() : (field as T)
  return value === undefined || value === null ? undefined : value
}

/** Materialize volatile refs into the plain shape the schema expects (absent keys keep schema defaults). */
function materialize(fields: ConfigFields): Record<string, unknown> {
  const plain: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(fields)) {
    const value = readField(field as ConfigField<unknown>)
    if (value !== undefined) plain[key] = value
  }
  return plain
}

/** 一个具体的模型路由（ctx.llm 要求 provider + model 成对）。 */
export interface ModelRoute {
  readonly provider: string
  readonly model: string
}

/** L1 classifier 的解析后配置：llm backend（ctx.llm 两阶段文本判定）。 */
export interface ResolvedLlmClassifierConfig {
  readonly backend: 'llm'
  /** Stage 1 fast 单 token 过滤。 */
  readonly fast: ModelRoute
  /** Stage 2 CoT 深查（缺省与 fast 相同）。 */
  readonly deep: ModelRoute
  /** 单次模型调用超时（毫秒）。 */
  readonly timeoutMs: number
  /** 用户 guidance 文本（注入 prompt，非硬规则）。 */
  readonly guidance?: string
}

/**
 * L1 classifier 的解析后配置：jev backend（TypeSafe System One）。
 * `route` 复用 ModelRoute 形态（provider 固定 `'typesafe'`），审计事件的
 * route 字段直接复用。**apiKey 永不进日志 / 审计 / deny reason。**
 */
export interface ResolvedJevConfig {
  readonly backend: 'jev'
  /** 审计口径的路由：`{ provider: 'typesafe', model: jevModel }`。 */
  readonly route: ModelRoute
  /** API 密钥（jevApiKey 配置优先于 TYPESAFE_API_KEY 环境变量）。 */
  readonly apiKey: string
  /** API 根地址（jevBaseUrl 配置优先于 TYPESAFE_BASE_URL 环境变量）。 */
  readonly baseUrl: string
  /** 单次 HTTP 请求超时（毫秒），复用 classifierTimeoutMs。 */
  readonly timeoutMs: number
  /** 放行阈值：clearly_safe ≥ 此值才 allow，开区间 (0,1)。 */
  readonly allowThreshold: number
  /** 用户 guidance 文本（并入主问题 instructions 的 advisory 段，非硬规则）。 */
  readonly guidance?: string
}

/** L1 classifier 的解析后配置（按 backend 区分）。 */
export type ResolvedClassifierConfig = ResolvedLlmClassifierConfig | ResolvedJevConfig

/** 人类可读的 classifier 描述（arm 日志 / remote status 共用）。 */
export function describeClassifier(config: ResolvedClassifierConfig): string {
  return config.backend === 'llm'
    ? `${config.fast.provider}/${config.fast.model}`
    : `${config.route.provider}/${config.route.model}`
}

/**
 * apply() 实际使用的解析后配置：正则已预编译（M1）、路由已成对校验、
 * 白名单已 Set 化。命中的 pattern 原文保留在 {@link denySources} /
 * {@link askSources}（与编译结果同序），只进审计与日志，不进 deny/ask 的
 * reason（M2）。
 */
export interface ResolvedConfig {
  readonly deny: readonly RegExp[]
  readonly denySources: readonly string[]
  readonly ask: readonly RegExp[]
  readonly askSources: readonly string[]
  readonly autoApproveTools: ReadonlySet<string>
  /** bash 命令前缀白名单（前缀匹配 + 无 shell 元字符校验）。 */
  readonly bashCommandPrefixes: readonly string[]
  /** 自毁护栏（拦截终止宿主进程的命令），默认开。 */
  readonly selfKillGuard: boolean
  /** session 事件审计写入开关（默认关——08-12 final 起写 session 事件会使日志无法打开）。 */
  readonly auditSessionEvents: boolean
  /** 未配置 fast 路由时为 undefined（L1 关闭，L0 未命中即 allow）。 */
  readonly classifier?: ResolvedClassifierConfig
}

/** 预编译一组正则；任一非法即 throw（fail-loud，M1）。 */
function compilePatterns(kind: string, patterns: readonly string[]): RegExp[] {
  return patterns.map((source) => {
    try {
      return new RegExp(source)
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`automode: invalid ${kind} pattern ${JSON.stringify(source)}: ${detail}`)
    }
  })
}

/** 校验一对 provider/model 配置：要么都给且非空，要么都不给。 */
function resolveRoute(
  label: string,
  provider: string | undefined,
  model: string | undefined,
): ModelRoute | undefined {
  if (provider === undefined && model === undefined) return undefined
  if (provider === undefined || model === undefined
    || provider.length === 0 || model.length === 0) {
    throw new Error(`automode: ${label} provider and model must be supplied together as non-empty strings`)
  }
  return { provider, model }
}

/**
 * Resolve and validate the configuration. Volatile refs are materialized into
 * plain values first (a ref reads `get()`; undefined/null falls back to the
 * schema default), the schema fills the remaining defaults, and the checks the
 * schema cannot express run last; any violation throws (a plugin that fails to
 * load beats silently degrading at runtime). Plain-value callers (every
 * existing test) keep their previous behavior.
 *
 * Managed-mode semantics: `askPatterns` is kept only for old-config
 * compatibility, but a hit is a **deny** — this plugin is fully managed with
 * no human hand-off, so an uncertain call is rejected instead of escalated.
 * `ask` is synonymous with deny in the resolved config; the list stays
 * separate only so the audit can distinguish the source.
 * @param config - Raw configuration from the Loader or tests (volatile fields arrive as refs).
 * @returns The immutable resolved configuration.
 */
export function resolveConfig(config: ConfigFields = {}): ResolvedConfig {
  // Materialize in two passes: first the caller's volatile refs to plain
  // values, then — because a volatile schema returns every field as a ref
  // (absent keys reference the schema default) — a second pass yields the
  // plain object. The cast keeps the existing "schema defaults + ?? narrows"
  // convention, just centralized in one place.
  const withDefaults = Config(materialize(config)) as unknown as ConfigFields
  const resolved = materialize(withDefaults) as unknown as Config & {
    enabled: boolean
    denyPatterns: string[]
    askPatterns: string[]
    autoApproveTools: string[]
    bashCommandPrefixes: string[]
    classifierTimeoutMs: number
    classifierBackend: 'llm' | 'jev'
    jevModel: string
    jevAllowThreshold: number
    selfKillGuard: boolean
    auditSessionEvents: boolean
  }
  const deny = compilePatterns('deny', resolved.denyPatterns)
  const ask = compilePatterns('ask', resolved.askPatterns)
  if (!Number.isFinite(resolved.classifierTimeoutMs) || resolved.classifierTimeoutMs <= 0) {
    throw new Error('automode: classifierTimeoutMs must be a positive finite number')
  }
  const fast = resolveRoute('classifierFast', resolved.classifierFastProvider, resolved.classifierFastModel)
  const deep = resolveRoute('classifierDeep', resolved.classifierDeepProvider, resolved.classifierDeepModel)
  if (resolved.classifierBackend === 'jev') {
    // 两个 backend 同时配置是歧义：静默忽略一边会让用户以为生效的
    // 配置实际没生效，fail-loud 直接拒绝（M1）。
    if (fast !== undefined || deep !== undefined) {
      throw new Error('automode: classifierBackend \'jev\' cannot be combined with classifierFast/classifierDeep (llm routing); remove one side')
    }
    const apiKey = resolved.jevApiKey ?? process.env.TYPESAFE_API_KEY
    if (apiKey === undefined || apiKey.length === 0) {
      throw new Error('automode: classifierBackend \'jev\' requires an API key: set jevApiKey or the TYPESAFE_API_KEY environment variable')
    }
    if (!Number.isFinite(resolved.jevAllowThreshold)
      || resolved.jevAllowThreshold <= 0 || resolved.jevAllowThreshold >= 1) {
      throw new Error('automode: jevAllowThreshold must be a finite number in the open interval (0, 1)')
    }
    const baseUrl = resolved.jevBaseUrl ?? process.env.TYPESAFE_BASE_URL ?? 'https://api.typesafe.ai'
    return {
      deny,
      denySources: resolved.denyPatterns,
      ask,
      askSources: resolved.askPatterns,
      autoApproveTools: new Set(resolved.autoApproveTools),
      bashCommandPrefixes: resolved.bashCommandPrefixes,
      selfKillGuard: resolved.selfKillGuard,
      auditSessionEvents: resolved.auditSessionEvents,
      classifier: {
        backend: 'jev',
        route: { provider: 'typesafe', model: resolved.jevModel },
        apiKey,
        baseUrl,
        timeoutMs: resolved.classifierTimeoutMs,
        allowThreshold: resolved.jevAllowThreshold,
        ...resolved.classifierGuidance === undefined ? {} : { guidance: resolved.classifierGuidance },
      },
    }
  }
  if (deep !== undefined && fast === undefined) {
    throw new Error('automode: classifierDeep requires classifierFast (Stage 1 always runs before Stage 2)')
  }
  return {
    deny,
    denySources: resolved.denyPatterns,
    ask,
    askSources: resolved.askPatterns,
    autoApproveTools: new Set(resolved.autoApproveTools),
    bashCommandPrefixes: resolved.bashCommandPrefixes,
    selfKillGuard: resolved.selfKillGuard,
    auditSessionEvents: resolved.auditSessionEvents,
    ...fast === undefined ? {} : {
      classifier: {
        backend: 'llm' as const,
        fast,
        deep: deep ?? fast,
        timeoutMs: resolved.classifierTimeoutMs,
        ...resolved.classifierGuidance === undefined ? {} : { guidance: resolved.classifierGuidance },
      },
    },
  }
}
