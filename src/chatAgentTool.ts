import "./polyfill";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import fetch from "node-fetch";
import * as fs from "fs";
import * as path from "path";
import { logger } from "./logger";

// ─── Tool Schema ───────────────────────────────────────────────
export const chatAgentTool: Tool = {
  name: "chat_agent",
  description: [
    "调用独立、非思考模式的模型生成文本，用于延伸当前思维链。",
    "你可以传入任何需要独立完成且不受对话历史影响的子任务，",
    "包括但不限于：逻辑推理、发散联想、创意生成、优缺点分析、",
    "情景假设、步骤拆解、知识类比与迁移等。",
    "请确保 input_text 是一个完整、自包含的任务描述，明确任务类型与目标。",
    "通过调整 temperature（0~2）和 top_p（0~1）控制输出的确定性与多样性。",
    "对于需要精确复现的场景（如校验任务），建议设置 temperature 接近 0 并指定 seed。",
  ].join(""),
  inputSchema: {
    type: "object",
    properties: {
      input_text: {
        type: "string",
        description: [
            "完整、自包含的任务描述。需明确任务类型（推理/联想/类比/创意/评估等）",
            "并提供所有必要的上下文信息，使工具无需依赖外部信息即可独立完成任务。",
            "示例：'推理：已知X=5, Y=12，请推导Z=X²+Y²的值，并给出计算步骤。'",
          ].join(""),
      },
      system_prompt: {
        type: "string",
        description: "可选的系统提示词，用于设定角色或行为约束。如：'你是一个严谨的数学校验员，只输出最终结果。'",
      },
      temperature: {
        type: "number",
        description: "采样温度 0.0-2.0。低值(0.0-0.3)=确定/精确，高值(0.7-2.0)=创造/发散",
        default: 0.7,
      },
      top_p: {
        type: "number",
        description: "核采样阈值 0.0-1.0。与temperature配合使用控制输出多样性",
        default: 0.9,
      },
      max_tokens: {
        type: "number",
        description: "最大输出token数。通过API参数在服务端控制，非本地硬截断",
        default: 4096,
      },
      stop: {
        type: "array",
        items: { type: "string" },
        description: "停止序列，遇到这些字符串时停止生成。默认 ['\\n\\n'] 防止非思考模型自动续写，思考模型可按需覆盖",
        default: ["\n\n"],
      },
      seed: {
        type: "number",
        description: "随机种子（需 API 支持）。设置后配合低 temperature 可实现输出复现",
      },
    },
    required: ["input_text"],
  },
};

// ─── Config Loading ────────────────────────────────────────────
interface ApiConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

function loadConfig(): ApiConfig {
  const envApiKey = process.env.SILICONFLOW_API_KEY;
  const envBaseUrl = process.env.SILICONFLOW_BASE_URL;
  const envModel = process.env.SILICONFLOW_MODEL;

  if (envApiKey && envBaseUrl && envModel) {
    return { baseUrl: envBaseUrl, model: envModel, apiKey: envApiKey };
  }

  const configPaths = [
    path.join(process.cwd(), "test", "config.json"),
    path.join(__dirname, "..", "test", "config.json"),
    path.join(__dirname, "..", "..", "test", "config.json"),
  ];

  for (const configPath of configPaths) {
    if (fs.existsSync(configPath)) {
      try {
        const raw = fs.readFileSync(configPath, "utf-8");
        return JSON.parse(raw);
      } catch (e) {
        logger.warn("Failed to load config file", { configPath, error: String(e) });
      }
    }
  }

  throw new Error(
    "API configuration not found. Set environment variables (SILICONFLOW_API_KEY, SILICONFLOW_BASE_URL, SILICONFLOW_MODEL) or create test/config.json"
  );
}

// ─── Error Classification ──────────────────────────────────────
interface ClassifiedError {
  type: "network" | "api" | "validation" | "unknown";
  action: "retry" | "report" | "fix_input" | "backoff";
  message: string;
  status_code: number;
  retry_after?: number;
}

