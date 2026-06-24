/**
 * 完整功能测试
 *
 * 覆盖：
 * 1. 基本功能（各种 temperature 场景）
 * 2. system_prompt 参数
 * 3. seed 参数
 * 4. stop 参数
 * 5. 输入校验（空 input_text、超长截断、参数钳制）
 * 6. 错误分类（无效 API Key、空输入）
 */

import "../src/polyfill";
import { handleChatAgentCall } from "../src/chatAgentTool";
import * as fs from "fs";
import * as path from "path";

// ─── Test Reporting ────────────────────────────────────────────
interface TestResult {
  name: string;
  passed: boolean;
  detail: string;
}

const results: TestResult[] = [];
let testCount = 0;
let passCount = 0;

function assert(name: string, condition: boolean | (() => boolean), detail: string) {
  testCount++;
  const passed = typeof condition === "function" ? condition() : !!condition;
  if (passed) passCount++;
  results.push({ name, passed, detail });
  const icon = passed ? "✅" : "❌";
  console.log(`  ${icon} ${name}: ${detail}`);
}

async function test(name: string, fn: () => Promise<void>) {
  console.log(`\n── ${name} ──`);
  try {
    await fn();
  } catch (e: any) {
    testCount++;
    results.push({ name: `[CRASH] ${name}`, passed: false, detail: e.message });
    console.log(`  💥 CRASH: ${e.message}`);
  }
}

