# dsh-auto-approval

[English](README.md) | [中文](README.zh.md)

给 DeepSeek Harness 加**第四档权限**：在输入栏的权限下拉里选 **Automode**，会话就以完全权限运行，唯一的安全闸门是一个 LLM 分类器——它替你回答每一次判定，**不再弹审批**。

权限模型保持 3 + 1：官方三档沙箱，外加一档全托管。选其它 preset 即等于关掉本插件，没有第二个开关。

> **0.2.0 是对 0.1.x 的重写。** 开关从插件设置改成了权限 preset：装好、选 **Automode**，就完事。升级见 [从 0.1.x 升级](#从-01x-升级)。

## 演示

![Automode：多步任务无人值守跑完，被拒的调用出现在决策表里](docs/demo.gif)

录屏内容：选 **Automode**，发一条 prompt（建目录 → 写文件 → 读回确认 → 执行 `echo danger_test`）。文件那几步全程无人值守通过（`L1-deep` / `whitelist`），最后那条命令被硬规则拦下（`L0-deny`）；chip 弹窗同时显示两条判定和累计计数。

## 工作原理

```text
模型要调工具
        │
        ├─ preset ≠ automode ──────────────► 完全不接管（官方行为）
        │
        └─ preset = automode
                 │
                 ├─ L0 规则（硬底线）────────► deny   (rm -rf /、curl | sh、自毁命令 …)
                 ├─ 免检工具 / bash 前缀 ────► allow
                 └─ L1 分类器 ──────────────► allow | deny   （fail-closed：超时/解析失败/无模型 → deny）
```

- **L0** —— 正则 deny 规则 + 自毁护栏 + 免检工具/命令前缀白名单，确定性判定，不调模型。
- **L1** —— 拿「最近一条真实用户消息 + 裸工具调用」给两阶段分类器（fast 单 token 过滤 → 命中才走 deep CoT）。**分类器永远看不到工具输出**，所以被注入的内容没法把它骗成 allow。
- **fail-closed** —— 超时、解析失败、没有模型，一律 deny。

automode preset 写的是和「完全权限」同一组旋钮（完全权限 + 审批 `never`），所以其它通道也不会再问人；两者的区别就是本插件这道闸门。官方 preset 服务会记住最后选中的名字，所以下拉里能区分你选的是哪一档。

## 安装

```sh
dsh plugin --profile web add dsh-auto-approval
```

> **刚发新版？** pnpm 11 默认拒绝发布不足 24 小时的版本（`minimumReleaseAge`，供应链保护），所以发布当天 `add dsh-auto-approval` 会解析到**上一个版本**。要么装精确版本（`dsh plugin --profile web add dsh-auto-approval@0.2.0`），要么在 profile 的 `pnpm-workspace.yaml` 里加：
>
> ```yaml
> minimumReleaseAgeExclude:
>   - dsh-auto-approval
> ```

然后在输入栏旁的权限下拉里选 **Automode**（或 `/permission automode`）。第一次选会在浏览器里弹一次性提示，说明这档的取舍（官方那个「Enable Full access?」确认硬编码在 `danger-full-access` 键上，自定义 preset 不会触发）。之后预设选择器旁边会出现 `Auto` 胶囊：累计放行/拦截计数，点开是决策表。

源码方式：clone 后 `pnpm install && pnpm run build`，再 `dsh plugin --profile web add link:/<路径>`。

## 从 0.1.x 升级

0.2.0 保留了包名、`auto-approval:` 配置段和所有配置项，升级不需要改配置。变的是：

| | 0.1.x | 0.2.0 |
|---|---|---|
| 开关 | 插件设置 `enabled` + UI 里的 switch | **Automode** 权限 preset（没有第二个开关） |
| 包 | `dsh-auto-approval` + `dsh-client-ui-auto-approval` | `dsh-auto-approval`（host + 浏览器半边同一个包） |
| 沙箱 | 看当前 preset；DSH 自己的升级询问照旧弹给用户 | 完全权限 + 审批 `never`，完全不弹窗 |
| L1 未配置 | 全部放行（橡皮图章） | 白名单外一律拒绝 |

```sh
# 1. 卸掉旧的伴侣包（浏览器半边现在就在主包里）
dsh plugin --profile web remove dsh-client-ui-auto-approval

# 2. 升级
pnpm --dir "$DSH_HOME/profiles/web" up dsh-auto-approval

# 3. 重启 dsh，然后在权限下拉里选 Automode
```

如果 `settings.yaml` 里没配分类器（`classifierFastProvider` / `classifierFastModel`），automode 现在会 fail-closed——配上它，否则只有免检工具和白名单命令能跑。

## 配置

`$DSH_HOME/settings.yaml`，热重载：

```yaml
automode:
  denyPatterns:
    - 'rm\s+(-[a-z]*[fr][a-z]*\s+)*/\s*$'
    - 'curl\s+[^|]*\x7c\s*(ba)?sh'
  autoApproveTools: [read, write, edit, glob, grep, ls]
  bashCommandPrefixes: [ls, pwd, git status, git diff, pnpm test]
  classifierFastProvider: deepseek-official
  classifierFastModel: deepseek-v4-flash
  classifierDeepProvider: deepseek-official
  classifierDeepModel: deepseek-v4-pro
  classifierGuidance: '只读命令和跑测试优先放行。'
```

所有键都可选。`denyPatterns` / `autoApproveTools` / `bashCommandPrefixes` 是**整体替换**默认值（YAML 数组不合并），要保留的默认项得自己写全。

不配 `classifierFastProvider`/`classifierFastModel` 就没有 L1，此时 automode **fail-closed**：只有免检工具和白名单命令能跑，其余一律拒绝。这是故意的——没有分类器的会话不是安全兜底，默认放行只会让这道闸门变成橡皮图章。

## 权限与数据

| 面 | 本插件做什么 |
|---|---|
| 读 | 待判定的工具调用参数；session log（仅用于取最近一条真实用户消息作为分类器意图） |
| 写 | `$DSH_HOME/logs/automode.log`——本机 JSONL 审计文件，best-effort；写失败只记 warn |
| 网络 | 仅当配置了 L1：把用户消息 + 工具调用发给所配置的模型服务 |
| 执行 | 不执行任何东西。不起子进程、不走 shell、不改审计文件以外的文件 |
| 拦截 | `tools/pre-execute`（prepend）+ 单调 `ctx.tools.guard()` deny 守卫，两者都按会话 preset 门控 |
| 失败边界 | L1 超时 / 解析失败 / 无模型 → **deny**；配置非法在加载时 throw（fail-loud）；settings 服务缺失回退 composition entry 配置 |

## 兼容性

只跟官方最新版走。当前在 `@deepseek-ai/dsh` **0.1.2-rc.1** 上实测通过（一次性 `DSH_HOME`：安装 → 启动 → 真实 tool call 判定）。旧版本不保证。

bundle patch 会整体重述官方 preset 表，所以官方基础层新增 preset 时这个文件也要跟着更新。

## 开发

```sh
pnpm install
pnpm run typecheck
pnpm run test
pnpm run build     # lib/index.js（host）+ lib/client.js（browser）
```

## License

BSD-3-Clause
