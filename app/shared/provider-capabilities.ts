/**
 * ProviderCapabilities — 视频生成 provider 真实能力记录（P0 capability probe 产物）。
 *
 * 纪律（与 image-conditioning-capability 同源）：
 * - 能力只能来自「真实 probe 验证」或「接口文档显式声明」，绝不能在业务代码里猜测；
 * - 未验证/不支持的能力必须如实标注（false / unverified / not_supported），
 *   不能因为「接口有字段」就当作「已验证可用」；
 * - 只有通过 P0 阈值的能力才会被 ShotGenerationModule 路由使用。
 *
 * 本文件是纯类型 + 判定逻辑，零 I/O；DB 持久化在 server/lib/provider-capabilities-store.ts。
 */

/** 音画能力的三态判定：verified=真实 probe 通过；unverified=未验证或验证失败；not_supported=接口/实测不支持 */
export type CapabilityTristate = 'verified' | 'unverified' | 'not_supported';

/** 三条件组实测质量（0-1，越高越好；null=该组未运行/不可用） */
export interface ObservedQuality {
  /** 联合组（video+image）相对 image-only 的动作/运镜保留提升（正数=有提升） */
  motionRetentionGain: number | null;
  /** 联合组相对 video-only 的产品身份正确率差值（≥0 表示不下降） */
  productIdentityDelta: number | null;
  /** 联合组产品身份正确率（0-1） */
  productIdentityRate: number | null;
  /** 联合组动作/运镜保留正确率（0-1） */
  motionRetentionRate: number | null;
  /** 结果帧出现源字幕/原产品文字的污染率（0-1，越低越好） */
  textContaminationRate: number | null;
  /** 联合组可用成片率（通过技术 QA 的产物占比） */
  usableRate: number | null;
}

export interface ProviderCapabilities {
  /** provider 标识（relay / ark / yunshu / fake） */
  provider: string;
  /** 实际提交的模型 code（如 doubao-seedance-2-0-fast） */
  modelCode: string;
  /** 探测时间（epoch ms） */
  probedAt: number | null;
  /** 探测来源（probe 版本/运行标识） */
  probedBy: string;

  // ===== 素材与生成能力（P0 §6 字段） =====
  /** 支持 reference video material（kind:'video'）并实测有效 */
  nativeReferenceVideo: boolean;
  /** 支持 first_frame 角色图片 */
  firstFrame: boolean;
  /** 支持多张参考图 */
  multiReferenceImages: boolean;
  /** 支持 masked V2V（本阶段接口无 mask 字段 → not_supported） */
  maskedV2V: boolean;
  /** 支持 first+last frame 控制 */
  firstLastFrame: boolean;
  /** 实测参考视频最大秒数（接口声明 15） */
  maxReferenceVideoSec: number;
  /** 实测单次生成最大秒数（接口声明 15） */
  maxOutputSec: number;

  /** 三条件组实测质量（P0 对照结论） */
  observedQuality: ObservedQuality;

  // ===== 原生音画能力（P0 音频 probe 结论） =====
  /** generateAudio=true 时确有音轨 */
  nativeGeneratedAudio: boolean;
  /** 原生口播可路由（= 通过 P0 全部音画门禁；未通过则为 false） */
  nativeSpeechGeneration: boolean;
  /** 中文口播可懂性（ASR 与 spokenLine 语义相符） */
  mandarinSpeechIntelligibility: CapabilityTristate;
  /** 可见说话者口型与语音时序可接受 */
  audiovisualLipSync: CapabilityTristate;
  /** 相邻镜头无换声/断音/音画错位 */
  crossShotVoiceContinuity: CapabilityTristate;
  /** 实测口播最大秒数（未验证为 0） */
  maxNativeSpeechSec: number;

  /** 证据（probe 运行引用与产物 URL） */
  evidence: {
    probeRunId: string | null;
    artifactUrls: string[];
    notes: string[];
  };
}

/** 未探测时的保守默认：全部不可路由（绝不假装能力存在） */
export function defaultProviderCapabilities(provider: string, modelCode: string): ProviderCapabilities {
  return {
    provider,
    modelCode,
    probedAt: null,
    probedBy: 'default',
    nativeReferenceVideo: false,
    firstFrame: false,
    multiReferenceImages: false,
    maskedV2V: false,
    firstLastFrame: false,
    maxReferenceVideoSec: 0,
    maxOutputSec: 0,
    observedQuality: {
      motionRetentionGain: null,
      productIdentityDelta: null,
      productIdentityRate: null,
      motionRetentionRate: null,
      textContaminationRate: null,
      usableRate: null,
    },
    nativeGeneratedAudio: false,
    nativeSpeechGeneration: false,
    mandarinSpeechIntelligibility: 'unverified',
    audiovisualLipSync: 'unverified',
    crossShotVoiceContinuity: 'unverified',
    maxNativeSpeechSec: 0,
    evidence: { probeRunId: null, artifactUrls: [], notes: [] },
  };
}

/** 判断给定字段是否满足「可路由」的最低要求（非全部通过，仅供路由前快速门禁） */
export function isVideoReferenceRoutable(cap: ProviderCapabilities): boolean {
  return cap.nativeReferenceVideo && cap.maxReferenceVideoSec >= 2;
}

/** 原生口播可路由：仅当 P0 音画门禁全部通过（计划 §P0 验收 / §2.4 纪律） */
export function isNativeSpeechRoutable(cap: ProviderCapabilities): boolean {
  return (
    cap.nativeGeneratedAudio &&
    cap.nativeSpeechGeneration &&
    cap.mandarinSpeechIntelligibility === 'verified' &&
    cap.audiovisualLipSync === 'verified' &&
    cap.crossShotVoiceContinuity === 'verified' &&
    cap.maxNativeSpeechSec > 0
  );
}

/** 逐字段校验结构完整性（probe 结果落库前使用；缺字段 → 错误列表） */
export function validateProviderCapabilities(raw: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, errors: ['capabilities 不是对象'] };
  }
  const c = raw as Record<string, unknown>;
  if (typeof c.provider !== 'string' || !c.provider) errors.push('missing provider');
  if (typeof c.modelCode !== 'string' || !c.modelCode) errors.push('missing modelCode');
  for (const boolField of [
    'nativeReferenceVideo',
    'firstFrame',
    'multiReferenceImages',
    'maskedV2V',
    'firstLastFrame',
    'nativeGeneratedAudio',
    'nativeSpeechGeneration',
  ] as const) {
    if (typeof c[boolField] !== 'boolean') errors.push(`${boolField} must be boolean`);
  }
  for (const numField of ['maxReferenceVideoSec', 'maxOutputSec', 'maxNativeSpeechSec'] as const) {
    if (typeof c[numField] !== 'number' || !Number.isFinite(c[numField] as number)) {
      errors.push(`${numField} must be a finite number`);
    }
  }
  for (const tri of ['mandarinSpeechIntelligibility', 'audiovisualLipSync', 'crossShotVoiceContinuity'] as const) {
    const value = c[tri];
    if (value !== 'verified' && value !== 'unverified' && value !== 'not_supported') {
      errors.push(`${tri} must be verified|unverified|not_supported`);
    }
  }
  const q = c.observedQuality as Record<string, unknown> | undefined;
  if (!q || typeof q !== 'object') {
    errors.push('missing observedQuality');
  }
  return { valid: errors.length === 0, errors };
}
