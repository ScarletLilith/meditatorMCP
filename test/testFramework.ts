/**
 * 思考模型对话测试框架
 *
 * 功能：
 * 1. 使用 DeepSeek-V4-Flash 思考模式作为"思考模型"
 * 2. 注册 chat_agent 作为可调用工具
 * 3. 支持交互式对话，记录完整对话历史
 * 4. 保存对话记录到 results/ 目录
 *
 * 使用：npx ts-node test/testFramework.ts [--mode with-tool|without-tool] [--tag <name>]
 */

import "../src/polyfill";
import fetch from "node-fetch";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

// ─── Config ────────────────────────────────────────────────────
interface Config {
  apiKey: string;
  baseUrl: string;
  model: string;
}

function loadConfig(): Config {
  const configPath = path.join(__dirname, "config.json");
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }
  return JSON.parse(fs.readFileSync(configPath, "utf-8"));
}

// ─── Tool Definition ──────────────────────────────────────────
const CHAT_AGENT_TOOL_DEFINITION = {
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
        input_text: {
          type: "string",
          description: "完整、自包含的任务描述。需明确任务类型并提供所有必要的上下文信息，使工具无需依赖外部信息即可独立完成。",
        },
        system_prompt: { type: "string", description: "可选的系统提示词，用于设定角色或行为约束" },
        temperature: { type: "number", description: "0.0-2.0，低=确定，高=发散", default: 0.7 },
        top_p: { type: "number", description: "0.0-1.0", default: 0.9 },
        max_tokens: { type: "number", description: "最大输出token数", default: 4096 },
        stop: { type: "array", items: { type: "string" }, description: "停止序列，默认 ['\\n\\n']", default: ["\n\n"] },
        seed: { type: "number", description: "随机种子，配合低 temperature 实现输出复现" },
      },
      required: ["input_text"],
    },
  },
};

// ─── API Call Helper ───────────────────────────────────────────
function getApiUrl(config: Config): string {
  return config.baseUrl.replace(/\/+$/, "") + "/chat/completions";
}

async function callAPI(config: Config, body: any): Promise<any> {
  const response = await fetch(getApiUrl(config), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  return response.json();
}

// ─── Chat Agent Executor ──────────────────────────────────────
async function executeChatAgent(config: Config, args: any): Promise<string> {
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

  try {
    const data = await callAPI(config, body);
    return data.choices?.[0]?.message?.content || "";
  } catch (error: any) {
    return `[chat_agent error: ${error?.message || String(error)}]`;
  }
}

// ─── Conversation Logger ───────────────────────────────────────
function ensureResultsDir(): string {
  const dir = path.join(__dirname, "..", "results");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function saveConversation(tag: string, mode: string, conversation: any[]) {
  const dir = ensureResultsDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${mode}-${tag}-${timestamp}.json`;
  const filepath = path.join(dir, filename);

  const record = { mode, tag, timestamp: new Date().toISOString(), conversation };
  fs.writeFileSync(filepath, JSON.stringify(record, null, 2), "utf-8");
  console.log(`\n[Saved] ${filepath}`);

  // Markdown version
  const mdFilename = `${mode}-${tag}-${timestamp}.md`;
  const mdFilepath = path.join(dir, mdFilename);
  let md = `# ${mode === "with-tool" ? "With MCP Tool" : "Without MCP Tool"} - ${tag}\n\n`;
  md += `**Time:** ${record.timestamp}\n\n`;

  for (const msg of conversation) {
    const role = msg.role.toUpperCase();
    if (msg.content) {
      md += `### ${role}\n\n${msg.content}\n\n`;
    }
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        md += `### TOOL CALL: ${tc.function.name}\n\`\`\`json\n${JSON.stringify(JSON.parse(tc.function.arguments), null, 2)}\n\`\`\`\n\n`;
      }
    }
    if (msg.tool_result) {
      md += `### TOOL RESULT\n\n${msg.tool_result}\n\n`;
    }
    if (msg.reasoning) {
      md += `### REASONING\n\n${msg.reasoning}\n\n`;
    }
  }

  fs.writeFileSync(mdFilepath, md, "utf-8");
  console.log(`[Saved] ${mdFilepath}`);
}

