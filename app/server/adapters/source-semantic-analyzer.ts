/**
 * SourceSemanticAnalyzer — 原视频语义理解适配器（服务端/CLI 共用）。
 *
 * 职责拆分（P5 修复，支持「先分析、后按分析选段」的真实流程）：
 * - analyzeRaw()：一次非付费 LLM vision 理解 pass（prompt 构建 + gateway 调用 +
 *   ReferenceAnalysis schema 校验），返回原始分析——不绑定镜头段；
 * - buildStoryboardFromAnalysis()：用【最终选定的】镜头段 + 原始分析构建语义故事板
 *   （纯函数，可安全地在选段后调用）；
 * - analyzeSource()：一站式入口（analyzeRaw + 用给定 segments 构建 storyboard）。
 * 校验失败/LLM 不可用 → 明确标记 deterministic_fallback（schemaValid=false），
 * 绝不记录为「已深度理解原视频」。
 */

import { callLlmGateway } from '../lib/llm-gateway';
import {
  buildSemanticStoryboard,
  buildSemanticStoryboardPrompt,
  type SemanticStoryboard,
} from '../lib/semantic-storyboard';
import { validateReferenceAnalysis } from '../domain/reference-analysis/reference-analysis';
import type {
  SourceSemanticAnalysisInput,
  SourceSemanticAnalysisOutput,
} from '../ports/vision-qa';

export interface SourceRawAnalysis {
  rawAnalysis: unknown;
  source: 'llm_vision' | 'deterministic_fallback' | 'hybrid';
  schemaValid: boolean;
  modelUsed: string | null;
  error: string | null;
}

export class LlmSourceSemanticAnalyzer {
  readonly name = 'llm-vision-source-semantic-analysis';

  /** 一次非付费 LLM 理解 pass（不绑定最终镜头段，供选段前调用） */
  async analyzeRaw(input: {
    productName: string;
    keyframeUrls: string[];
    modelId?: string;
    /** How each supplied image represents its candidate segment. */
    frameEvidence?: 'single_keyframe' | 'early_mid_late_strip';
    /**
     * 候选段（真实视频秒数 + 候选序号 = keyframeUrls 顺序）。
     * P5 二轮修复：prompt 携带真实秒数，LLM 返回的 shotCandidates.shotIndex
     * 即候选序号、startSec/endSec 即真实秒数——与选段坐标一致，不再伪造 0..N。
     */
    segments?: Array<{ candidateId?: string; startSec: number; endSec: number; structure?: string }>;
  }): Promise<SourceRawAnalysis> {
    const prompt = buildSemanticStoryboardPrompt({
      productName: input.productName,
      segments: input.segments && input.segments.length > 0
        ? input.segments
        : input.keyframeUrls.map((_, index) => ({
            startSec: index,
            endSec: index + 1,
            structure: `候选帧 ${index + 1}`,
          })),
      frameEvidence: input.frameEvidence,
    });
    try {
      const response = await callLlmGateway({
        system: prompt.system,
        user: prompt.user,
        imageUrls: input.keyframeUrls,
        modelId: input.modelId,
        temperature: 0.1,
      });
      const schemaCheck = validateReferenceAnalysis(
        response.success ? response.data : undefined
      );
      return {
        rawAnalysis: response.success ? response.data : null,
        source: response.success && schemaCheck.valid ? 'llm_vision' : 'deterministic_fallback',
        schemaValid: schemaCheck.valid,
        modelUsed: response.modelUsed ?? null,
        error: response.success ? null : response.error || 'semantic analysis unavailable',
      };
    } catch (error: unknown) {
      return {
        rawAnalysis: null,
        source: 'deterministic_fallback',
        schemaValid: false,
        modelUsed: null,
        error: String(error instanceof Error ? error.message : error),
      };
    }
  }

  /** 用最终选定的镜头段 + 原始分析构建语义故事板（纯函数，不发起任何调用） */
  buildStoryboardFromAnalysis(input: {
    productName: string;
    segments: Array<{ candidateId?: string; startSec: number; endSec: number; structure?: string }>;
    rawAnalysis?: unknown;
    analyzedKeyframeCount?: number;
  }): SemanticStoryboard {
    return buildSemanticStoryboard({
      productName: input.productName,
      segments: input.segments,
      rawAnalysis: input.rawAnalysis,
      analyzedKeyframeCount: input.analyzedKeyframeCount,
    });
  }

  async analyzeSource(input: SourceSemanticAnalysisInput): Promise<SourceSemanticAnalysisOutput> {
    const segments = input.segments.map(({ candidateId, startSec, endSec, structure }) => ({
      candidateId,
      startSec,
      endSec,
      structure,
    }));
    const raw = await this.analyzeRaw({
      productName: input.productName,
      keyframeUrls: input.keyframeUrls,
      // P5 三轮：analyzeSource 必须把真实 segments 传给 analyzeRaw（prompt 用真实秒数，
      // 候选序号与 keyframeUrls 顺序一致），不能退回 0..N 伪造坐标。
      segments,
      modelId: input.modelId,
    });
    const storyboard = this.buildStoryboardFromAnalysis({
      productName: input.productName,
      segments,
      rawAnalysis: raw.rawAnalysis ?? undefined,
      analyzedKeyframeCount: input.keyframeUrls.length,
    });
    return {
      storyboard,
      rawAnalysis: raw.rawAnalysis,
      source: storyboard.evidence.source,
      schemaValid: raw.schemaValid,
      modelUsed: raw.modelUsed,
      error: raw.error,
    };
  }
}

/** 便捷工厂（单次调用入口，runner 与服务端共用） */
export function createSourceSemanticAnalyzer(): LlmSourceSemanticAnalyzer {
  return new LlmSourceSemanticAnalyzer();
}
