/**
 * Quick integration test for chat_agent tool
 * Tests the non-thinking model API call directly
 */

import { handleChatAgentCall } from "../src/chatAgentTool";

async function main() {
  console.log("=== Quick Integration Test for chat_agent ===\n");

  // Test 1: Basic reasoning task
  console.log("--- Test 1: Reasoning task (temperature=0.3) ---");
  const result1 = await handleChatAgentCall({
    input_text: "推理：计算 15 * 37 的值，请给出详细步骤。",
    temperature: 0.3,
    max_tokens: 1024,
  });
  console.log("Raw result:", JSON.stringify(result1));
  if (result1.content && result1.content[0]) {
    const parsed1 = JSON.parse(result1.content[0].text);
    console.log(`Success: ${parsed1.success}`);
    console.log(`Content: ${parsed1.content}`);
    console.log(`Usage: ${JSON.stringify(parsed1.usage)}`);
    console.log(`Model: ${parsed1.model}`);
    if (!parsed1.success) {
      console.log(`Error: ${parsed1.error}`);
    }
  }

  // Test 2: Creative writing
  console.log("\n--- Test 2: Creative (temperature=1.2, top_p=0.95) ---");
  const result2 = await handleChatAgentCall({
    input_text: "创意：请写一首4行短诗，主题关于AI与创造力。",
    temperature: 1.2,
    top_p: 0.95,
    max_tokens: 512,
  });
  if (result2.content && result2.content[0]) {
    const parsed2 = JSON.parse(result2.content[0].text);
    console.log(`Success: ${parsed2.success}`);
    console.log(`Content: ${parsed2.content}`);
  }

  console.log("\n=== All tests completed ===");
}

main().catch(console.error);