// ─── Thinking Model Chat ──────────────────────────────────────
async function thinkingModelChat(
  config: Config,
  userInput: string,
  conversation: any[],
  mode: "with-tool" | "without-tool"
): Promise<{ message: string; toolCalls: any[] }> {
  const messages: any[] = [
    {
      role: "system",
      content: `你是一个思考模型，使用深度推理来解决问题。${
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
- **seed**：可选，配合低 temperature 实现输出复现，适合校验类任务
- **stop**：默认 ["\n\n"]，防止非思考模型自动续写，可按需覆盖

当你需要延长思维链时，调用 chat_agent 外包部分推理。`
          : "你只能依靠自身的推理能力来回答问题。"
      }`,
    },
  ];

  for (const msg of conversation) {
    if (msg.role === "user") {
      messages.push({ role: "user", content: msg.content });
    } else if (msg.role === "assistant") {
      const m: any = { role: "assistant", content: msg.content || null };
      if (msg.tool_calls) {
        m.tool_calls = msg.tool_calls;
      }
      messages.push(m);
    } else if (msg.role === "tool") {
      messages.push({ role: "tool", tool_call_id: msg.tool_call_id, content: msg.content });
    }
  }

  messages.push({ role: "user", content: userInput });

  const body: any = {
    model: config.model,
    messages,
    enable_thinking: true,
    stream: false,
  };

  if (mode === "with-tool") {
    body.tools = [CHAT_AGENT_TOOL_DEFINITION];
  }

  try {
    const data = await callAPI(config, body);
    const choice = data.choices?.[0];
    const message = choice?.message;

    const result: { message: string; toolCalls: any[] } = { message: "", toolCalls: [] };
    const reasoningContent = (message as any)?.reasoning_content || "";

    if (message?.content) {
      result.message = message.content;
    }

    if (message?.tool_calls) {
      for (const tc of message.tool_calls) {
        if (tc.function.name === "chat_agent") {
          const args = JSON.parse(tc.function.arguments);
          console.log(`\n[tool call] temperature=${args.temperature}, top_p=${args.top_p}`);
          console.log(`  input_text: ${args.input_text?.substring(0, 150)}...`);

          const toolResult = await executeChatAgent(config, args);
          console.log(`  result: ${toolResult.substring(0, 150)}...`);

          result.toolCalls.push({
            id: tc.id,
            function: { name: "chat_agent", arguments: tc.function.arguments },
            result: toolResult,
            reasoning_content: reasoningContent,
          });
        }
      }
    }

    (result as any).reasoning_content = reasoningContent;
    return result;
  } catch (error: any) {
    console.error("API Error:", error?.message || error);
    return { message: `[API Error: ${error?.message || String(error)}]`, toolCalls: [] };
  }
}

// ─── Interactive Main Loop ─────────────────────────────────────
async function main() {
  const config = loadConfig();
  const mode = process.argv.includes("--mode")
    ? (process.argv[process.argv.indexOf("--mode") + 1] as "with-tool" | "without-tool")
    : "with-tool";
  const tag = process.argv.includes("--tag")
    ? process.argv[process.argv.indexOf("--tag") + 1]
    : `test-${Date.now()}`;

  console.log("================================================");
  console.log("  思考模型对话测试框架 v1.0");
  console.log(`  模型: ${config.model}`);
  console.log(`  模式: ${mode === "with-tool" ? "With chat_agent Tool" : "Pure Thinking"}`);
  console.log("================================================");
  console.log("  Commands: quit=exit, save=save conversation");
  console.log("");

  const conversation: any[] = [];
  let turnCount = 0;
  const MAX_TOOL_CALLS_PER_TURN = 20;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, resolve));

  try {
    while (true) {
      const userInput = await ask("\nYou: ");
      if (userInput.toLowerCase() === "quit") break;
      if (userInput.toLowerCase() === "save") {
        saveConversation(tag, mode, conversation);
        continue;
      }

      turnCount++;
      console.log(`\nThinking (turn ${turnCount})...`);

      conversation.push({ role: "user", content: userInput });

      let currentResult = await thinkingModelChat(config, "", conversation, mode);
      let safetyCounter = 0;

      while (currentResult.toolCalls.length > 0) {
        safetyCounter++;
        if (safetyCounter > MAX_TOOL_CALLS_PER_TURN) {
          console.error("\n[Safety limit: too many tool calls]");
          conversation.push({ role: "assistant", content: "[Tool call loop terminated: safety limit]" });
          break;
        }

        conversation.push({
          role: "assistant",
          content: null,
          tool_calls: currentResult.toolCalls.map((tc: any) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.function.name, arguments: tc.function.arguments },
          })),
        });

        for (const tc of currentResult.toolCalls) {
          conversation.push({ role: "tool", tool_call_id: tc.id, content: tc.result });
        }

        console.log("  Processing tool results...");
        currentResult = await thinkingModelChat(config, "", conversation, mode);
      }

      const finalMsg: any = { role: "assistant", content: currentResult.message };
      if ((currentResult as any).reasoning_content) {
        finalMsg.reasoning_content = (currentResult as any).reasoning_content;
      }
      conversation.push(finalMsg);

      if ((currentResult as any).reasoning_content) {
        console.log(`\n[Reasoning]\n${(currentResult as any).reasoning_content}`);
      }
      console.log(`\n[Assistant]\n${currentResult.message}`);
    }
  } finally {
    rl.close();
    if (conversation.length > 0) {
      saveConversation(tag, mode, conversation);
    }
  }
}

main().catch(console.error);
