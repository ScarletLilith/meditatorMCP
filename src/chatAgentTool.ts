import "./polyfill";
import fetch from "node-fetch";
import * as fs from "fs";
import * as path from "path";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { logger } from "./logger";
import { nodeStore } from "./nodeStore";
import { Gatekeeper } from "./gatekeeper";
import { StrategyEngine } from "./strategyEngine";
import {
  ChatAgentArgsSchema,
  CreateBranchInputSchema,
  GetBranchDetailsInputSchema,
  type ChatAgentArgs,
  type CreateBranchInput,
  type GetBranchDetailsInput,
} from "./schemas";

// ─── Shared Config Loading ─────────────────────────────────────
interface ApiConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

function loadConfig(): ApiConfig {
  // 优先读取 DeepSeek 官方 API 环境变量
  const envApiKey = process.env.DEEPSEEK_API_KEY || process.env.SILICONFLOW_API_KEY;
  const envBaseUrl = process.env.DEEPSEEK_BASE_URL || process.env.SILICONFLOW_BASE_URL;
  const envModel = process.env.DEEPSEEK_MODEL || process.env.SILICONFLOW_MODEL;

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
    "API configuration not found. Set environment variables (DEEPSEEK_API_KEY / SILICONFLOW_API_KEY, etc.) or create test/config.json"
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

// ─── Retry Call ────────────────────────────────────────────────
interface ApiCallResult {
  success: boolean;
  data?: any;
  classified?: ClassifiedError;
  error?: string;
  status_code?: number;
}

async function callApiWithRetry(
  apiUrl: string,
  body: any,
  apiKey: string,
  requestId: string
): Promise<ApiCallResult> {
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

        const shouldRetry = (response.status === 429 || response.status >= 500) && attempt < maxRetries;
        if (shouldRetry) {
          const delay = computeBackoff(attempt, response.status, data);
          log.warn(`API error ${response.status}, retrying in ${delay}ms`, { attempt, maxRetries, error: errMsg });
          await sleep(delay);
          continue;
        }

        return { success: false, classified, error: errMsg, status_code: response.status };
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

      if (classified.type === "network" || attempt >= maxRetries) {
        log.error(`API call failed permanently`, {
          type: classified.type,
          action: classified.action,
          error: classified.message,
          attempt,
          maxRetries,
        });
        return { success: false, classified, error: classified.message, status_code: 0 };
      }

      const delay = computeBackoff(attempt, 0, null);
      log.warn(`API call error, retrying in ${delay}ms`, { attempt, maxRetries, error: classified.message });
      await sleep(delay);
    }
  }

  return { success: false, classified: { type: "unknown", action: "report", message: "所有重试均失败", status_code: 0 }, error: "所有重试均失败", status_code: 0 };
}

function computeBackoff(attempt: number, statusCode: number, responseData: any): number {
  if (statusCode === 429 && responseData?.error?.retry_after) {
    return responseData.error.retry_after * 1000;
  }
  return Math.min(1000 * (Math.pow(2, attempt) - 1), 10000);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Tool Schemas ──────────────────────────────────────────────
export const chatAgentTool: Tool = {
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
        description: "停止序列，遇到这些字符串时停止生成。默认空数组不限停止符，由模型自然完成输出",
        default: [],
      },
      seed: {
        type: "number",
        description: "随机种子（需 API 支持）。设置后配合低 temperature 可实现输出复现",
      },
    },
    required: ["input_text"],
  },
};

export const createBranchTool: Tool = {
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
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "当前会话ID，用于区分不同思维树上下文",
      },
      input_text: {
        type: "string",
        minLength: 30,
        description: "具体、自包含的子问题描述，需包含足够上下文使工具可独立完成",
      },
      call_type: {
        type: "string",
        enum: ["drill_down", "verify", "explore", "stash"],
        description: "探索类型：drill_down(深入)/verify(验证)/explore(发散)/stash(备忘)",
        default: "drill_down",
      },
      parent_node_id: {
        type: "string",
        description: "父节点ID，若直接挂载于树干则使用 'trunk'",
        default: "trunk",
      },
    },
    required: ["session_id", "input_text"],
  },
};

