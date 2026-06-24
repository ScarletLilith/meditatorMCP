/**
 * Batch test: Compare pure thinking vs thinking with chat_agent tool
 * 
 * Tests both modes with the same prompt (blueprint content embedded inline)
 * Saves all conversations with detailed logs and generates comparison analysis.
 */
import "../src/polyfill";
import fetch from "node-fetch";
import * as fs from "fs";
import * as path from "path";

// ═══════════════════════════════════════════════════════════════
//  Config
// ═══════════════════════════════════════════════════════════════
const config: any = JSON.parse(
  fs.readFileSync(path.join(__dirname, "config.json"), "utf-8")
);
const apiUrl = config.baseUrl.replace(/\/+$/, "") + "/chat/completions";
const RESULTS_DIR = path.join(__dirname, "..", "results");

// ═══════════════════════════════════════════════════════════════
//  Blueprint content (embedded inline so model can read it)
// ═══════════════════════════════════════════════════════════════
const BLUEPRINT_CONTENT = fs.readFileSync(
  path.join(__dirname, "..", "blueprint.md"),
  "utf-8"
);

// ═══════════════════════════════════════════════════════════════
//  Tool definition for thinking model
// ═══════════════════════════════════════════════════════════════
const TOOL_DEF = {
  type: "function",
  function: {
    name: "chat_agent",
    description: "调用独立、非思考模式的模型生成文本，用于延伸当前思维链。"
      + "你可以传入任何需要独立完成且不受对话历史影响的子任务，"
      + "包括但不限于：逻辑推理、发散联想、创意生成、优缺点分析、"
      + "情景假设、步骤拆解、知识类比与迁移等。"
      + "请确保 input_text 是一个完整、自包含的任务描述，明确任务类型与目标。"
      + "通过调整 temperature（0~2）和 top_p（0~1）控制输出的确定性与多样性。"
      + "对于需要精确复现的场景（如校验任务），建议设置 temperature 接近 0 并指定 seed。",
    parameters: {
      type: "object",
      properties: {
        input_text: { type: "string", description: "完整自包含的任务描述，包含所有上下文" },
        system_prompt: { type: "string", description: "可选的系统提示词，用于设定角色或行为约束" },
        temperature: { type: "number", default: 0.7, description: "0.0-2.0 低=确定，高=发散" },
        top_p: { type: "number", default: 0.9, description: "0.0-1.0 核采样阈值" },
        max_tokens: { type: "number", default: 4096, description: "最大输出 token 数" },
        stop: { type: "array", items: { type: "string" }, default: ["\n\n"], description: "停止序列" },
        seed: { type: "number", description: "随机种子，低 temperature 下可复现输出" },
      },
      required: ["input_text"],
    },
  },
};

// ═══════════════════════════════════════════════════════════════
//  The test prompt (blueprint is embedded directly)
// ═══════════════════════════════════════════════════════════════
function buildTestPrompt(): string {
  return `请审阅并改进以下 MCP 项目蓝图文档的内容，给出详细的改进方案。

📋 蓝图全文如下（markdown格式）：

\`\`\`markdown
${BLUEPRINT_CONTENT}
\`\`\`

请从以下维度进行分析和改进建议：
1. **架构设计** — 是否有遗漏？数据流是否完整？
2. **参数设计** — temperature/top_k/top_p 的组合策略是否合理？
3. **上下文爆炸控制** — 方案是否完善？有无更好的方案？
4. **项目结构** — 文件组织是否合理？
5. **关键技术决策** — 各决策是否有更好的替代方案？
6. **测试策略** — 是否充分？需要补充什么测试？
7. **风险与局限** — 还有哪些未考虑的风险？
8. **后续扩展** — 优先做哪些扩展？
9. **其他改进** — 任何你认为可以优化的地方

注意：请直接对蓝图内容进行分析，不要询问文件路径或要求粘贴内容。`;
}

// ═══════════════════════════════════════════════════════════════
//  Detailed logging helpers
// ═══════════════════════════════════════════════════════════════
const LOG_PREFIX = {
  INFO: "[INFO]",
  API:  "[API]",
  TOOL: "[TOOL]",
  TURN: "[TURN]",
  DONE: "[DONE]",
  WARN: "[WARN]",
  ERR:  "[ERR]",
};

