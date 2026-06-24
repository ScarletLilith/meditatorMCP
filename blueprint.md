# Thinking Agent MCP — 项目蓝图

## 一、项目概述

构建一个 MCP（Model Context Protocol）Server，暴露一个 `chat_agent` 工具。该工具封装**非思考模型**（DeepSeek-V4-Flash），供**思考模型**在推理过程中调用，实现思维链的外包和延长。

### 核心设计理念：自包含任务描述

```
思考模型（主推理）
  └─ 构建完整的 input_text（包含所有上下文）
       └─ chat_agent 独立执行
            └─ 返回结果，思考模型整合
```

工具不依赖对话历史，所有上下文信息需由思考模型打包进 `input_text`。

### 核心价值

| 场景 | temperature | top_p | 用途 |
|------|:-----------:|:-----:|------|
| 精确校验 | 0.1-0.3 | 0.1-0.3 | 事实核查、数学计算验证 |
| 发散探索 | 0.8-1.5 | 0.8-1.0 | 多角度分析、创意生成 |
| 平衡推理 | 0.4-0.7 | 0.7-0.9 | 一般推理任务 |

---

## 二、架构设计

```
┌──────────────────────────────────────────────────────────────┐
│                   MCP Client (思考模型)                        │
│  DeepSeek-V4-Flash (thinking mode)                           │
│  - 深度推理                                                  │
│  - 构建自包含的 input_text 调用 chat_agent                     │
│  - 整合工具返回结果                                           │
└──────────────────────┬───────────────────────────────────────┘
                       │ stdio 通信 (MCP Protocol)
                       ▼
┌──────────────────────────────────────────────────────────────┐
│                    MCP Server (本项目)                         │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  chat_agent Tool                                       │  │
│  │  参数: {input_text, temperature, top_p,                │  │
│  │         max_tokens, stop}                              │  │
│  │  input_text 直接作为 user message 传递给非思考模型       │  │
│  └────────────┬───────────────────────────────────────────┘  │
│               │ HTTP Request                                  │
│               ▼                                               │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  SiliconFlow API (OpenAI Chat Completions 格式)        │  │
│  │  Model: deepseek-ai/DeepSeek-V4-Flash (non-thinking)   │  │
│  │  参数透传: temperature, top_p, max_tokens              │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### 关键设计：上下文隔离

```
V1（旧方案）：思考模型输出 "prompt: 分析架构设计"
              ↓ 工具模型看不到关键上下文
              ↑ 需要额外传 context 参数

V2（当前方案）：思考模型构建完整 input_text
               "推理：根据以下蓝图内容分析架构设计：[蓝图全文...]"
               ↓ 工具模型独立完成，不依赖外部
               ↑ 思考模型的输出只有工具参数（极少 tokens）
```

**Token 成本优势**：上下文在 `input_text` 中传递，消耗的是非思考模型的 **input tokens**（$0.14/1M），而非思考模型的 output tokens（$0.28/1M）。

### 数据流

1. **思考模型收到用户问题** → 开始深度推理，理解全局上下文
2. **思考模型决定调用 `chat_agent`** → 构建完整、自包含的 `input_text`
3. **MCP Server 接收请求** → 直接以 `input_text` 作为 user message 调用 API
4. **非思考模型独立执行** → 返回结果
5. **思考模型分析工具结果** → 继续推理或输出最终答案

---

## 三、参数设计

### chat_agent 工具参数

| 参数 | 类型 | 默认值 | 范围 | 说明 |
|------|------|--------|------|------|
| input_text | string | 必填 | - | **完整、自包含**的任务描述，包含所有上下文 |
| system_prompt | string | 可选 | - | 系统提示词，设定角色或行为约束。与 input_text 组装为 system + user messages |
| temperature | number | 0.7 | 0.0-2.0 | 采样温度 |
| top_p | number | 0.9 | 0.0-1.0 | 核采样 |
| max_tokens | number | 4096 | 1-384000 | 最大输出 token（API 级控制） |
| stop | string[] | ["\n\n"] | - | 停止序列。默认值防止非思考模型自动续写，思考模型可按需覆盖 |
| seed | number | 无 | - | 随机种子。配合低 temperature 实现输出复现，适合校验场景 |

### input_text 构建规范

思考模型需将 `input_text` 构建为 **自包含的任务描述**：

```
格式：
[任务类型]：[具体任务描述]，[必要的上下文信息]，[期望的输出格式/约束]

