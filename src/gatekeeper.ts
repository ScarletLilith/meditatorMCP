import type { NodeStore } from "./nodeStore";
import type { CreateBranchInput } from "./schemas";

export interface GatekeeperSettings {
  maxNodesPerSession: number;
  minInputTextLength: number;
  forbiddenKeywords: string[];
}

const DEFAULT_SETTINGS: GatekeeperSettings = {
  maxNodesPerSession: Number(process.env.MAX_NODES_PER_SESSION) || 16,
  minInputTextLength: Number(process.env.MIN_INPUT_TEXT_LENGTH) || 30,
  forbiddenKeywords: [
    "完成整个任务",
    "输出最终答案",
    "从头到尾设计",
  ],
};

/**
 * 拦截门控：在调用 API 前进行校验，拒绝滥用。
 */
export class Gatekeeper {
  constructor(
    private nodeStore: NodeStore,
    private settings: GatekeeperSettings = DEFAULT_SETTINGS
  ) {}

  validateCreate(input: CreateBranchInput): { valid: boolean; reason?: string } {
    if (input.input_text.length < this.settings.minInputTextLength) {
      return { valid: false, reason: "子问题描述过短，无法独立求解。" };
    }

    for (const kw of this.settings.forbiddenKeywords) {
      if (input.input_text.includes(kw)) {
        return { valid: false, reason: "禁止外包全局主干任务。" };
      }
    }

    const currentCount = this.nodeStore.getNodeCount(input.session_id);
    if (currentCount >= this.settings.maxNodesPerSession) {
      return {
        valid: false,
        reason: `外部探索配额(${this.settings.maxNodesPerSession})耗尽，请基于现有结论整合。`,
      };
    }

    return { valid: true };
  }
}
