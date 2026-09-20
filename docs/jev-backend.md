# Automode 决策流水线（含 Jev backend）

> 与 `src/` 实现的对应关系：preset 门控与 L0 在 `index.ts` / `rules.ts`，
> 帧化在 `frame.ts`，两个 backend 分别在 `classifier.ts`（llm）与
> `jev.ts`（jev），审计在 `audit.ts`。

```mermaid
flowchart TD
    A["tool call 进入<br/>tools/pre-execute（prepend 最先跑）"] --> B{"会话是 automode preset？"}
    B -- "否" --> Z["next()<br/>完全旁路，走官方三档沙箱"]
    B -- "是" --> C{"L0 deny 正则<br/>（硬底线，另有 guard 单调兜底）"}
    C -- "命中" --> DENY["deny<br/>通用文案，pattern 只进审计"]
    C -- "未命中" --> D{"L0 自毁护栏<br/>killall/pkill/kill 宿主PID"}
    D -- "命中" --> DENY
    D -- "未命中" --> E{"legacy ask 正则<br/>（语义已并入 deny）"}
    E -- "命中" --> DENY
    E -- "未命中" --> F{"白名单？<br/>autoApproveTools / bash 前缀"}
    F -- "命中" --> ALLOW["allow → next()"]
    F -- "未命中" --> G{"最近一条真实用户消息存在？"}
    G -- "无" --> FC["fail-closed deny<br/>L1-fail-closed"]
    G -- "有" --> H["frameCall 帧化<br/>用户消息+tool名+参数JSON<br/>截断 4000/8000 字 · 注入防线唯一真源"]
    H --> I{"classifierBackend"}

    subgraph LLM["backend = 'llm'（默认，行为不变）"]
        M1["Stage 1 · fast 模型<br/>单 token：0=明显安全"] --> M2{"首字符是 0？"}
        M2 -- "是" --> M3["allow · stage=L1-fast"]
        M2 -- "否 / 解析失败" --> M4["Stage 2 · deep 模型<br/>CoT + 末行 VERDICT: ALLOW/DENY"]
        M4 --> M5{"VERDICT 提取成功？"}
        M5 -- "ALLOW" --> M6["allow · stage=L1-deep · rationale 进审计"]
        M5 -- "DENY" --> M7["deny · stage=L1-deep · rationale 进审计"]
        M5 -- "失败" --> M8["fail-closed deny"]
        M1 -. "超时/异常" .-> M8
        M4 -. "超时/异常" .-> M8
    end

    subgraph JEV["backend = 'jev'"]
        N1["一次 POST api.typesafe.ai/v1/systemone<br/>state = frameCall 输出 · 同帧五问"] --> N2{"响应严格校验<br/>2xx · JSON · clearly_safe 是 noul · ∈[0,1]"}
        N2 -- "失败（401/422/429/529/超时，不重试）" --> N5["fail-closed deny"]
        N2 -- "通过" --> N3{"clearly_safe ≥ jevAllowThreshold（默认 0.9）？"}
        N3 -- "是" --> N4["allow · stage=L1-jev"]
        N3 -- "否" --> N6["deny · stage=L1-jev<br/>rationale = 信号数字摘要"]
        N1 -.-> R["只记录不拦的四个信号<br/>destructive · exfiltration · beyond_scope · impact<br/>攒 30-50 条真实分布再决定是否升格为闸门"]
    end

    I -- "llm" --> LLM
    I -- "jev" --> JEV

    M3 --> ALLOW
    M6 --> ALLOW
    N4 --> ALLOW
    M7 --> DENY
    M8 --> DENY
    N5 --> DENY
    N6 --> DENY

    DENY --> LOG["审计：~/.dsh/logs/auto-approval.log 始终写<br/>session 事件默认关<br/>jev 另记 5 信号数值 + usage.input_tokens + 实际 model 版本"]
    ALLOW --> LOG
    FC --> LOG
```

读图要点：

- **分水岭在 `classifierBackend`**：preset 门控、L0、白名单、意图提取、frameCall
  两条 backend 完全共享，改动半径只在 L1 内部。
- **jev 分支没有 Stage 1/2**：一次请求替代两次模型调用，判定从"解析文本"
  退化为"比较一个数"。
- **五个问题同帧发出**，四个辅助信号只进日志、不参与判定（虚线旁路）。
- **所有失败路径都收口到 deny**：图里不存在任何"出错 → 放行"的边。