示例：
- 推理：已知 X=5, Y=12，请推导 Z=X²+Y² 的值，并给出计算步骤。
- 发散联想：列出10个与"深海"相关的隐喻，并简要说明每个隐喻的象征意义。
- 评估：根据以下方案内容，评估技术可行性... [方案内容...]
```

### system_prompt 使用建议

`system_prompt` 与 `input_text` 的关系类似传统 LLM 的 system + user 消息结构。

```
校验任务：system_prompt="你是一个严谨的数学校验员，只输出计算结果，不需要解释过程。"
          input_text="验证以下推导是否正确：[推导内容]"

发散任务：system_prompt="你是一个创意分析师，从尽可能多的角度思考问题。"
          input_text="列出10个与'深海'相关的隐喻..."
```

**设计理由**：区分"角色指令"和"任务内容"，让非思考模型更准确理解执行意图。

### 参数协同策略

```
校验模式:   temperature=0.1, top_p=0.1,  max_tokens=2048, seed=42
发散模式:   temperature=1.2, top_p=0.95, max_tokens=4096
平衡模式:   temperature=0.5, top_p=0.8,  max_tokens=4096
```

---

## 四、上下文爆炸控制

### 方案：API 级 max_tokens 控制 + 无状态设计

```
┌──────────────────────────────────────────────────────┐
│  Thinking Model（无 max_tokens 限制）                  │
│  - 自由思考，不限制输出长度                            │
│  - 调用 chat_agent 时只产出工具参数（少量 tokens）      │
└──────────────────────┬───────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────┐
│  chat_agent Tool（有 max_tokens 控制）                │
│  - 每次调用有明确的 max_tokens 限制                    │
│  - 通过 API 参数在服务端控制，非本地硬截断              │
│  - 每次调用独立（stateless），不产生上下文累积           │
└──────────────────────────────────────────────────────┘
```

**核心机制**：
- `input_text` 中包含完整上下文，但思考模型只需产出工具调用参数（极小）
- 非思考模型的输出由 `max_tokens` 控制，不会无限膨胀
- 上下文产生的 token 消耗在非思考模型侧（更便宜）

---

## 五、项目结构

```
mcp/
├── package.json           # 项目配置
├── tsconfig.json          # TypeScript 编译配置
├── .gitignore             # git 忽略规则
├── .env.example           # 环境变量模板
├── blueprint.md           # 本项目蓝图文档
├── .github/
│   └── workflows/
│       └── ci.yml         # CI 构建验证
├── src/
│   ├── polyfill.ts        # Node 14 fetch polyfill
│   ├── index.ts           # MCP Server 入口
│   ├── logger.ts          # 结构化日志工具
│   └── chatAgentTool.ts   # chat_agent 工具实现（含校验/重试/错误分类）
├── test/
│   ├── config.json        # API 配置（.gitignore 排除）
│   ├── testFramework.ts   # 交互式测试框架
│   ├── batchTest.ts       # 批量对比测试
│   ├── quickTest.ts       # 快速功能测试
│   └── thinkingTest.ts    # 思考模型工具测试
└── results/               # 测试结果（.gitignore 排除）
    ├── PROJECT_SUMMARY.md # 项目总结
    ├── with-tool-*.md     # 使用工具时的对话记录
    ├── without-tool-*.md  # 纯思考模型的对话记录
    └── comparison-*.md    # 对比分析
