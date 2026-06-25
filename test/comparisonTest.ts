/**
 * Thinking Agent MCP 对比测试
 *
 * 自动化运行两个场景并生成对比分析报告：
 * - 场景A：思考模型 + MCP 工具（chat_agent / create_branch）
 * - 场景B：纯思考模型（无工具）
 *
 * 使用：npx ts-node test/comparisonTest.ts
 */

import "../src/polyfill";
import fetch from "node-fetch";
import * as fs from "fs";
import * as path from "path";

// ========== 配置加载 ==========
interface Config {
  baseUrl: string;
  model: string;
  apiKey: string;
}

function loadConfig(): Config {
  // 优先环境变量，其次 test/config.json
  const apiKey = process.env.SILICONFLOW_API_KEY;
  const baseUrl = process.env.SILICONFLOW_BASE_URL;
  const model = process.env.SILICONFLOW_MODEL;

  if (apiKey && baseUrl && model) {
    return { apiKey, baseUrl, model };
  }

  const configPath = path.join(__dirname, "config.json");
  if (fs.existsSync(configPath)) {
    return JSON.parse(fs.readFileSync(configPath, "utf-8"));
  }

  throw new Error("未找到配置：请设置环境变量或创建 test/config.json");
}

// ========== API 调用 ==========
async function callAPI(config: Config, body: any): Promise<any> {
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API Error ${response.status}: ${errorText}`);
  }

  return response.json();
}

// ========== 工具定义（仅 with-tool 模式使用）==========
const CHAT_AGENT_TOOL = {
  type: "function",
  function: {
    name: "chat_agent",
    description: [
      "调用独立、非思考模式的模型生成文本，用于延伸当前思维链。",
      "你可以传入任何需要独立完成且不受对话历史影响的子任务，",
      "包括但不限于：逻辑推理、发散联想、创意生成、优缺点分析、",
      "情景假设、步骤拆解、知识类比与迁移等。",
      "⚠ 本工具适合单次独立推理。若需要多角度深入探索，",
      "请改用 create_branch 工具构建树形思维分支（支持递归嵌套）。",
      "复杂问题建议：先用 create_branch 拆解为多个分支分别验证/发散/深入，",
      "再综合各分支结论得出最终答案。",
    ].join(""),
    parameters: {
      type: "object",
      properties: {
        input_text: {
          type: "string",
          description: "完整、自包含的任务描述。必须包含所有必要上下文。",
        },
        system_prompt: { type: "string", description: "可选的系统提示词" },
        temperature: {
          type: "number",
          description: "采样温度，0.0-2.0",
          default: 0.7,
        },
        top_p: {
          type: "number",
          description: "Top-p 采样，0.0-1.0",
          default: 0.9,
        },
        max_tokens: {
          type: "number",
          description: "最大输出 token 数",
          default: 4096,
        },
      },
      required: ["input_text"],
    },
  },
};

const CREATE_BRANCH_TOOL = {
  type: "function",
  function: {
    name: "create_branch",
    description: [
      "创建思维分支节点，支持树形递归嵌套，实现多角度深度思考。",
      "每次调用创建一个分支，仅返回精炼结论（不返回推理过程），保护主链上下文窗口。\n",
      "🔑 核心用法：对复杂问题，你应该多次调用本工具创建多个分支，形成思维树。\n",
      "📌 四种分支类型：\n",
      "  • drill_down —— 深入拆解某个子问题（低温度，精确聚焦）\n",
      "  • verify —— 验证某个结论或假设是否正确（极低温度，确定性输出）\n",
      "  • explore —— 从不同角度发散思考（高温度，创意多样）\n",
      "  • stash —— 临时记录中间想法，稍后引用（中温度）\n",
      "🌲 树形嵌套：parent_node_id='trunk' 挂到主干；填入其他 node_id 可在已有分支下创建子分支。\n",
      "💡 推荐工作流：\n",
      "  1. 先 explore 一个问题的多种可能方向\n",
      "  2. 对每个有希望的方向 drill_down 深入\n",
      "  3. 对关键结论 verify 交叉验证\n",
      "  4. 综合所有分支结论，输出最终答案\n",
      "⚡ 你可以（且应该）多次调用本工具。每个分支独立推理，互不干扰。",
    ].join(""),
    parameters: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "会话ID，同一次推理中保持一致",
        },
        input_text: {
          type: "string",
          minLength: 30,
          description: "完整的子任务描述，至少30字",
        },
        call_type: {
          type: "string",
          enum: ["drill_down", "verify", "explore", "stash"],
          description: "分支类型",
        },
        parent_node_id: {
          type: "string",
          default: "trunk",
          description: "父节点ID",
        },
      },
      required: ["session_id", "input_text"],
    },
  },
};

// ========== 工具执行 ==========
async function executeChatAgent(config: Config, args: any): Promise<string> {
  const {
    input_text,
    system_prompt,
    temperature = 0.7,
    top_p = 0.9,
    max_tokens = 4096,
  } = args;

  const messages: any[] = system_prompt
    ? [
        { role: "system", content: system_prompt },
        { role: "user", content: input_text },
      ]
    : [{ role: "user", content: input_text }];

  const body: any = {
    model: config.model,
    messages,
    temperature,
    max_tokens,
    top_p,
  };

  const data = await callAPI(config, body);
  const content = data.choices?.[0]?.message?.content || "";
  const usage = data.choices?.[0]?.message?.usage || data.usage;

  return JSON.stringify({
    success: true,
    content,
    finish_reason: data.choices?.[0]?.finish_reason,
    usage: usage
      ? {
          prompt_tokens: usage.prompt_tokens,
          completion_tokens: usage.completion_tokens,
          total_tokens: usage.total_tokens,
        }
      : null,
    model: data.model,
    hint: "若需多角度深入探索，请使用 create_branch 工具构建思维树分支",
  });
}

async function executeCreateBranch(
  config: Config,
  args: any
): Promise<string> {
  const { input_text, call_type = "explore", session_id } = args;

  // 根据 call_type 选择策略参数
  const strategyMap: Record<string, { temperature: number; top_p: number }> = {
    drill_down: { temperature: 0.2, top_p: 0.2 },
    verify: { temperature: 0.0, top_p: 0.1 },
    explore: { temperature: 1.0, top_p: 0.9 },
    stash: { temperature: 0.6, top_p: 0.6 },
  };
  const strategy = strategyMap[call_type] || strategyMap.explore;

  const systemPrompt = `你是一个专注的分析助手。请对以下问题进行 ${call_type} 类型的分析。
要求：
1. 深入分析问题
2. 在输出末尾用 [最终结论] 标记你的核心结论（1-3句话概括）
3. 保持聚焦，不要偏离主题`;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: input_text },
  ];

  const body = {
    model: config.model,
    messages,
    temperature: strategy.temperature,
    top_p: strategy.top_p,
    max_tokens: 2048,
  };

  const data = await callAPI(config, body);
  const rawContent = data.choices?.[0]?.message?.content || "";

  // 提取结论
  const conclusionMatch = rawContent.match(
    /\[最终结论\][：:\s]*([\s\S]*?)$/
  );
  const conclusion = conclusionMatch
    ? conclusionMatch[1].trim()
    : rawContent.slice(-200);

  // 生成 node_id
  const nodeId = `n_${Math.random().toString(36).slice(2, 10)}`;

  return JSON.stringify({
    status: "success",
    node_id: nodeId,
    conclusion,
    confidence: call_type === "verify" ? 0.9 : 0.7,
    remaining_quota: 15,
    suggestions: [
      call_type === "explore"
        ? "发散探索完成，可对有价值的方向用 drill_down 深入"
        : "",
      call_type === "drill_down"
        ? "深入分析完成，可用 verify 验证关键前提"
        : "",
      call_type === "verify"
        ? "验证完成，可继续验证其他假设或综合结论"
        : "",
      "可继续创建更多分支，多角度探索",
    ].filter(Boolean),
  });
}

// ========== 思考模型调用 ==========
interface ThinkingResult {
  content: string;
  reasoning: string;
  toolCalls: any[];
  usage: any;
}

async function callThinkingModel(
  config: Config,
  messages: any[],
  mode: "with-tool" | "without-tool"
): Promise<ThinkingResult> {
  const body: any = {
    model: config.model,
    messages,
    enable_thinking: true,
    stream: false,
  };

  if (mode === "with-tool") {
    body.tools = [CHAT_AGENT_TOOL, CREATE_BRANCH_TOOL];
  }

  const data = await callAPI(config, body);
  const msg = data.choices?.[0]?.message;

  return {
    content: msg?.content || "",
    reasoning: msg?.reasoning_content || "",
    toolCalls: msg?.tool_calls || [],
    usage: data.usage || {},
  };
}

// ========== 单场景运行 ==========
async function runScenario(
  config: Config,
  prompt: string,
  systemPrompt: string,
  mode: "with-tool" | "without-tool"
): Promise<{
  finalContent: string;
  reasoning: string;
  toolCallHistory: any[];
  totalUsage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  rounds: number;
}> {
  const conversation: any[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: prompt },
  ];

  const toolCallHistory: any[] = [];
  let totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let rounds = 0;
  const MAX_ROUNDS = 20;

  while (rounds < MAX_ROUNDS) {
    rounds++;
    const result = await callThinkingModel(config, conversation, mode);

    // 累计 token
    totalUsage.prompt_tokens += result.usage.prompt_tokens || 0;
    totalUsage.completion_tokens += result.usage.completion_tokens || 0;
    totalUsage.total_tokens += result.usage.total_tokens || 0;

    if (result.toolCalls.length === 0) {
      // 没有工具调用，返回最终结果
      return {
        finalContent: result.content,
        reasoning: result.reasoning,
        toolCallHistory,
        totalUsage,
        rounds,
      };
    }

    // 有工具调用 - 处理每个调用
    conversation.push({
      role: "assistant",
      content: result.content || null,
      tool_calls: result.toolCalls,
    });

    for (const toolCall of result.toolCalls) {
      const funcName = toolCall.function.name;
      const args = JSON.parse(toolCall.function.arguments);

      let toolResult: string;
      if (funcName === "chat_agent") {
        toolResult = await executeChatAgent(config, args);
      } else if (funcName === "create_branch") {
        toolResult = await executeCreateBranch(config, args);
      } else {
        toolResult = JSON.stringify({ error: `Unknown tool: ${funcName}` });
      }

      toolCallHistory.push({
        round: rounds,
        tool: funcName,
        args,
        result: toolResult,
      });

      conversation.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: toolResult,
      });
    }

    console.log(
      `  [轮次 ${rounds}] 执行了 ${result.toolCalls.length} 个工具调用: ${result.toolCalls.map((tc: any) => tc.function.name).join(", ")}`
    );
  }

  // 超过最大轮次
  return {
    finalContent: "[达到最大工具调用轮次限制]",
    reasoning: "",
    toolCallHistory,
    totalUsage,
    rounds,
  };
}

// ========== 主程序 ==========
async function main() {
  console.log("=".repeat(60));
  console.log("  Thinking Agent MCP 对比测试");
  console.log("  测试目标：评估 MCP 工具对思维质量的提升效果");
  console.log("=".repeat(60));
  console.log();

  const config = loadConfig();
  console.log(`✓ 配置加载成功: ${config.baseUrl} / ${config.model}`);
  console.log();

  // 读取 blueprint.md
  const blueprintPath = path.join(__dirname, "..", "blueprint.md");
  const blueprintContent = fs.readFileSync(blueprintPath, "utf-8");
  console.log(`✓ 已读取 blueprint.md (${blueprintContent.length} 字符)`);
  console.log();

  // 构造测试提示词
  const testPrompt = `以下是一个 MCP Server 项目的工程蓝图文档。请仔细阅读后，从以下几个维度提出改进方案：

1. **架构改进**：当前架构有哪些不足？如何优化？
2. **功能增强**：缺少哪些关键功能？优先级如何？
3. **可靠性提升**：错误处理、容错机制有哪些改进空间？
4. **开发体验**：测试、文档、部署流程如何优化？
5. **性能优化**：有哪些性能瓶颈和优化方向？

请给出具体的、可执行的改进方案，而非泛泛而谈。

---

蓝图文档内容：

${blueprintContent}`;

  const systemPromptWithTool = `你是一个资深软件架构师，正在评审一个 MCP Server 项目。
你可以使用提供的工具来辅助分析：
- chat_agent：用于独立推理子任务
- create_branch：用于创建思维分支，从不同角度深入分析

建议工作流：
1. 先用 create_branch (explore) 从多个角度发散分析
2. 对每个有价值的方向用 create_branch (drill_down) 深入
3. 对关键结论用 create_branch (verify) 验证
4. 综合所有分支结论，输出最终改进方案

请充分利用工具进行多角度深入分析。`;

  const systemPromptWithoutTool = `你是一个资深软件架构师，正在评审一个 MCP Server 项目。
请仅依靠自身推理能力，对文档进行深入分析并提出改进方案。`;

  // 确保结果目录存在
  const resultsDir = path.join(__dirname, "results");
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

  // ========== 场景A：带工具 ==========
  console.log("━".repeat(60));
  console.log("📋 场景A：思考模型 + MCP 工具");
  console.log("━".repeat(60));
  console.log();

  const startA = Date.now();
  const resultA = await runScenario(
    config,
    testPrompt,
    systemPromptWithTool,
    "with-tool"
  );
  const timeA = ((Date.now() - startA) / 1000).toFixed(1);

  console.log();
  console.log(
    `✓ 场景A完成: ${resultA.rounds} 轮, ${resultA.toolCallHistory.length} 次工具调用, ${timeA}s`
  );
  console.log(
    `  Token: prompt=${resultA.totalUsage.prompt_tokens}, completion=${resultA.totalUsage.completion_tokens}, total=${resultA.totalUsage.total_tokens}`
  );
  console.log();

  // ========== 场景B：纯思考 ==========
  console.log("━".repeat(60));
  console.log("📋 场景B：纯思考模型（无工具）");
  console.log("━".repeat(60));
  console.log();

  const startB = Date.now();
  const resultB = await runScenario(
    config,
    testPrompt,
    systemPromptWithoutTool,
    "without-tool"
  );
  const timeB = ((Date.now() - startB) / 1000).toFixed(1);

  console.log();
  console.log(`✓ 场景B完成: ${resultB.rounds} 轮, ${timeB}s`);
  console.log(
    `  Token: prompt=${resultB.totalUsage.prompt_tokens}, completion=${resultB.totalUsage.completion_tokens}, total=${resultB.totalUsage.total_tokens}`
  );
  console.log();

  // ========== 保存结果 ==========
  // 场景A结果
  const resultAPath = path.join(
    resultsDir,
    `with-tool-comparison-${timestamp}`
  );
  fs.writeFileSync(
    `${resultAPath}.json`,
    JSON.stringify(
      {
        mode: "with-tool",
        timestamp: new Date().toISOString(),
        config: { model: config.model, baseUrl: config.baseUrl },
        prompt: testPrompt,
        systemPrompt: systemPromptWithTool,
        result: {
          finalContent: resultA.finalContent,
          reasoning: resultA.reasoning,
          toolCallHistory: resultA.toolCallHistory,
          totalUsage: resultA.totalUsage,
          rounds: resultA.rounds,
          timeSeconds: parseFloat(timeA),
        },
      },
      null,
      2
    ),
    "utf-8"
  );

  fs.writeFileSync(
    `${resultAPath}.md`,
    [
      `# 场景A：思考模型 + MCP 工具`,
      ``,
      `**时间**: ${new Date().toISOString()}`,
      `**模型**: ${config.model}`,
      `**轮次**: ${resultA.rounds}`,
      `**工具调用**: ${resultA.toolCallHistory.length} 次`,
      `**耗时**: ${timeA}s`,
      `**Token**: prompt=${resultA.totalUsage.prompt_tokens}, completion=${resultA.totalUsage.completion_tokens}, total=${resultA.totalUsage.total_tokens}`,
      ``,
      `## 思考过程`,
      ``,
      resultA.reasoning
        ? `\`\`\`\n${resultA.reasoning}\n\`\`\``
        : "(无独立思考内容)",
      ``,
      `## 工具调用历史`,
      ``,
      ...resultA.toolCallHistory.map((tc, i) =>
        [
          `### 调用 ${i + 1}: ${tc.tool} (轮次 ${tc.round})`,
          ``,
          `**参数**:`,
          `\`\`\`json`,
          JSON.stringify(tc.args, null, 2),
          `\`\`\``,
          ``,
          `**结果**:`,
          `\`\`\`json`,
          JSON.stringify(JSON.parse(tc.result), null, 2),
          `\`\`\``,
          ``,
        ].join("\n")
      ),
      `## 最终输出`,
      ``,
      resultA.finalContent,
    ].join("\n"),
    "utf-8"
  );

  // 场景B结果
  const resultBPath = path.join(
    resultsDir,
    `without-tool-comparison-${timestamp}`
  );
  fs.writeFileSync(
    `${resultBPath}.json`,
    JSON.stringify(
      {
        mode: "without-tool",
        timestamp: new Date().toISOString(),
        config: { model: config.model, baseUrl: config.baseUrl },
        prompt: testPrompt,
        systemPrompt: systemPromptWithoutTool,
        result: {
          finalContent: resultB.finalContent,
          reasoning: resultB.reasoning,
          totalUsage: resultB.totalUsage,
          rounds: resultB.rounds,
          timeSeconds: parseFloat(timeB),
        },
      },
      null,
      2
    ),
    "utf-8"
  );

  fs.writeFileSync(
    `${resultBPath}.md`,
    [
      `# 场景B：纯思考模型（无工具）`,
      ``,
      `**时间**: ${new Date().toISOString()}`,
      `**模型**: ${config.model}`,
      `**轮次**: ${resultB.rounds}`,
      `**耗时**: ${timeB}s`,
      `**Token**: prompt=${resultB.totalUsage.prompt_tokens}, completion=${resultB.totalUsage.completion_tokens}, total=${resultB.totalUsage.total_tokens}`,
      ``,
      `## 思考过程`,
      ``,
      resultB.reasoning
        ? `\`\`\`\n${resultB.reasoning}\n\`\`\``
        : "(无独立思考内容)",
      ``,
      `## 最终输出`,
      ``,
      resultB.finalContent,
    ].join("\n"),
    "utf-8"
  );

  // ========== 对比分析报告 ==========
  const analysisPath = path.join(
    resultsDir,
    `comparison-analysis-${timestamp}.md`
  );

  const contentLenA = resultA.finalContent.length;
  const contentLenB = resultB.finalContent.length;
  const reasoningLenA = resultA.reasoning.length;
  const reasoningLenB = resultB.reasoning.length;

  fs.writeFileSync(
    analysisPath,
    [
      `# MCP 工具 vs 纯思考模型 — 对比分析报告`,
      ``,
      `**测试时间**: ${new Date().toISOString()}`,
      `**测试模型**: ${config.model}`,
      `**测试任务**: 改进 MCP Server 项目蓝图文档`,
      ``,
      `## 定量对比`,
      ``,
      `| 指标 | 场景A (带工具) | 场景B (纯思考) | 差异 |`,
      `|------|:---:|:---:|:---:|`,
      `| 总轮次 | ${resultA.rounds} | ${resultB.rounds} | ${resultA.rounds - resultB.rounds > 0 ? "+" : ""}${resultA.rounds - resultB.rounds} |`,
      `| 工具调用次数 | ${resultA.toolCallHistory.length} | 0 | +${resultA.toolCallHistory.length} |`,
      `| 耗时(秒) | ${timeA} | ${timeB} | ${(parseFloat(timeA) - parseFloat(timeB)).toFixed(1)}s |`,
      `| Prompt Tokens | ${resultA.totalUsage.prompt_tokens} | ${resultB.totalUsage.prompt_tokens} | ${resultA.totalUsage.prompt_tokens - resultB.totalUsage.prompt_tokens} |`,
      `| Completion Tokens | ${resultA.totalUsage.completion_tokens} | ${resultB.totalUsage.completion_tokens} | ${resultA.totalUsage.completion_tokens - resultB.totalUsage.completion_tokens} |`,
      `| Total Tokens | ${resultA.totalUsage.total_tokens} | ${resultB.totalUsage.total_tokens} | ${resultA.totalUsage.total_tokens - resultB.totalUsage.total_tokens} |`,
      `| 最终输出长度(字) | ${contentLenA} | ${contentLenB} | ${contentLenA - contentLenB} |`,
      `| 推理过程长度(字) | ${reasoningLenA} | ${reasoningLenB} | ${reasoningLenA - reasoningLenB} |`,
      ``,
      `## 工具使用情况分析`,
      ``,
      `### 工具调用分布`,
      ``,
      ...(() => {
        const toolCounts: Record<string, number> = {};
        const typeCounts: Record<string, number> = {};
        for (const tc of resultA.toolCallHistory) {
          toolCounts[tc.tool] = (toolCounts[tc.tool] || 0) + 1;
          if (tc.args.call_type) {
            typeCounts[tc.args.call_type] =
              (typeCounts[tc.args.call_type] || 0) + 1;
          }
        }
        const lines = [`| 工具 | 调用次数 |`, `|------|:---:|`];
        for (const [tool, count] of Object.entries(toolCounts)) {
          lines.push(`| ${tool} | ${count} |`);
        }
        if (Object.keys(typeCounts).length > 0) {
          lines.push(
            ``,
            `### 分支类型分布`,
            ``,
            `| 类型 | 次数 |`,
            `|------|:---:|`
          );
          for (const [type, count] of Object.entries(typeCounts)) {
            lines.push(`| ${type} | ${count} |`);
          }
        }
        return lines;
      })(),
      ``,
      `## 质量维度评估（需人工审阅）`,
      ``,
      `请对照两个场景的输出，从以下维度评分（1-5分）：`,
      ``,
      `| 维度 | 场景A评分 | 场景B评分 | 说明 |`,
      `|------|:---:|:---:|------|`,
      `| 深度 | ___/5 | ___/5 | 分析是否深入到具体实现层面 |`,
      `| 广度 | ___/5 | ___/5 | 是否覆盖了多个维度 |`,
      `| 可执行性 | ___/5 | ___/5 | 建议是否具体可落地 |`,
      `| 创新性 | ___/5 | ___/5 | 是否有独到见解 |`,
      `| 结构化 | ___/5 | ___/5 | 输出是否清晰有条理 |`,
      ``,
      `## 初步结论`,
      ``,
      `- 场景A（带工具）共进行了 **${resultA.rounds}** 轮对话，调用了 **${resultA.toolCallHistory.length}** 次工具`,
      `- 场景B（纯思考）仅 **${resultB.rounds}** 轮即完成`,
      `- Token 消耗：场景A 为 ${resultA.totalUsage.total_tokens}，场景B 为 ${resultB.totalUsage.total_tokens}`,
      `- ${resultA.toolCallHistory.length > 0 ? "模型成功利用了工具进行多角度分析" : "⚠ 模型未使用工具，需检查工具描述是否足够引导"}`,
      ``,
      `## 详细输出`,
      ``,
      `- 场景A完整输出: [with-tool-comparison-${timestamp}.md](./with-tool-comparison-${timestamp}.md)`,
      `- 场景B完整输出: [without-tool-comparison-${timestamp}.md](./without-tool-comparison-${timestamp}.md)`,
    ].join("\n"),
    "utf-8"
  );

  console.log("━".repeat(60));
  console.log("📊 对比分析完成！");
  console.log("━".repeat(60));
  console.log();
  console.log(`📁 结果文件:`);
  console.log(`   场景A (带工具): ${resultAPath}.md`);
  console.log(`   场景B (纯思考): ${resultBPath}.md`);
  console.log(`   对比报告: ${analysisPath}`);
  console.log();
  console.log(`📈 快速摘要:`);
  console.log(
    `   场景A: ${resultA.rounds}轮, ${resultA.toolCallHistory.length}次工具调用, ${resultA.totalUsage.total_tokens} tokens, ${timeA}s`
  );
  console.log(
    `   场景B: ${resultB.rounds}轮, ${resultB.totalUsage.total_tokens} tokens, ${timeB}s`
  );
  console.log(
    `   ${resultA.toolCallHistory.length > 0 ? "✅ 模型成功使用了工具" : "⚠ 模型未使用工具"}`
  );
}

main().catch((err) => {
  console.error("❌ 测试失败:", err.message);
  process.exit(1);
});
