# Thinking Agent MCP

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-3178C6?logo=typescript)](package.json)
[![MCP](https://img.shields.io/badge/MCP-Server-8A2BE2)](https://modelcontextprotocol.io)

**Extend your thinking model's chain of thought via MCP tools** — a Model Context Protocol server that exposes `chat_agent`, `create_branch`, and `get_branch_details` tools, enabling thinking models to offload subtasks to non-thinking models and build tree-structured multi-perspective analysis.

---

## Features

- **🧠 Chain of Thought Extension** — Thinking models can delegate reasoning subtasks to non-thinking models via `chat_agent`, extending effective reasoning depth beyond single-model token limits
- **🌳 Tree-Structured Thinking** — `create_branch` enables recursive, multi-perspective exploration with four branch types (drill down / verify / explore / stash)
- **🔍 Full Traceability** — `get_branch_details` retrieves the complete raw reasoning process of any created branch
- **🛡️ Context Isolation** — Tools are stateless and self-contained; all context must be packed into `input_text`. No conversation history dependency
- **🎛️ Parameter Control** — Fine-grained control over tool model output via `temperature`, `top_p`, `seed`, `stop`, and `max_tokens`
- **🔌 Dual API Support** — Works with both **DeepSeek official API** (recommended) and **SiliconFlow API**

---

## Table of Contents

- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Tools](#tools)
  - [chat_agent](#chat_agent)
  - [create_branch](#create_branch)
  - [get_branch_details](#get_branch_details)
- [Error Handling](#error-handling)
- [MCP Client Setup](#mcp-client-setup)
- [Testing](#testing)
- [Project Structure](#project-structure)
- [Development](#development)
- [License](#license)

---

## Quick Start

```bash
# Clone and install
git clone https://github.com/ScarletLilith/meditatorMCP.git
cd meditatorMCP
npm install

# Configure API (see Configuration section below)
# edit test/config.json or set environment variables

# Start the server
npm run build
npm start

# Or run development mode
npm run dev
```

---

## Configuration

Configuration is loaded with the following priority: **Environment variables > `test/config.json`**

### Option 1: DeepSeek Official API (Recommended)

```bash
export DEEPSEEK_API_KEY=sk-your-key
export DEEPSEEK_BASE_URL=https://api.deepseek.com
export DEEPSEEK_MODEL=deepseek-v4-pro
```

> **Note**: DeepSeek's thinking mode uses `thinking: {type: "enabled"}` (not `enable_thinking: true`).

### Option 2: SiliconFlow API (Fallback)

```bash
export SILICONFLOW_API_KEY=sk-your-key
export SILICONFLOW_BASE_URL=https://api.siliconflow.cn/v1
export SILICONFLOW_MODEL=deepseek-ai/DeepSeek-V4-Flash
```

### Config File

Create `test/config.json` (gitignored automatically):

```json
{
  "baseUrl": "https://api.deepseek.com",
  "model": "deepseek-v4-pro",
  "apiKey": "sk-xxx"
}
```

---

## Tools

### chat_agent

Calls a non-thinking model to execute an independent subtask, extending the thinking model's chain of thought.

#### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `input_text` | `string` | **required** | Complete, self-contained task description with all context |
| `system_prompt` | `string` | optional | System prompt for role/behavior constraints |
| `temperature` | `number` | `0.7` | Sampling temperature (0.0–2.0). Low = precise, high = creative |
| `top_p` | `number` | `0.9` | Nucleus sampling threshold (0.0–1.0) |
| `max_tokens` | `number` | `4096` | Maximum output tokens (enforced server-side via API) |
| `stop` | `string[]` | `[]` | Stop sequences; empty array = natural completion |
| `seed` | `number` | optional | Random seed for reproducible output (with low temperature) |

#### Parameter Strategies

```
Verification:  temperature=0.1, top_p=0.1,  max_tokens=2048, seed=42
Exploration:   temperature=1.2, top_p=0.95, max_tokens=4096
Balanced:      temperature=0.5, top_p=0.8,  max_tokens=4096
```

---

### create_branch

Creates a thinking branch node with recursive nesting support for deep multi-perspective analysis.

#### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `session_id` | `string` | **required** | Session ID, consistent within a single reasoning session |
| `input_text` | `string` | **required** | Self-contained subtask description (≥30 characters) |
| `call_type` | `string` | `drill_down` | Branch type: `drill_down` / `verify` / `explore` / `stash` |
| `parent_node_id` | `string` | `trunk` | Parent node ID for tree nesting |

**Four Branch Types:**

| Type | Temperature | Purpose |
|------|:-----------:|---------|
| `drill_down` | 0.2 | Deep-dive into a subproblem with focused precision |
| `verify` | 0.0 | Verify a conclusion or hypothesis with maximal determinism |
| `explore` | 1.0 | Divergent thinking from different angles with high creativity |
| `stash` | 0.6 | Temporarily record intermediate thoughts for later reference |

#### Response

```json
{
  "status": "success",
  "node_id": "n_a1b2c3d4",
  "conclusion": "The extracted conclusion text...",
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

Retrieves the complete raw reasoning process of a previously created branch node.

#### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `session_id` | `string` | **required** | Session ID |
| `node_id` | `string` | **required** | Branch node ID returned by `create_branch` |

#### Response

```json
{
  "status": "success",
  "node_id": "n_a1b2c3d4",
  "raw_process": "The complete raw reasoning output from the model..."
}
```

---

## Error Handling

Tools return structured errors with `type` and `action` fields for the thinking model to make informed decisions:

```json
{
  "success": false,
  "type": "api",
  "action": "report",
  "error": "API authentication failed (401)",
  "status_code": 401
}
```

| Error Type | `action` | Trigger |
|-----------|----------|---------|
| `network` | `retry` | DNS resolution failure, connection refused |
| `api` | `backoff` | 429 rate limited |
| `api` | `report` | 401 authentication failure |
| `api` | `retry` | 5xx server errors |
| `validation` | `fix_input` | Empty `input_text` |
| `config` | `report` | Missing API Key / Model configuration |

The server-side retry mechanism uses exponential backoff with jitter (1s→3s→7s, max 3 retries) for 429 and 5xx errors. Network errors (ENOTFOUND, ECONNREFUSED, ECONNRESET) are not automatically retried.

---

## MCP Client Setup

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

### Any MCP-compatible Client

Configure stdio transport to point to `node dist/index.js` in the project directory, with the required environment variables set.

---

## Testing

The project includes both interactive and automated test frameworks:

```bash
# Interactive CLI (with tools mode)
npm run test:with-tool

# Interactive CLI (pure thinking, no tools)
npm run test:without-tool

# Automated comparison test (runs both scenarios + generates report)
npm run test:comparison

# Batch end-to-end tests
npm run test:batch
```

### Test Scripts

| Script | Description |
|--------|-------------|
| `test/testFramework.ts` | Interactive CLI test framework |
| `test/comparisonTest.ts` | Automated A/B comparison (with-tool vs without-tool) |
| `test/runA.js` | Scenario A: thinking model + tools (standalone, DeepSeek) |
| `test/runB.js` | Scenario B: pure thinking model (standalone, DeepSeek) |
| `test/batchTest.ts` | Batch end-to-end tests |

Note: The `test/config.json` file contains your API key and is automatically gitignored.

---

## Project Structure

```
├── src/
│   ├── index.ts           # MCP Server entry point
│   ├── chatAgentTool.ts   # Tool implementations (chat_agent, create_branch, get_branch_details)
│   ├── gatekeeper.ts      # Input validation and quota enforcement
│   ├── strategyEngine.ts  # Parameter strategy mapping (call_type → temperature/top_p)
│   ├── nodeStore.ts       # Branch node storage and conclusion extraction
│   ├── schemas.ts         # Zod validation schemas and TypeScript types
│   ├── logger.ts          # Structured logging to stderr
│   └── polyfill.ts        # Node 14 fetch polyfill
├── test/
│   ├── comparisonTest.ts  # A/B comparison test
│   ├── testFramework.ts   # Interactive CLI test framework
│   ├── batchTest.ts       # Batch testing
│   ├── runA.js            # Scenario A test (DeepSeek)
│   ├── runB.js            # Scenario B test (DeepSeek)
│   └── config.json        # API configuration (gitignored)
├── .env.example           # Environment variable template
├── blueprint.md           # Project design blueprint (Chinese)
├── package.json
├── tsconfig.json
└── README.md
```

---

## Development

```bash
# Build TypeScript
npm run build

# Start production server
npm run start

# Development mode (ts-node, no build step)
npm run dev
```

### Design Philosophy

1. **Self-Contained Task Descriptions** — All context must be packed into `input_text`; tools never rely on conversation history
2. **Context Isolation** — Each tool call is stateless and independent, preventing context explosion in the main chain
3. **Token Cost Optimization** — Context is consumed by the cheaper non-thinking model's input tokens, not the thinking model's output tokens
4. **Tree-Structured Reasoning** — Complex problems are decomposed into independent branches, each analyzed separately, then synthesized

---

## License

[MIT](LICENSE)
