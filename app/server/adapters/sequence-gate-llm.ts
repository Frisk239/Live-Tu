/**
 * SequenceGateLlm — 序列语义门禁的「真实 LLM」适配器。
 *
 * 这是 runner/服务端把真实 LLM 显式注入 sequence gate 的唯一入口：
 * - 封装 llm-gateway（真实 provider 调用）为 SequenceLlm 形状；
 * - LLM 不可用/返回失败 → 返回 success:false（gate 据此如实 unverified，不伪造 pass）；
 * - 测试验证「真实 wiring」时以本模块为目标（spy 真实 gateway / stub fetch），
 *   不允许只靠 fake LLM 单测证明 runner 已接通。
 */

import { callLlmGateway } from '../lib/llm-gateway';
import type { SequenceLlm } from '../lib/sequence-semantic-gate';

/**
 * 创建基于真实 llm-gateway 的序列 QA LLM 注入点。
 * @param opts.modelId 模型名（缺省走 llm-gateway 默认文本模型）
 */
export function createSequenceGateLlm(opts: { modelId?: string } = {}): SequenceLlm {
  return async (input: { system: string; user: string; imageUrls: string[] }) => {
    try {
      const response = await callLlmGateway({
        system: input.system,
        user: input.user,
        imageUrls: input.imageUrls,
        modelId: opts.modelId,
        temperature: 0.1,
      });
      if (response.success) {
        return { success: true, data: response.data };
      }
      return { success: false, error: response.error || 'sequence QA LLM 未返回数据' };
    } catch (error: unknown) {
      return { success: false, error: String(error instanceof Error ? error.message : error) };
    }
  };
}