```

---

## 六、关键技术决策

### 6.1 为什么是 input_text 而非 prompt + system_message？

- **上下文隔离**：工具模型不依赖对话历史，避免"看不到上下文"的问题
- **Token 成本优化**：上下文消耗在便宜的 input tokens 侧
- **职责明确**：思考模型负责上下文打包，工具模型专注执行

### 6.2 为什么用 SiliconFlow 而非 DeepSeek 官方 API？

- 提供相同的 DeepSeek-V4-Flash 模型
- OpenAI 兼容接口，集成成本极低
- 原生支持 `top_p` 参数，满足参数控制需求

### 6.3 为什么思考模型不设 max_tokens？

- 思考模型的输出长度不可预测，复杂推理需要更多 token
- 取消 max_tokens 限制让模型可自由思考
- 上下文爆炸风险由 chat_agent 工具的 max_tokens 控制

### 6.4 死循环防护

- **Server 侧**：API 重试次数上限 3 次，仅在 429/5xx 时指数退避重试（1s→3s→7s）
- **Client 侧**：每轮对话工具调用上限 20 次（由测试框架控制）
- **网络错误不自动重试**：ENOTFOUND/ECONNREFUSED 等网络错误快速返回，由思考模型决策
- **无 API 超时**：AI 模型输出时间不可预测，不设读取超时，避免误杀正常请求

### 6.5 错误分类体系

工具返回结构化错误信息，包含 `type` 和 `action` 字段，帮助思考模型决策：

| 错误类型 | 触发条件 | action | 思考模型应对 |
|----------|----------|--------|-------------|
| `network` | DNS 解析失败、连接被拒绝、网络不可达 | `retry` | 稍后重试调用 |
| `api` | 429 限流 | `backoff` | 降低频率后重试 |
| `api` | 401 认证失败 | `report` | 直接报告用户 |
| `api` | 5xx 服务不可用 | `retry` | 可重试 |
| `validation` | input_text 为空 | `fix_input` | 重新构建 input_text |
| `config` | 未配置 API Key/Model | `report` | 报告配置缺失 |

### 6.6 输入参数运行时校验

工具内部在调用 API 前对参数做二次校验，弥补 Schema 校验的不足：

- `input_text` 为空 → 直接返回 validation 错误
- `input_text` > 10 万字符 → 截断至 10 万字符并记录警告
- `temperature` 钳制至 [0, 2]，`top_p` 钳制至 [0, 1]
- `max_tokens` 钳制至 [1, 384000]

### 6.7 结构化日志

每个工具调用生成唯一 `requestId`，日志贯穿整个请求生命周期：

```
[2026-06-24T12:00:00.000Z] [INFO] [req_abc123] chat_agent called  input_length=123
[2026-06-24T12:00:01.500Z] [WARN] [req_abc123] input_text truncated  original=120000 truncated=100000
[2026-06-24T12:00:05.200Z] [ERROR] [req_abc123] API call failed permanently  type=network action=retry
```

日志输出到 stderr，不影响 MCP stdio 通信。

---

## 七、测试策略

### 7.1 测试框架

`test/testFramework.ts` — 交互式 CLI 测试
`test/batchTest.ts` — 自动批量对比测试

- **模式 A（with-tool）**：思考模型可使用 `chat_agent`
- **模式 B（without-tool）**：纯思考模型
- 自动保存对话记录到 `results/` 目录

### 7.2 评估维度

| 维度 | 说明 |
|------|------|
| 工具调用质量 | input_text 是否完整自包含 |
| 参数选择 | temperature/top_p 是否合理 |
| 推理深度 | 工具是否有助于延长思维链 |
| Token 效率 | 工具调用带来的额外 token 成本 |

---

## 八、风险与局限

1. **input_text 构建质量**：依赖思考模型正确打包上下文，可能遗漏关键信息。输入校验可拦截空/超长情况，但无法校验内容完整性
2. **API 依赖**：工具可用性依赖 SiliconFlow API 的稳定性。错误分类 + 重试机制可缓解临时故障
3. **延迟增加**：工具调用引入额外的网络延迟。无 API 超时设计避免误杀正常请求
4. **成本**：额外的 API 调用增加 token 消耗。错误分类避免无效重试浪费 token
5. **配置复杂**：用户需自行配置 API Key 和模型 ID。.env.example 提供模板参考

---

## 九、后续扩展

1. **工具调用缓存**：相同 input_text + temperature 组合的缓存，减少重复 API 调用
2. **多 API 提供商支持**：允许配置多个 API 端点，主备切换
3. **工具调用批处理**：一次 API 请求执行多个子任务
4. **流式输出**：支持非思考模型的流式返回
5. **input_text 模板管理**：常用任务类型的预置模板
6. **Token 使用统计**：累计记录每次调用的 token 消耗，辅助成本控制