export const getBranchDetailsTool: Tool = {
  name: "get_branch_details",
  description: [
    "当你对某个分支的结论存疑，需要查看其具体推导过程时调用此工具。",
    "工具将返回该节点内部模型的完整原始推理过程，不会污染主干上下文。",
  ].join(""),
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "当前会话ID",
      },
      node_id: {
        type: "string",
        description: "之前 create_branch 返回的分支节点ID",
      },
    },
    required: ["session_id", "node_id"],
  },
};

// ─── Shared Helpers ────────────────────────────────────────────
function makeErrorResponse(type: string, action: string, message: string, extra?: Record<string, any>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ success: false, type, action, message, ...extra }) }],
    isError: true,
  };
}

function generateRequestId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "req_";
  for (let i = 0; i < 12; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

const BRANCH_SYSTEM_PROMPT = `你是一个外部思维节点生成器。针对用户提出的局部子问题，进行独立分析。
请严格按照以下格式输出：

[分析过程]
（在此处输出你完整的推理过程，保持逻辑严密。）

[最终结论]
（在此处输出结论。要求：语义完整，不可出现半句截断的话，直接给主模型可用的判断或素材，不要废话。）`;

const gatekeeper = new Gatekeeper(nodeStore);

// ─── chat_agent handler ────────────────────────────────────────
export async function handleChatAgentCall(args: ChatAgentArgs) {
  const requestId = generateRequestId();
  const log = logger.withId(requestId);

  const parsed = ChatAgentArgsSchema.safeParse(args);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    log.error("Input validation failed", { errors: issues });
    return makeErrorResponse("validation", "fix_input", issues.join("; "), { errors: issues });
  }

  const validated = parsed.data;
  log.info("chat_agent called", { input_length: validated.input_text.length });

  let config: ApiConfig;
  try {
    config = loadConfig();
  } catch (e: any) {
    log.error("Config load failed", { error: e.message });
    return makeErrorResponse("config", "report", e.message);
  }

  const messages: any[] = validated.system_prompt
    ? [{ role: "system", content: validated.system_prompt }, { role: "user", content: validated.input_text }]
    : [{ role: "user", content: validated.input_text }];

  const body: any = {
    model: config.model,
    messages,
    temperature: validated.temperature,
    max_tokens: validated.max_tokens,
    top_p: validated.top_p,
  };
  if (validated.stop.length > 0) {
    body.stop = validated.stop;
  }
  if (validated.seed !== undefined) body.seed = validated.seed;

  const apiUrl = config.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const result = await callApiWithRetry(apiUrl, body, config.apiKey, requestId);

  if (!result.success) {
    log.error("Tool execution failed", { type: result.classified!.type, action: result.classified!.action, error: result.error, status_code: result.status_code });
    return makeErrorResponse(result.classified!.type, result.classified!.action, result.classified!.message, {
      error: result.error,
      status_code: result.status_code,
    });
  }

  const choice = result.data.choices?.[0];
  const content = choice?.message?.content || "";
  const finishReason = choice?.finish_reason || "unknown";

  log.info("Tool execution succeeded", { finish_reason: finishReason, output_length: content.length });

  return {
    content: [{ type: "text" as const, text: JSON.stringify({
      success: true, content, finish_reason: finishReason,
      usage: result.data.usage ? { prompt_tokens: result.data.usage.prompt_tokens, completion_tokens: result.data.usage.completion_tokens, total_tokens: result.data.usage.total_tokens } : null,
      model: result.data.model,
      hint: "若需多角度深入探索，请使用 create_branch 工具构建思维树分支",
    }) }],
  };
}

