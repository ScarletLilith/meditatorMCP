# Thinking Agent MCP

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178C6?logo=typescript)](package.json)
[![MCP](https://img.shields.io/badge/MCP-Server-8A2BE2)](https://modelcontextprotocol.io)

**通过 MCP 工具扩展思考模型的思维链** — 一个 Model Context Protocol 服务器，暴露 `chat_agent`、`create_branch`、`get_branch_details` 三个工具，让思考模型可以将子任务外包给非思考模型执行，并构建树形多角度分析。

---

## 功能特性

- **🧠 思维链延长** — 思考模型通过 `chat_agent` 将推理子任务委托给非思考模型，突破单模型输出 token 限制
- **🌳 树形思维** — `create_branch` 支持递归嵌套分支，四种类型（深入/验证/发散/备忘）实现多角度深度分析
- **🔍 全流程可追溯** — `get_branch_details` 可回溯任意分支节点的完整原始推理过程
- **🛡️ 上下文隔离** — 工具为无状态设计，所有上下文需打包进 `input_text`，不依赖对话历史
- **🎛️ 参数精细控制** — 通过 `temperature`、`top_p`、`seed`、`stop`、`max_tokens` 精确控制工具模型输出
- **🔌 双 API 支持** — 同时支持 **DeepSeek 官方 API**（推荐）和 **SiliconFlow API**

---

## 目录

- [快速开始](#快速开始)
- [配置](#配置)
- [工具说明](#工具说明)
  - [chat_agent](#chat_agent)
  - [create_branch](#create_branch)
  - [get_branch_details](#get_branch_details)
- [错误处理](#错误处理)
- [MCP Client 配置](#mcp-client-配置)
- [测试](#测试)
- [项目结构](#项目结构)
- [开发](#开发)
- [许可证](#许可证)

---

## 快速开始

```bash
# 克隆并安装依赖
git clone https://github.com/ScarletLilith/meditatorMCP.git
cd meditatorMCP
npm install

# 配置 API（见下方配置章节）
# 编辑 test/config.json 或设置环境变量

# 启动服务
npm run build
npm start

# 或开发模式
npm run dev
```

---

## 配置

配置加载优先级：**环境变量 > `test/config.json`**

### 方式一：DeepSeek 官方 API（推荐）

```bash
export DEEPSEEK_API_KEY=sk-your-key
export DEEPSEEK_BASE_URL=https://api.deepseek.com
export DEEPSEEK_MODEL=deepseek-v4-pro
```

> **注意**：DeepSeek 思考模式使用 `thinking: {type: "enabled"}` 参数（非 `enable_thinking: true`）。

### 方式二：SiliconFlow API（备选）

```bash
export SILICONFLOW_API_KEY=sk-your-key
export SILICONFLOW_BASE_URL=https://api.siliconflow.cn/v1
export SILICONFLOW_MODEL=deepseek-ai/DeepSeek-V4-Flash
```

### 配置文件

创建 `test/config.json`（已被 gitignore）：

```json
{
  "baseUrl": "https://api.deepseek.com",
  "model": "deepseek-v4-pro",
  "apiKey": "sk-xxx"
}
```

---

## 工具说明

### chat_agent

调用非思考模型执行独立子任务，延长思考模型的思维链。

#### 参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `input_text` | `string` | **必填** | 完整、自包含的任务描述，包含所有上下文 |
| `system_prompt` | `string` | 可选 | 系统提示词，设定角色或行为约束 |
| `temperature` | `number` | `0.7` | 采样温度 0.0–2.0。低=精确，高=创造 |
| `top_p` | `number` | `0.9` | 核采样阈值 0.0–1.0 |
| `max_tokens` | `number` | `4096` | 最大输出 token 数（API 级控制） |
| `stop` | `string[]` | `[]` | 停止序列；空数组 = 自然完成输出 |
| `seed` | `number` | 可选 | 随机种子，配合低温度实现输出复现 |

#### 参数策略

```
校验模式:   temperature=0.1, top_p=0.1,  max_tokens=2048, seed=42
发散模式:   temperature=1.2, top_p=0.95, max_tokens=4096
平衡模式:   temperature=0.5, top_p=0.8,  max_tokens=4096
```

---

### create_branch

创建思维分支节点，支持递归嵌套，实现多角度深度分析。

#### 参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `session_id` | `string` | **必填** | 会话ID，同一次推理中保持一致 |
| `input_text` | `string` | **必填** | 完整的子任务描述（≥30 字符） |
| `call_type` | `string` | `drill_down` | 分支类型：`drill_down` / `verify` / `explore` / `stash` |
| `parent_node_id` | `string` | `trunk` | 父节点ID，支持树形嵌套 |

**四种分支类型：**

| 类型 | 温度 | 用途 |
|------|:----:|------|
| `drill_down` | 0.2 | 深入拆解子问题，精确聚焦 |
| `verify` | 0.0 | 验证结论或假设，确定性输出 |
| `explore` | 1.0 | 不同角度发散思考，创意多样 |
| `stash` | 0.6 | 临时记录中间想法 |

#### 响应

```json
{
  "status": "success",
  "node_id": "n_a1b2c3d4",
  "conclusion": "提取的结论文本...",
  "confidence": 0.85,
  "remaining_quota": 12,
  "suggestions": [
    "发散探索完成，可对有价值的方向用 drill_down 深入",
    "还可创建 12 个分支，建议继续多角度探索"
  ]
}
```

---

### get_branch_details

获取之前创建的分支节点的完整原始推理过程。

#### 参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `session_id` | `string` | **必填** | 会话ID |
| `node_id` | `string` | **必填** | `create_branch` 返回的分支节点ID |

#### 响应

```json
{
  "status": "success",
  "node_id": "n_a1b2c3d4",
  "raw_process": "模型的完整原始推理输出..."
}
```

---

## 错误处理

工具返回结构化错误信息，包含 `type` 和 `action` 字段，帮助思考模型做出决策：

```json
{
  "success": false,
  "type": "api",
  "action": "report",
  "error": "API 认证失败(401)",
  "status_code": 401
}
```

| 错误类型 | `action` | 触发场景 |
|----------|----------|----------|
| `network` | `retry` | DNS 解析失败、连接被拒绝 |
| `api` | `backoff` | 429 限流 |
| `api` | `report` | 401 认证失败 |
| `api` | `retry` | 5xx 服务不可用 |
| `validation` | `fix_input` | input_text 为空 |
| `config` | `report` | 未配置 API Key/Model |

服务端重试机制使用 Jitter 指数退避（1s→3s→7s，最多 3 次），仅对 429 和 5xx 重试。网络错误（ENOTFOUND、ECONNREFUSED 等）不自动重试。

---

## MCP Client 配置

### Claude Desktop

```json
{
  "mcpServers": {
    "thinking-agent": {
      "command": "node",
      "args": ["path/to/meditatorMCP/dist/index.js"],
      "env": {
        "DEEPSEEK_API_KEY": "sk-your-key",
        "DEEPSEEK_BASE_URL": "https://api.deepseek.com",
        "DEEPSEEK_MODEL": "deepseek-v4-pro"
      }
    }
  }
}
```

### 通用 MCP Client

配置 stdio 传输指向项目目录下的 `node dist/index.js`，并设置必要的环境变量。

---

## 测试

项目包含交互式和自动化测试框架：

```bash
# 交互式 CLI（带工具模式）
npm run test:with-tool

# 交互式 CLI（纯思考，无工具）
npm run test:without-tool

# 自动对比测试（运行两个场景 + 生成报告）
npm run test:comparison

# 批量端到端测试
npm run test:batch
```

### 测试脚本说明

| 脚本 | 说明 |
|------|------|
| `test/testFramework.ts` | 交互式 CLI 测试框架 |
| `test/comparisonTest.ts` | 自动 A/B 对比测试 |
| `test/runA.js` | 场景A：思考模型 + 工具（独立运行，DeepSeek） |
| `test/runB.js` | 场景B：纯思考模型（独立运行，DeepSeek） |
| `test/batchTest.ts` | 批量端到端测试 |

注意：`test/config.json` 包含你的 API 密钥，已被 gitignore 保护。

---

## 项目结构

```
├── src/
│   ├── index.ts           # MCP Server 入口
│   ├── chatAgentTool.ts   # 工具实现（三个工具）
│   ├── gatekeeper.ts      # 输入校验和配额控制
│   ├── strategyEngine.ts  # 策略引擎（call_type → 参数映射）
│   ├── nodeStore.ts       # 分支节点存储和结论提取
│   ├── schemas.ts         # Zod 校验 Schema 和类型定义
│   ├── logger.ts          # 结构化日志（输出到 stderr）
│   └── polyfill.ts        # Node 14 fetch polyfill
├── test/
│   ├── comparisonTest.ts  # 对比测试
│   ├── testFramework.ts   # 交互式 CLI 测试框架
│   ├── batchTest.ts       # 批量测试
│   ├── runA.js            # 场景A 测试（DeepSeek）
│   ├── runB.js            # 场景B 测试（DeepSeek）
│   └── config.json        # API 配置（已 gitignore）
├── .env.example           # 环境变量模板
├── blueprint.md           # 项目设计蓝图
├── package.json
├── tsconfig.json
├── README.md              # 英文文档
└── README.zh.md           # 中文文档
```

---

## 开发

```bash
# 编译 TypeScript
npm run build

# 启动生产服务
npm run start

# 开发模式（ts-node，无需编译）
npm run dev
```

### 设计理念

1. **自包含任务描述** — 所有上下文必须打包进 `input_text`；工具不依赖对话历史
2. **上下文隔离** — 每次工具调用独立无状态，防止主链上下文爆炸
3. **Token 成本优化** — 上下文消耗在更便宜的非思考模型 input tokens 侧
4. **树形推理** — 复杂问题拆解为独立分支分别分析，再综合得出结论

---

## 许可证

[MIT](LICENSE)
