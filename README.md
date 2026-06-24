# Thinking Agent MCP

MCP Server 暴露 `chat_agent` 工具，封装**非思考模型**（non-thinking model），供**思考模型**（thinking model）在推理过程中调用，实现思维链的外包和延长。

## 核心思想

```
思考模型（主推理）
  └─ 构建完整的 input_text（包含所有上下文）
       └─ chat_agent 独立执行
            └─ 返回结果，思考模型整合
```

- **上下文隔离**：工具不依赖对话历史，思考模型需将所有上下文打包进 `input_text`
- **参数控制**：通过 `temperature`、`top_p` 等参数控制输出的确定性与多样性
- **思维链延长**：思考模型可将部分推理外包给工具，突破单模型输出 token 限制

## 配置

### 环境变量（推荐）

```bash
SILICONFLOW_API_KEY=sk-your-api-key-here
SILICONFLOW_BASE_URL=https://api.siliconflow.cn/v1
SILICONFLOW_MODEL=deepseek-ai/DeepSeek-V4-Flash
```

### 配置文件

复制 `.env.example` 修改，或创建 `test/config.json`：

```json
{
  "apiKey": "sk-xxx",
  "baseUrl": "https://api.siliconflow.cn/v1",
  "model": "deepseek-ai/DeepSeek-V4-Flash"
}
```

配置按以下优先级加载：**环境变量 > test/config.json**

## 工具：chat_agent

### 参数

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `input_text` | string | **必填** | 完整、自包含的任务描述，包含所有上下文 |
| `system_prompt` | string | 可选 | 系统提示词，设定角色或行为约束 |
| `temperature` | number | 0.7 | 采样温度 0.0-2.0。低=确定/精确，高=创造/发散 |
| `top_p` | number | 0.9 | 核采样阈值 0.0-1.0 |
| `max_tokens` | number | 4096 | 最大输出 token 数（API 级控制） |
| `stop` | string[] | ["\n\n"] | 停止序列 |
| `seed` | number | 无 | 随机种子，配合低 temperature 实现输出复现 |

### 参数协同策略

```
校验模式:   temperature=0.1, top_p=0.1,  max_tokens=2048, seed=42
发散模式:   temperature=1.2, top_p=0.95, max_tokens=4096
平衡模式:   temperature=0.5, top_p=0.8,  max_tokens=4096
```

### 错误响应格式

工具返回结构化错误信息，包含 `type` 和 `action` 字段：

```json
{
  "success": false,
  "type": "api",
  "action": "report",
  "error": "API 认证失败(401)，请检查 API Key 是否正确",
  "status_code": 401
}
```

| type | action | 触发场景 |
|------|--------|----------|
| `network` | `retry` | DNS 解析失败、连接被拒绝 |
| `api` | `backoff` | 429 限流 |
| `api` | `report` | 401 认证失败 |
| `api` | `retry` | 5xx 服务不可用 |
| `validation` | `fix_input` | input_text 为空 |
| `config` | `report` | 未配置 API Key/Model |

## 使用方式

### MCP Client 配置（如 Claude Desktop）

```json
{
  "mcpServers": {
    "thinking-agent": {
      "command": "node",
      "args": ["path/to/mcp/dist/index.js"],
      "env": {
        "SILICONFLOW_API_KEY": "sk-xxx",
        "SILICONFLOW_BASE_URL": "https://api.siliconflow.cn/v1",
        "SILICONFLOW_MODEL": "deepseek-ai/DeepSeek-V4-Flash"
      }
    }
  }
}
```

### 测试框架

项目内置交互式测试框架，用于调试和验证：

```bash
# 带工具模式（思考模型可使用 chat_agent）
npm run test:with-tool

# 纯思考模式（对比用）
npm run test:without-tool
```

## 项目结构

```
├── src/
│   ├── index.ts           # MCP Server 入口
│   ├── chatAgentTool.ts   # chat_agent 工具实现
│   └── logger.ts          # 结构化日志
├── test/
│   ├── testFramework.ts   # 交互式测试框架
│   ├── batchTest.ts       # 批量对比测试
│   ├── fullTest.ts        # 完整功能测试
│   ├── quickTest.ts       # 快速集成测试
│   └── config.json        # API 配置（不提交）
├── .env.example           # 环境变量模板
├── blueprint.md           # 项目蓝图
└── package.json
```

## 开发

```bash
npm run build       # 编译 TypeScript
npm run start       # 启动 MCP Server
npm run dev         # 开发模式（ts-node）
```

## License

MIT