// ─── create_branch handler ─────────────────────────────────────
export async function handleCreateBranchCall(args: CreateBranchInput) {
  const requestId = generateRequestId();
  const log = logger.withId(requestId);

  const parsed = CreateBranchInputSchema.safeParse(args);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    log.error("create_branch input validation failed", { errors: issues });
    return makeErrorResponse("validation", "fix_input", issues.join("; "), { errors: issues });
  }

  const input = parsed.data;
  log.info("create_branch called", {
    session_id: input.session_id,
    call_type: input.call_type,
    parent_node_id: input.parent_node_id,
    input_length: input.input_text.length,
  });

  const gate = gatekeeper.validateCreate(input);
  if (!gate.valid) {
    log.warn("create_branch gatekeeper rejected", { reason: gate.reason });
    return makeErrorResponse("validation", "fix_input", gate.reason!);
  }

  let config: ApiConfig;
  try {
    config = loadConfig();
  } catch (e: any) {
    log.error("Config load failed", { error: e.message });
    return makeErrorResponse("config", "report", e.message);
  }

  const params = StrategyEngine.getParams(input.call_type);
  const body: any = {
    model: config.model,
    messages: [
      { role: "system", content: BRANCH_SYSTEM_PROMPT },
      { role: "user", content: input.input_text },
    ],
    temperature: params.temperature,
    top_p: params.top_p,
    max_tokens: params.max_tokens,
  };

  const apiUrl = config.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const result = await callApiWithRetry(apiUrl, body, config.apiKey, requestId);

  if (!result.success) {
    log.error("create_branch failed", { type: result.classified!.type, action: result.classified!.action, error: result.error, status_code: result.status_code });
    return makeErrorResponse(result.classified!.type, result.classified!.action, result.classified!.message, {
      error: result.error,
      status_code: result.status_code,
    });
  }

  const rawResponse = result.data.choices?.[0]?.message?.content || "";
  const node = nodeStore.addNode(
    input.session_id,
    input.parent_node_id,
    input.call_type,
    input.input_text,
    rawResponse
  );

  log.info("create_branch succeeded", {
    node_id: node.node_id,
    conclusion_length: node.conclusion.length,
    raw_length: node.raw_process.length,
  });

  // 获取当前会话的节点数和剩余配额
  const currentCount = nodeStore.getNodeCount(input.session_id);
  const maxNodes = Number(process.env.MAX_NODES_PER_SESSION) || 16;
  const remaining = maxNodes - currentCount;

  // 根据 confidence 和 call_type 生成后续建议
  const suggestions: string[] = [];
  if (node.confidence !== null && node.confidence < 0.7) {
    suggestions.push("该结论置信度较低，建议用 verify 类型创建验证分支");
  }
  if (input.call_type === "explore") {
    suggestions.push("发散探索完成，可对有价值的方向用 drill_down 深入");
  }
  if (input.call_type === "drill_down") {
    suggestions.push("深入分析完成，可用 verify 验证关键前提，或 explore 探索替代方案");
  }
  if (input.call_type === "verify") {
    suggestions.push("验证完成，可继续验证其他关键假设，或综合已有分支得出结论");
  }
  if (remaining > 3) {
    suggestions.push(`还可创建 ${remaining} 个分支，建议继续多角度探索`);
  }

  return {
    content: [{ type: "text" as const, text: JSON.stringify({
      status: "success",
      node_id: node.node_id,
      conclusion: node.conclusion,
      confidence: node.confidence,
      remaining_quota: remaining,
      suggestions,
    }) }],
  };
}

// ─── get_branch_details handler ────────────────────────────────
export async function handleGetBranchDetailsCall(args: GetBranchDetailsInput) {
  const requestId = generateRequestId();
  const log = logger.withId(requestId);

  const parsed = GetBranchDetailsInputSchema.safeParse(args);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    log.error("get_branch_details input validation failed", { errors: issues });
    return makeErrorResponse("validation", "fix_input", issues.join("; "), { errors: issues });
  }

  const { session_id, node_id } = parsed.data;
  log.info("get_branch_details called", { session_id, node_id });

  const node = nodeStore.getNode(session_id, node_id);
  if (!node) {
    log.warn("Node not found", { session_id, node_id });
    return makeErrorResponse("not_found", "report", "Node not found.", { session_id, node_id });
  }

  return {
    content: [{ type: "text" as const, text: JSON.stringify({
      status: "success",
      node_id: node.node_id,
      raw_process: node.raw_process,
    }) }],
  };
}