function classifyFetchError(error: any, statusCode?: number): ClassifiedError {
  const code = error?.code || "";
  const msg = error?.message || String(error);

  // 网络连接类错误 — 快速失败，让思考模型决定是否重试
  if (code === "ENOTFOUND") {
    return { type: "network", action: "retry", message: `DNS 解析失败，请检查 API 地址配置: ${msg}`, status_code: 0 };
  }
  if (code === "ECONNREFUSED") {
    return { type: "network", action: "retry", message: `API 服务连接被拒绝，请确认服务是否可用: ${msg}`, status_code: 0 };
  }
  if (code === "ECONNRESET") {
    return { type: "network", action: "retry", message: `连接被重置，可能是网络不稳定: ${msg}`, status_code: 0 };
  }
  if (code === "ENETUNREACH" || code === "EHOSTUNREACH") {
    return { type: "network", action: "retry", message: `网络不可达，请检查网络连接: ${msg}`, status_code: 0 };
  }
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") {
    return { type: "network", action: "retry", message: `网络连接超时，请检查网络或稍后重试: ${msg}`, status_code: 0 };
  }

  // HTTP 状态码类错误
  if (statusCode) {
    if (statusCode === 429) {
      return { type: "api", action: "backoff", message: `API 请求过于频繁(429)，请降低调用频率后重试`, status_code: 429 };
    }
    if (statusCode === 401) {
      return { type: "api", action: "report", message: `API 认证失败(401)，请检查 API Key 是否正确`, status_code: 401 };
    }
    if (statusCode === 400) {
      return { type: "api", action: "fix_input", message: `API 请求参数错误(400): ${msg}`, status_code: 400 };
    }
    if (statusCode >= 500) {
      return { type: "api", action: "retry", message: `API 服务暂时不可用(${statusCode}): ${msg}`, status_code: statusCode };
    }
  }

  return { type: "unknown", action: "report", message: msg, status_code: statusCode || 0 };
}

// ─── Input Validation ──────────────────────────────────────────
const MAX_INPUT_LENGTH = 100000; // 约 100K 字符，防止 context overflow
const MAX_INPUT_WARN_LENGTH = 80000;

interface ValidationResult {
  valid: boolean;
  input_text: string;
  temperature: number;
  top_p: number;
  max_tokens: number;
  stop: string[];
  errors: string[];
  warnings: string[];
}

function validateArgs(args: ChatAgentArgs): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // input_text 非空校验
  let text = args.input_text || "";
  if (!text.trim()) {
    errors.push("input_text 不能为空");
  }

  // 超长截断
  if (text.length > MAX_INPUT_LENGTH) {
    warnings.push(`input_text 过长(${text.length}字符)，截断至 ${MAX_INPUT_LENGTH} 字符`);
    text = text.substring(0, MAX_INPUT_LENGTH);
  } else if (text.length > MAX_INPUT_WARN_LENGTH) {
    warnings.push(`input_text 较长(${text.length}字符)，注意模型上下文窗口限制`);
  }

  // 参数钳制
  const temp = args.temperature ?? 0.7;
  const clampedTemp = Math.max(0, Math.min(2, temp));
  if (temp !== clampedTemp) {
    warnings.push(`temperature ${temp} 超出范围 [0,2]，已钳制为 ${clampedTemp}`);
  }

  const topP = args.top_p ?? 0.9;
  const clampedTopP = Math.max(0, Math.min(1, topP));
  if (topP !== clampedTopP) {
    warnings.push(`top_p ${topP} 超出范围 [0,1]，已钳制为 ${clampedTopP}`);
  }

  const maxTokens = args.max_tokens ?? 4096;
  const clampedMaxTokens = Math.max(1, Math.min(384000, maxTokens));
  if (maxTokens !== clampedMaxTokens) {
    warnings.push(`max_tokens ${maxTokens} 超出范围 [1,384000]，已钳制为 ${clampedMaxTokens}`);
  }

  return {
    valid: errors.length === 0,
    input_text: text,
    temperature: clampedTemp,
    top_p: clampedTopP,
    max_tokens: clampedMaxTokens,
    stop: args.stop ?? ["\n\n"],
    errors,
    warnings,
  };
}

// ─── Retry Call ────────────────────────────────────────────────
async function callApiWithRetry(
  apiUrl: string,
  body: any,
  apiKey: string,
  requestId: string
): Promise<any> {
  const log = logger.withId(requestId);
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 1) {
        log.info(`API call attempt ${attempt}/${maxRetries}`, { model: body.model });
      }

      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      const data = await response.json();

      if (!response.ok) {
        const classified = classifyFetchError(null, response.status);
        const errMsg = data.error?.message || data.error || `HTTP ${response.status}`;

        // 只在 429 / 5xx 时重试
        const shouldRetry = (response.status === 429 || response.status >= 500) && attempt < maxRetries;
        if (shouldRetry) {
          const delay = computeBackoff(attempt, response.status, data);
          log.warn(`API error ${response.status}, retrying in ${delay}ms`, { attempt, maxRetries, error: errMsg });
          await sleep(delay);
          continue;
        }

        // 不可重试的错误，直接返回
        return { success: false, classified, error: errMsg, status_code: response.status, data };
      }

      log.info("API call succeeded", {
        model: body.model,
        prompt_tokens: data.usage?.prompt_tokens,
        completion_tokens: data.usage?.completion_tokens,
        total_tokens: data.usage?.total_tokens,
      });

      return { success: true, data };
    } catch (error: any) {
      const classified = classifyFetchError(error);

      // 网络类错误在 Server 侧不自动重试，交由思考模型决策
      if (classified.type === "network" || attempt >= maxRetries) {
        log.error(`API call failed permanently`, {
          type: classified.type,
          action: classified.action,
          error: classified.message,
          attempt,
          maxRetries,
        });
        return { success: false, classified, error: classified.message, status_code: 0, data: null };
      }

      const delay = computeBackoff(attempt, 0, null);
      log.warn(`API call error, retrying in ${delay}ms`, { attempt, maxRetries, error: classified.message });
      await sleep(delay);
    }
  }

  return { success: false, classified: { type: "unknown", action: "report", message: "所有重试均失败", status_code: 0 }, error: "所有重试均失败", status_code: 0, data: null };
}