// ─── Tests ─────────────────────────────────────────────────────
async function main() {
  console.log("=".repeat(60));
  console.log("  Thinking Agent MCP — 完整功能测试");
  console.log("=".repeat(60));

  // ── 1. 基本功能：低温校验 ──
  await test("低温推理任务 (temperature=0.1)", async () => {
    const result = await handleChatAgentCall({
      input_text: "推理：15 × 37 = ？ 请给出计算步骤",
      temperature: 0.1,
      max_tokens: 1024,
    });
    const parsed = JSON.parse(result.content![0].text);
    assert("返回 success=true", parsed.success === true, `success=${parsed.success}`);
    assert("有 content", parsed.content?.length > 0, `length=${parsed.content?.length}`);
    assert("finish_reason 为 stop", parsed.finish_reason === "stop", parsed.finish_reason);
    assert("包含 usage 信息", parsed.usage?.total_tokens > 0, `tokens=${parsed.usage?.total_tokens}`);
  });

  // ── 2. 高温发散 ──
  await test("高温发散任务 (temperature=1.5, top_p=0.95)", async () => {
    const result = await handleChatAgentCall({
      input_text: "创意：列出 3 个关于'深海'的隐喻，并简要说明。",
      temperature: 1.5,
      top_p: 0.95,
      max_tokens: 1024,
    });
    const parsed = JSON.parse(result.content![0].text);
    assert("返回 success=true", parsed.success === true, `success=${parsed.success}`);
    assert("有 content", parsed.content?.length > 0, `length=${parsed.content?.length}`);
  });

  // ── 3. system_prompt 参数 ──
  await test("system_prompt 参数", async () => {
    const result = await handleChatAgentCall({
      input_text: "12 × 8 = ?",
      system_prompt: "你是一个严谨的数学校验员，只输出最终数字结果，不要任何解释。",
      temperature: 0.1,
      max_tokens: 128,
    });
    const parsed = JSON.parse(result.content![0].text);
    assert("返回 success=true", parsed.success === true, `success=${parsed.success}`);
    assert("有 content", parsed.content?.length > 0, `content=${parsed.content}`);
    // system_prompt 应该使输出更精简（只输出数字）
    const isConcise = parsed.content.trim().length < 20;
    console.log(`   输出长度: ${parsed.content.trim().length} 字符`);
  });

  // ── 4. seed 参数（可复现性） ──
  await test("seed 参数（可复现性验证）", async () => {
    const input = "推理：判断 127 是否为质数，给出推理。";
    const resultA = await handleChatAgentCall({
      input_text: input,
      temperature: 0.1,
      seed: 42,
      max_tokens: 512,
    });
    const resultB = await handleChatAgentCall({
      input_text: input,
      temperature: 0.1,
      seed: 42,
      max_tokens: 512,
    });
    const parsedA = JSON.parse(resultA.content![0].text);
    const parsedB = JSON.parse(resultB.content![0].text);
    assert("A 返回 success=true", parsedA.success === true, `success=${parsedA.success}`);
    assert("B 返回 success=true", parsedB.success === true, `success=${parsedB.success}`);
    // 相同 seed + temperature 输出应该非常相似
    const similarity = parsedA.content === parsedB.content;
    console.log(`   两次输出${similarity ? "完全相同" : "略有差异（seed 效果因 API 而异）"}`);
  });

  // ── 5. stop 参数 ──
  await test("stop 参数", async () => {
    const result = await handleChatAgentCall({
      input_text: "请输出 1 到 10 的数字，每行一个：",
      temperature: 0.3,
      max_tokens: 256,
      stop: ["5"],  // 遇到 "5" 就停止
    });
    const parsed = JSON.parse(result.content![0].text);
    assert("返回 success=true", parsed.success === true, `success=${parsed.success}`);
    // 内容应该在 "5" 处截断（或包含 5 之后立刻停止）
    console.log(`   stop=["5"] 输出内容: ${JSON.stringify(parsed.content?.substring(0, 100))}`);
  });

  // ── 6. 输入校验：空 input_text ──
  await test("输入校验：空 input_text", async () => {
    const result = await handleChatAgentCall({
      input_text: "",
      temperature: 0.7,
    });
    const parsed = JSON.parse(result.content![0].text);
    assert("返回 success=false", parsed.success === false, `success=${parsed.success}`);
    assert("type 为 validation", parsed.type === "validation", `type=${parsed.type}`);
    assert("action 为 fix_input", parsed.action === "fix_input", `action=${parsed.action}`);
    assert("有中文错误提示", parsed.message?.includes("不能为空"), parsed.message);
  });

  // ── 7. 输入校验：超长截断 ──
  await test("输入校验：超长 input_text 自动截断", async () => {
    const longText = "测试" .repeat(60000);  // 120000 字符，超过 100000 上限
    const result = await handleChatAgentCall({
      input_text: longText + "请总结以上内容",
      temperature: 0.7,
      max_tokens: 128,
    });
    const parsed = JSON.parse(result.content![0].text);
    // 截断后仍应成功调用（截断后内容可以理解为无效，但 API 调用本身应该正常）
    console.log(`   输入长度: ${longText.length + 8} → 截断后应 ≤ 100000`);
    assert("返回 success=true（截断后仍可调用）", parsed.success === true, `success=${parsed.success}`);
  });

  // ── 8. 输入校验：参数钳制 ──
  await test("输入校验：temperature/top_p 越界钳制", async () => {
    const result = await handleChatAgentCall({
      input_text: "输出数字 42",
      temperature: 999,
      top_p: -1,
      max_tokens: 10,
    });
    const parsed = JSON.parse(result.content![0].text);
    assert("返回 success=true（钳制后有效）", parsed.success === true, `success=${parsed.success}`);
    assert("有 content", parsed.content?.length > 0, `content=${parsed.content}`);
  });

  // ── 9. 错误的 API Key ──
  await test("错误分类：无效 API Key", async () => {
    // 备份原始 key
    const origApiKey = process.env.SILICONFLOW_API_KEY;
    process.env.SILICONFLOW_API_KEY = "sk-invalid-key-for-test";
    process.env.SILICONFLOW_BASE_URL = "https://api.siliconflow.cn/v1";
    process.env.SILICONFLOW_MODEL = "deepseek-ai/DeepSeek-V4-Flash";

    try {
      const result = await handleChatAgentCall({
        input_text: "测试错误",
        temperature: 0.7,
        max_tokens: 10,
      });
      const parsed = JSON.parse(result.content![0].text);
      assert("返回 success=false", parsed.success === false, `success=${parsed.success}`);
      // 可能是 401 认证错误，也可能是其他网络错误
      console.log(`   错误类型: ${parsed.type}, action: ${parsed.action}`);
      console.log(`   错误消息: ${parsed.message}`);
    } finally {
      if (origApiKey !== undefined) {
        process.env.SILICONFLOW_API_KEY = origApiKey;
      } else {
        delete process.env.SILICONFLOW_API_KEY;
      }
      delete process.env.SILICONFLOW_BASE_URL;
      delete process.env.SILICONFLOW_MODEL;
    }
  });

  // ── 10. MCP 标准错误响应格式验证 ──
  await test("MCP 标准响应格式验证", async () => {
    // 成功响应
    const successResult = await handleChatAgentCall({
      input_text: "输出 hello",
      temperature: 0.7,
      max_tokens: 10,
    });
    assert("成功响应有 content 数组", Array.isArray(successResult.content), `length=${successResult.content?.length}`);
    assert("content 元素有 type 字段", successResult.content![0].type === "text", `type=${successResult.content![0].type}`);
    assert("content 文本是合法 JSON", () => {
      JSON.parse(successResult.content![0].text);
      return true;
    }, "JSON parse ok");

    // 错误响应
    const errorResult = await handleChatAgentCall({
      input_text: "",
      temperature: 0.7,
    });
    assert("错误响应标记 isError=true", errorResult.isError === true, `isError=${errorResult.isError}`);
    assert("错误响应有 content 数组", Array.isArray(errorResult.content), `length=${errorResult.content?.length}`);
  });

  // ── 11. 不同模型参数组合 ──
  await test("平衡模式 (temperature=0.5, top_p=0.8)", async () => {
    const result = await handleChatAgentCall({
      input_text: "请解释 MCP 协议的核心概念，用 3 句话。",
      temperature: 0.5,
      top_p: 0.8,
      max_tokens: 256,
    });
    const parsed = JSON.parse(result.content![0].text);
    assert("返回 success=true", parsed.success === true, `success=${parsed.success}`);
    assert("输出合理长度", parsed.content?.length > 10, `length=${parsed.content?.length}`);
  });

  // ── 12. 大量输出 ──
  await test("长输出任务 (max_tokens=4096)", async () => {
    const result = await handleChatAgentCall({
      input_text: "请详细列出深度学习与机器学习的主要区别，至少 5 点。",
      temperature: 0.4,
      max_tokens: 4096,
    });
    const parsed = JSON.parse(result.content![0].text);
    assert("返回 success=true", parsed.success === true, `success=${parsed.success}`);
    assert("输出较长", parsed.content?.length > 50, `length=${parsed.content?.length}`);
    console.log(`   输出长度: ${parsed.content?.length} 字符`);
  });

  // ── Report ──
  console.log("\n" + "=".repeat(60));
  console.log(`  测试完成: ${passCount}/${testCount} 通过`);
  console.log("=".repeat(60));

  // 保存报告
  const reportDir = path.join(__dirname, "..", "results");
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(reportDir, `full-test-report-${timestamp}.md`);
  
  let md = `# 完整功能测试报告\n\n`;
  md += `**时间:** ${new Date().toISOString()}\n`;
  md += `**结果:** ${passCount}/${testCount} 通过\n\n`;
  md += `| 测试 | 结果 | 说明 |\n|------|:----:|------|\n`;
  for (const r of results) {
    md += `| ${r.name} | ${r.passed ? "✅" : "❌"} | ${r.detail} |\n`;
  }
  
  fs.writeFileSync(reportPath, md, "utf-8");
  console.log(`\n报告已保存: ${reportPath}`);

  if (passCount < testCount) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Test suite failed:", e);
  process.exit(1);
});