function log(prefix: string, msg: string) {
  const ts = new Date().toISOString();
  console.log(`${ts} ${prefix} ${msg}`);
}

// ═══════════════════════════════════════════════════════════════
//  API call with detailed logging
// ═══════════════════════════════════════════════════════════════
async function callAPI(body: any, timeoutMs = 600000, label = ""): Promise<any> {
  const tag = label ? `[${label}]` : "";
  const urlDisplay = apiUrl.substring(0, 50) + "...";

  log(LOG_PREFIX.API, `${tag} POST ${urlDisplay}`);
  log(LOG_PREFIX.API, `${tag} model=${body.model}, messages=${body.messages?.length || 0}, enable_thinking=${body.enable_thinking || false}, tools=${body.tools ? body.tools.length : 0}`);

  if (body.temperature !== undefined) {
    log(LOG_PREFIX.API, `${tag} temperature=${body.temperature}, top_k=${body.top_k || "default"}, top_p=${body.top_p || "default"}, max_tokens=${body.max_tokens || "default"}`);
  }

  const start = Date.now();

  try {
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      timeout: timeoutMs,
    });

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    log(LOG_PREFIX.API, `${tag} HTTP ${res.status} in ${elapsed}s`);

    const data = await res.json();

    if (data.error) {
      log(LOG_PREFIX.ERR, `${tag} API error: ${JSON.stringify(data.error)}`);
      throw new Error(`API error: ${data.error?.message || JSON.stringify(data.error)}`);
    }

    // Log usage info
    if (data.usage) {
      const reasoningTokens = data.usage.completion_tokens_details?.reasoning_tokens || 0;
      log(LOG_PREFIX.API, `${tag} tokens: prompt=${data.usage.prompt_tokens}, completion=${data.usage.completion_tokens}, reasoning=${reasoningTokens}, total=${data.usage.total_tokens}`);
    }

    return data;
  } catch (error: any) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    if (error.name === "FetchError" || error.code === "ETIMEDOUT" || error.code === "ESOCKETTIMEDOUT") {
      log(LOG_PREFIX.ERR, `${tag} Network timeout after ${elapsed}s: ${error.message}`);
    } else {
      log(LOG_PREFIX.ERR, `${tag} Failed after ${elapsed}s: ${error.message}`);
    }
    throw error;
  }
}

