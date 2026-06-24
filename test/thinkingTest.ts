/**
 * Thinking model test - check if DeepSeek-V4-Flash supports tool calling in thinking mode
 */
import fetch from "node-fetch";
import * as fs from "fs";
import * as path from "path";

const config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf-8"));
const apiUrl = config.baseUrl.replace(/\/+$/, "") + "/chat/completions";

async function callThinkingModel(messages: any[], tools?: any[]) {
  const body: any = {
    model: config.model,
    messages,
    enable_thinking: true,
    stream: false,
  };
  if (tools) body.tools = tools;

  const res = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function main() {
  console.log("=== Test 1: Thinking model WITHOUT tools ===");
  const res1 = await callThinkingModel([
    { role: "system", content: "You are a helpful assistant with deep reasoning." },
    { role: "user", content: "What is 15 * 37? Verify your answer step by step." },
  ]);
  const msg1 = res1.choices?.[0]?.message;
  console.log("Content:", msg1?.content?.substring(0, 300));
  console.log("Tool calls:", msg1?.tool_calls ? "YES" : "NONE");
  console.log("Reasoning:", (msg1 as any)?.reasoning_content?.substring(0, 200) || "NONE");
  console.log("Usage:", JSON.stringify(res1.usage));
  console.log("");

  console.log("=== Test 2: Thinking model WITH tools available ===");
  const chatAgentTool = {
    type: "function",
    function: {
      name: "chat_agent",
      description: "Non-thinking model for verification tasks",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          temperature: { type: "number" },
        },
        required: ["prompt"],
      },
    },
  };

  const res2 = await callThinkingModel(
    [
      {
        role: "system",
        content:
          "You are a thinking model. You can use the chat_agent tool to verify calculations. When you need to verify, call the tool with a low temperature.",
      },
      {
        role: "user",
        content: "What is 23 * 47? Calculate and then use the tool to verify.",
      },
    ],
    [chatAgentTool]
  );
  const msg2 = res2.choices?.[0]?.message;
  console.log("Content:", msg2?.content?.substring(0, 300) || "(empty/null)");
  console.log("Tool calls:", msg2?.tool_calls ? "YES" : "NONE");
  if (msg2?.tool_calls) {
    for (const tc of msg2.tool_calls) {
      console.log(`  Tool: ${tc.function.name}`);
      console.log(`  Args: ${tc.function.arguments}`);
    }
  }
  console.log("Reasoning:", (msg2 as any)?.reasoning_content?.substring(0, 200) || "NONE");
  console.log("");

  // If tool call, simulate response
  if (msg2?.tool_calls) {
    console.log("=== Test 3: Following up after tool result ===");
    const toolResult = await executeTool(msg2.tool_calls[0]);
    console.log("Tool result:", toolResult);

    const res3 = await callThinkingModel([
      {
        role: "system",
        content:
          "You are a thinking model. You can use the chat_agent tool to verify calculations.",
      },
      { role: "user", content: "What is 23 * 47? Calculate and then use the tool to verify." },
      {
        role: "assistant",
        content: null,
        tool_calls: msg2.tool_calls,
      },
      {
        role: "tool",
        tool_call_id: msg2.tool_calls[0].id,
        content: toolResult,
      },
    ]);
    const msg3 = res3.choices?.[0]?.message;
    console.log("Final content:", msg3?.content?.substring(0, 500));
  }
}

async function executeTool(tc: any): Promise<string> {
  const args = JSON.parse(tc.function.arguments);
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: "user", content: args.prompt }],
      temperature: args.temperature ?? 0.3,
      max_tokens: 2048,
    }),
  });
  const data: any = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

main().catch(console.error);
