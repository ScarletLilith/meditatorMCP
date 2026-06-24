/**
 * Quick test to verify thinking model API response
 */
import "../src/polyfill";
import * as fs from "fs";
import * as path from "path";

const config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf-8"));
const apiUrl = config.baseUrl.replace(/\/+$/, "") + "/chat/completions";
const fetch = (globalThis as any).fetch;

async function main() {
  console.log(`Testing thinking mode with ${config.model}...`);
  console.log(`API URL: ${apiUrl}`);

  const body = {
    model: config.model,
    messages: [
      { role: "system", content: "You are a helpful thinking assistant." },
      { role: "user", content: "What is 23 * 47? Think step by step." },
    ],
    enable_thinking: true,
    stream: false,
    max_tokens: 8192,
  };

  console.log("Sending request...");
  const start = Date.now();

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      timeout: 120000, // 2 min timeout
    });

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`Response received in ${elapsed}s, status: ${response.status}`);

    const data = await response.json();
    const choice = data.choices?.[0];
    const msg = choice?.message;

    console.log(`\nContent: ${msg?.content?.substring(0, 300)}`);
    console.log(`Reasoning: ${(msg as any)?.reasoning_content?.substring(0, 200)}`);
    console.log(`Usage: ${JSON.stringify(data.usage)}`);
    console.log(`Finish reason: ${choice?.finish_reason}`);

    if (msg?.tool_calls) {
      console.log(`Tool calls: ${msg.tool_calls.length}`);
    }
  } catch (error: any) {
    console.error(`Error after ${((Date.now() - start) / 1000).toFixed(1)}s:`, error.message);
  }
}

main().catch(console.error);