function computeBackoff(attempt: number, statusCode: number, responseData: any): number {
  // 优先使用服务端返回的 Retry-After
  if (statusCode === 429 && responseData?.error?.retry_after) {
    return responseData.error.retry_after * 1000;
  }
  // 指数退避：1s, 3s, 7s
  return Math.min(1000 * (Math.pow(2, attempt) - 1), 10000);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Direct API Call ───────────────────────────────────────────
interface ChatAgentArgs {
  input_text: string;
  system_prompt?: string;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string[];
  seed?: number;
}

export async function handleChatAgentCall(args: ChatAgentArgs) {
  const requestId = generateRequestId();
  const log = logger.withId(requestId);

  log.info("chat_agent called", { input_length: args.input_text?.length });

  // ── Step 1: 输入校验 ──
  const validated = validateArgs(args);
  for (const w of validated.warnings) {
    log.warn(w);
  }
  if (!validated.valid) {
    log.error("Input validation failed", { errors: validated.errors });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: false,
            type: "validation",
            action: "fix_input",
            errors: validated.errors,
            message: validated.errors.join("; "),
          }),
        },
      ],
      isError: true,
    };
  }

  // 校验过程中的截断需要记录
  if (validated.input_text !== args.input_text) {
    log.warn("input_text was truncated", {
      original: args.input_text.length,
      truncated: validated.input_text.length,
    });
  }

  // ── Step 2: 加载配置 ──
  let config: ApiConfig;
  try {
    config = loadConfig();
  } catch (e: any) {
    log.error("Config load failed", { error: e.message });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: false,
            type: "config",
            action: "report",
            message: e.message,
          }),
        },
      ],
      isError: true,
    };
  }

  log.info("Config loaded", { model: config.model, baseUrl: config.baseUrl.replace(/\/+$/, "") });

  // ── Step 3: 组装请求 ──
  const systemPrompt = args.system_prompt;
  const messages: any[] = systemPrompt
    ? [
        { role: "system", content: systemPrompt },
        { role: "user", content: validated.input_text },
      ]
    : [{ role: "user", content: validated.input_text }];

  const body: any = {
    model: config.model,
    messages,
    temperature: validated.temperature,
    max_tokens: validated.max_tokens,
    top_p: validated.top_p,
    stop: validated.stop,
  };

  if (args.seed !== undefined) {
    body.seed = args.seed;
  }

  const apiUrl = config.baseUrl.replace(/\/+$/, "") + "/chat/completions";

  // ── Step 4: 发起 API 调用（含重试） ──
  const result = await callApiWithRetry(apiUrl, body, config.apiKey, requestId);

  if (!result.success) {
    log.error("Tool execution failed", {
      type: result.classified.type,
      action: result.classified.action,
      error: result.error,
      status_code: result.status_code,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: false,
            type: result.classified.type,
            action: result.classified.action,
            error: result.error,
            status_code: result.status_code,
            message: result.classified.message,
          }),
        },
      ],
      isError: true,
    };
  }

  // ── Step 5: 成功返回 ──
  const choice = result.data.choices?.[0];
  const content = choice?.message?.content || "";
  const finishReason = choice?.finish_reason || "unknown";

  log.info("Tool execution succeeded", {
    finish_reason: finishReason,
    output_length: content.length,
  });

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          success: true,
          content,
          finish_reason: finishReason,
          usage: result.data.usage
            ? {
                prompt_tokens: result.data.usage.prompt_tokens,
                completion_tokens: result.data.usage.completion_tokens,
                total_tokens: result.data.usage.total_tokens,
              }
            : null,
          model: result.data.model,
        }),
      },
    ],
  };
}

// ─── Helpers ───────────────────────────────────────────────────
function generateRequestId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "req_";
  for (let i = 0; i < 12; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}