async function callAPIWithRetry(body: any, label = ""): Promise<any> {
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 1) {
        log(LOG_PREFIX.API, `[${label}] Retry attempt ${attempt}/${maxRetries}...`);
      }
      return await callAPI(body, 300000, `${label}#${attempt}`);
    } catch (error: any) {
      if (attempt === maxRetries) {
        log(LOG_PREFIX.ERR, `[${label}] All ${maxRetries} attempts failed`);
        throw error;
      }
      const wait = attempt * 5000;
      log(LOG_PREFIX.WARN, `[${label}] Waiting ${wait}ms before retry...`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

// ═══════════════════════════════════════════════════════════════
//  Execute chat_agent tool (call non-thinking model)
// ═══════════════════════════════════════════════════════════════
async function executeTool(args: any, label = ""): Promise<string> {
  const {
    input_text,
    system_prompt,
    temperature = 0.7,
    top_p = 0.9,
    max_tokens = 4096,
    stop = ["\n\n"],
    seed,
  } = args;

  const messages = system_prompt
    ? [{ role: "system", content: system_prompt }, { role: "user", content: input_text }]
    : [{ role: "user", content: input_text }];

  log(LOG_PREFIX.TOOL, `${label} Executing: temperature=${temperature}, top_p=${top_p}, max_tokens=${max_tokens}, seed=${seed ?? "none"}, system_prompt=${system_prompt ? "yes" : "no"}`);
  log(LOG_PREFIX.TOOL, `${label} input_text: ${input_text.substring(0, 300)}${input_text.length > 300 ? "..." : ""}`);

  const body: any = {
    model: config.model,
    messages,
    temperature,
    max_tokens,
    top_p,
    stop,
  };
  if (seed !== undefined) {
    body.seed = seed;
  }

  const data = await callAPIWithRetry(body, `${label}-tool`);

  const content = data.choices?.[0]?.message?.content || "";
  log(LOG_PREFIX.TOOL, `${label} Result (${content.length} chars): ${content.substring(0, 300)}${content.length > 300 ? "..." : ""}`);

  return content;
}

// ═══════════════════════════════════════════════════════════════
//  One thinking turn
// ═══════════════════════════════════════════════════════════════
let turnCounter = 0;

async function thinkingTurn(
  messages: any[],
  mode: "with-tool" | "without-tool",
  label = ""
): Promise<any> {
  turnCounter++;
  const startTime = Date.now();
  const tag = `${label}#T${turnCounter}`;

  log(LOG_PREFIX.TURN, `${"=".repeat(50)}`);
  log(LOG_PREFIX.TURN, `${tag} Mode=${mode}, Messages=${messages.length}`);
  log(LOG_PREFIX.TURN, `${tag} Last message role=${messages[messages.length - 1]?.role}`);
  log(LOG_PREFIX.TURN, `${tag} Starting thinking turn...`);

  const body: any = {
    model: config.model,
    messages,
    enable_thinking: true,
    stream: false,
  };

  if (mode === "with-tool") {
    body.tools = [TOOL_DEF];
  }

  const data = await callAPIWithRetry(body, tag);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log(LOG_PREFIX.TURN, `${tag} Turn completed in ${elapsed}s`);

  const msg = data.choices?.[0]?.message;
  const reasoning = (msg as any)?.reasoning_content || "";
  const reasoningTokens = data.usage?.completion_tokens_details?.reasoning_tokens || 0;

  log(LOG_PREFIX.TURN, `${tag} Reasoning tokens: ${reasoningTokens}`);
  if (reasoning) {
    log(LOG_PREFIX.TURN, `${tag} Reasoning content (${reasoning.length} chars):`);
    // Print reasoning in chunks for readability
    const lines = reasoning.split("\n");
    for (const line of lines) {
      console.log(`  | ${line}`);
    }
  }

  if (msg?.tool_calls) {
    log(LOG_PREFIX.TURN, `${tag} Tool calls: ${msg.tool_calls.length}`);
    const toolResults: any[] = [];
    for (let i = 0; i < msg.tool_calls.length; i++) {
      const tc = msg.tool_calls[i];
      const toolTag = `${tag}-TC${i + 1}`;
      log(LOG_PREFIX.TOOL, `${toolTag} Name=${tc.function.name}, ID=${tc.id}`);
      log(LOG_PREFIX.TOOL, `${toolTag} Arguments: ${tc.function.arguments}`);

      const result = await executeTool(JSON.parse(tc.function.arguments), toolTag);
      toolResults.push({ call: tc, result });
    }
    log(LOG_PREFIX.TURN, `${tag} All tool calls completed`);
    return { message: msg, reasoning, toolResults, reasoningTokens, elapsed };
  }

  log(LOG_PREFIX.TURN, `${tag} No tool calls. Content (${msg?.content?.length || 0} chars):`);
  if (msg?.content) {
    const lines = msg.content.split("\n");
    for (const line of lines) {
      console.log(`  | ${line}`);
    }
  }

  return { message: msg, reasoning, toolResults: [], reasoningTokens, elapsed };
}

// ═══════════════════════════════════════════════════════════════
//  Save results
// ═══════════════════════════════════════════════════════════════
function saveResults(mode: string, tag: string, conversation: any[], summary?: any) {
  if (!fs.existsSync(RESULTS_DIR)) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const baseName = `${mode}-${tag}-${timestamp}`;

  // Save detailed JSON
  const rawFile = path.join(RESULTS_DIR, `${baseName}.json`);
  const record = {
    mode,
    tag,
    timestamp: new Date().toISOString(),
    config: { model: config.model, baseUrl: config.baseUrl },
    summary,
    conversation,
  };
  fs.writeFileSync(rawFile, JSON.stringify(record, null, 2));
  log(LOG_PREFIX.DONE, `Raw JSON: ${rawFile}`);

  // Save readable Markdown
  const mdFile = path.join(RESULTS_DIR, `${baseName}.md`);
  let md = `# ${mode === "with-tool" ? "🛠️ With chat_agent Tool" : "💭 Pure Thinking"} — ${tag}\n\n`;
  md += `**Time:** ${new Date().toISOString()}\n`;
  md += `**Model:** ${config.model}\n\n`;
  md += `---\n\n`;

  for (const entry of conversation) {
    switch (entry.type) {
      case "meta":
        md += `## ⚙️ ${entry.label}\n\n`;
        if (entry.details) {
          md += "```\n" + JSON.stringify(entry.details, null, 2) + "\n```\n\n";
        }
        break;
      case "system":
        md += `## System Prompt\n\n${entry.content}\n\n---\n\n`;
        break;
      case "user":
        md += `## 👤 User\n\n${entry.content}\n\n---\n\n`;
        break;
      case "reasoning":
        md += `## 🧠 Reasoning (${entry.tokenCount || "?"} tokens)\n\n${entry.content}\n\n---\n\n`;
        break;
      case "tool_call":
        md += `### 🔧 Tool Call: ${entry.name}\n`;
        md += `- **Params:** temperature=${entry.args.temperature}, top_p=${entry.args.top_p}\n`;
        md += `- **input_text:** ${truncate(entry.args.input_text, 200)}\n\n`;
        break;
      case "tool_result":
        md += `### 📎 Tool Result\n\n${truncate(entry.content, 1000)}\n\n`;
        break;
      case "assistant":
        md += `## 🤖 Assistant\n\n${entry.content}\n\n---\n\n`;
        break;
      case "timing":
        md += `## ⏱️ Timing\n\n- **Elapsed:** ${entry.elapsed || "?"}s\n`;
        md += `- **Reasoning tokens:** ${entry.reasoningTokens || "?"}\n`;
        if (entry.toolCalls !== undefined) md += `- **Tool calls:** ${entry.toolCalls}\n`;
        md += "\n";
        break;
    }
  }

  if (summary) {
    md += `## 📊 Summary\n\n`;
    md += `| Metric | Value |\n|--------|:-----:|\n`;
    md += `| Total turns | ${summary.totalTurns} |\n`;
    md += `| Tool calls | ${summary.totalToolCalls} |\n`;
    md += `| Total reasoning tokens | ${summary.totalReasoningTokens} |\n`;
    md += `| Total time | ${summary.totalElapsed}s |\n`;
    md += `| Final answer length | ${summary.finalAnswerLen} chars |\n`;
  }

  fs.writeFileSync(mdFile, md);
  log(LOG_PREFIX.DONE, `Markdown: ${mdFile}`);

  return { rawFile, mdFile };
}

function truncate(s: string, max: number): string {
  if (!s) return "";
  return s.length > max ? s.substring(0, max) + "..." : s;
}

// ═══════════════════════════════════════════════════════════════
//  Run single test mode
// ═══════════════════════════════════════════════════════════════
async function runTest(mode: "with-tool" | "without-tool") {
  const border = mode === "with-tool" ? "🛠️" : "💭";
  console.log(`\n${border}${"=".repeat(70)}`);
  log(LOG_PREFIX.INFO, `Starting test mode: ${mode}`);
  console.log(`${border}${"=".repeat(70)}`);

  turnCounter = 0;
  const conversation: any[] = [];
  const startTestTime = Date.now();

  const systemMsg = `你是一个思考模型，使用深度推理来解决问题。${
    mode === "with-tool"
      ? `\n\n你可以使用 chat_agent 工具来辅助你的思考过程：
chat_agent 调用独立、非思考模型执行子任务。你需要构建一个**完整、自包含**的 input_text，
包含任务类型（推理/联想/类比/创意/评估等）以及所有必要的上下文信息。
工具不依赖对话历史，所以请把所有关键信息都放进 input_text。

策略建议：
- **低 temperature(0.1-0.3)**：精确校验、事实核查、数学计算
- **高 temperature(0.7-1.5)**：发散思维、创意探索、多角度分析
- **中等(0.4-0.7)**：一般推理任务

参数说明：
- **system_prompt**：可选，用于设定工具模型的角色（如"你是一个严谨的数学校验员"）
- **seed**：可选，配合低 temperature 可实现输出复现，适合校验类任务
- **stop**：默认 ["\n\n"]，防止非思考模型自动续写，可按需覆盖

当你需要延长思维链时，调用 chat_agent 外包部分推理。
重要：用户提供的蓝图内容已经直接嵌入在对话中，请直接分析，不要再询问文件路径。`
      : "你只能依靠自身的推理能力来回答问题。注意：蓝图内容已直接嵌入在对话中，请直接分析。"
  }`;

  conversation.push({ type: "system", content: systemMsg });
  conversation.push({ type: "user", content: buildTestPrompt() });

  const messages: any[] = [
    { role: "system", content: systemMsg },
    { role: "user", content: buildTestPrompt() },
  ];

  log(LOG_PREFIX.INFO, `System prompt set, user prompt with blueprint embedded (${BLUEPRINT_CONTENT.length} chars)`);

  let result = await thinkingTurn(messages, mode, mode);
  let rounds = 0;
  const MAX_ROUNDS = 5;

  // Record timing for first turn
  conversation.push({
    type: "timing",
    elapsed: result.elapsed,
    reasoningTokens: result.reasoningTokens,
    toolCalls: result.toolResults.length,
  });

  let totalToolCalls = result.toolResults.length;
  let totalReasoningTokens = result.reasoningTokens || 0;
  let totalElapsed = parseFloat(result.elapsed || "0");

  while (result.toolResults.length > 0 && rounds < MAX_ROUNDS) {
    rounds++;
    log(LOG_PREFIX.TURN, `Tool call round ${rounds}/${MAX_ROUNDS}`);

    // Record reasoning before tool calls
    if (result.reasoning) {
      conversation.push({ type: "reasoning", content: result.reasoning, tokenCount: result.reasoningTokens });
    }

    // Record tool calls
    for (const tr of result.toolResults) {
      const args = JSON.parse(tr.call.function.arguments);
      conversation.push({
        type: "tool_call",
        name: tr.call.function.name,
        args,
      });
      conversation.push({
        type: "tool_result",
        content: tr.result,
      });
    }

    // Build the assistant + tool messages for API
    const assistantMsg: any = {
      role: "assistant",
      content: null,
      tool_calls: result.toolResults.map((tr: any) => ({
        id: tr.call.id,
        type: "function",
        function: { name: tr.call.function.name, arguments: tr.call.function.arguments },
      })),
    };
    messages.push(assistantMsg);

    for (const tr of result.toolResults) {
      messages.push({ role: "tool", tool_call_id: tr.call.id, content: tr.result });
    }

    // Next thinking turn
    result = await thinkingTurn(messages, mode, mode);
    totalToolCalls += result.toolResults.length;
    totalReasoningTokens += result.reasoningTokens || 0;
    totalElapsed += parseFloat(result.elapsed || "0");

    conversation.push({
      type: "timing",
      elapsed: result.elapsed,
      reasoningTokens: result.reasoningTokens,
      toolCalls: result.toolResults.length,
    });
  }

  // Final answer
  if (result.message?.content) {
    conversation.push({ type: "assistant", content: result.message.content });
  }
  if (result.reasoning) {
    conversation.push({ type: "reasoning", content: result.reasoning, tokenCount: result.reasoningTokens });
  }

  // Summary
  const testElapsed = ((Date.now() - startTestTime) / 1000).toFixed(1);
  const summary = {
    totalTurns: turnCounter,
    totalToolCalls,
    totalReasoningTokens,
    totalElapsed: testElapsed,
    finalAnswerLen: result.message?.content?.length || 0,
  };

  log(LOG_PREFIX.DONE, `${"=".repeat(50)}`);
  log(LOG_PREFIX.DONE, `Mode ${mode} completed in ${testElapsed}s`);
  log(LOG_PREFIX.DONE, `Total turns: ${turnCounter}, tool calls: ${totalToolCalls}, reasoning tokens: ${totalReasoningTokens}`);
  log(LOG_PREFIX.DONE, `${"=".repeat(50)}`);

  const files = saveResults(mode, "blueprint-review", conversation, summary);
  return { conversation, ...files, summary };
}

// ═══════════════════════════════════════════════════════════════
//  Generate comparison analysis
// ═══════════════════════════════════════════════════════════════
function generateComparison(without: any, withTool: any) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const compFile = path.join(RESULTS_DIR, `comparison-analysis-${timestamp}.md`);

  const w = without.summary;
  const t = withTool.summary;

  let md = `# 📊 Comparative Analysis: Pure Thinking vs Thinking + chat_agent Tool\n\n`;
  md += `## Overview\n\n`;
  md += `| | Pure Thinking | With Tool |\n`;
  md += `|---|---|---|\n`;
  md += `| **Model** | ${config.model} | ${config.model} |\n`;
  md += `| **Total time** | ${w.totalElapsed}s | ${t.totalElapsed}s |\n`;
  md += `| **Total turns** | ${w.totalTurns} | ${t.totalTurns} |\n`;
  md += `| **Tool calls** | ${w.totalToolCalls} | ${t.totalToolCalls} |\n`;
  md += `| **Reasoning tokens** | ${w.totalReasoningTokens} | ${t.totalReasoningTokens} |\n`;
  md += `| **Final answer length** | ${w.finalAnswerLen} chars | ${t.finalAnswerLen} chars |\n\n`;

  md += `## Source Files\n\n`;
  md += `- [Pure Thinking](${path.basename(without.mdFile)})\n`;
  md += `- [With Tool](${path.basename(withTool.mdFile)})\n\n`;

  // Analysis
  md += `## Analysis\n\n`;

  if (t.totalToolCalls > w.totalToolCalls) {
    md += `### Reasoning Depth\n`;
    md += `The tool-assisted mode used ${t.totalToolCalls} tool call(s) vs ${w.totalToolCalls} in pure mode. `;
    if (t.totalReasoningTokens > w.totalReasoningTokens) {
      md += `Reasoning tokens increased from ${w.totalReasoningTokens} to ${t.totalReasoningTokens}, `;
      md += `suggesting the tool helped extend the thinking chain.\n\n`;
    }
  }

  md += `### Tool Utilization\n`;
  md += t.totalToolCalls > 0
    ? `The thinking model actively utilized the chat_agent tool, outsourcing subtasks to the non-thinking model. This demonstrates the tool integration works as designed.\n\n`
    : `The thinking model did not utilize the chat_agent tool in this test. This may indicate the task didn't require external verification, or the model needs more encouragement to use tools.\n\n`;

  md += `### Performance Impact\n`;
  const timeRatio = (t.totalElapsed / Math.max(1, w.totalElapsed)).toFixed(1);
  md += `Tool-assisted mode took ${timeRatio}x longer than pure thinking mode (${t.totalElapsed}s vs ${w.totalElapsed}s). `;
  md += `This is expected due to additional API calls.\n\n`;

  md += `## Conclusion\n\n`;
  md += `*(Analysis to be refined after reviewing actual outputs)*\n`;

  fs.writeFileSync(compFile, md);
  log(LOG_PREFIX.DONE, `Comparison: ${compFile}`);
}

// ═══════════════════════════════════════════════════════════════
//  Main
// ═══════════════════════════════════════════════════════════════
async function main() {
  console.log("╔" + "═".repeat(70) + "╗");
  console.log("║  Batch Test: Thinking Model Comparison — Detailed Logging");
  console.log(`║  Model: ${config.model}`);
  console.log(`║  Blueprint size: ${BLUEPRINT_CONTENT.length} chars`);
  console.log("╚" + "═".repeat(70) + "╝");

  log(LOG_PREFIX.INFO, `Results directory: ${RESULTS_DIR}`);
  log(LOG_PREFIX.INFO, `API endpoint: ${apiUrl}`);

  // Test 1: Without tool - already completed in previous runs
  let withoutResult: any = null;
  try {
    withoutResult = await runTest("without-tool");
  } catch (e: any) {
    log(LOG_PREFIX.WARN, `without-tool test failed: ${e.message} (will skip comparison)`);
  }

  // Test 2: With tool
  const withResult = await runTest("with-tool");

  // Generate comparison
  if (withoutResult) {
    generateComparison(withoutResult, withResult);
  } else {
    log(LOG_PREFIX.WARN, "Skipping comparison - pure thinking result not available");
  }

  console.log("\n" + "=".repeat(70));
  log(LOG_PREFIX.DONE, "ALL TESTS COMPLETED");
  console.log("=".repeat(70));
}

main().catch((error) => {
  log(LOG_PREFIX.ERR, `FATAL: ${error.message}`);
  console.error(error);
  process.exit(1);
});
