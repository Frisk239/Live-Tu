/**
 * ProviderCapabilities 路由判定（纯领域模块，零 I/O）。
 *
 * 职责：把 P0 probe 记录的能力翻译为 ShotGenerationModule 的路由决策——
 * 只有「已通过真实 probe 阈值」的能力才可被路由使用；未验证/不支持
 * 一律返回不可路由，绝不把「接口声明」当作「已验证能力」。
 *
 * 本模块不依赖 Express / SQLite / 环境变量 / fetch；类型来自 shared 契约。
 */

import type { ProviderCapabilities } from '../../../shared/provider-capabilities';

export type RouteDecision = {
  routable: boolean;
  reason: string;
};

/** native_reference_video Adapter 是否可路由：P0 联合条件组通过动作保留与产品身份阈值 */
export function canRouteNativeReferenceVideo(cap: ProviderCapabilities, thresholds?: {
  motionRetentionRate?: number;
  productIdentityRate?: number;
}): RouteDecision {
  if (!cap.nativeReferenceVideo) {
    return { routable: false, reason: 'nativeReferenceVideo 未通过 P0 验证（真实 probe 未证明参考视频材料有效）' };
  }
  if (cap.maxReferenceVideoSec < 2) {
    return { routable: false, reason: `maxReferenceVideoSec=${cap.maxReferenceVideoSec} 低于参考视频最小 2s 约束` };
  }
  const motion = thresholds?.motionRetentionRate ?? 0.5;
  const identity = thresholds?.productIdentityRate ?? 0.5;
  const observed = cap.observedQuality;
  if (observed.motionRetentionRate === null) {
    return { routable: false, reason: '缺少动作/运镜保留实测率（observedQuality.motionRetentionRate=null），不得路由' };
  }
  if (observed.productIdentityRate === null) {
    return { routable: false, reason: '缺少产品身份正确率实测（observedQuality.productIdentityRate=null），不得路由' };
  }
  if (observed.motionRetentionRate < motion) {
    return {
      routable: false,
      reason: `动作/运镜保留实测率 ${observed.motionRetentionRate} < 阈值 ${motion}，native_reference_video 不可路由`,
    };
  }
  if (observed.productIdentityRate < identity) {
    return {
      routable: false,
      reason: `产品身份正确率实测 ${observed.productIdentityRate} < 阈值 ${identity}，native_reference_video 不可路由`,
    };
  }
  if (observed.textContaminationRate !== null && observed.textContaminationRate > 0.1) {
    return {
      routable: false,
      reason: `源字幕/文字污染率实测 ${observed.textContaminationRate} > 10%，输入材料未达到干净要求`,
    };
  }
  return { routable: true, reason: 'P0 联合条件组全部通过阈值' };
}

/** 原生口播（native_if_verified）是否可路由：P0 音画 QA 全部通过才可设置 generateAudio=true */
export function canRouteNativeSpeech(cap: ProviderCapabilities): RouteDecision {
  if (!cap.nativeGeneratedAudio) {
    return { routable: false, reason: 'nativeGeneratedAudio=false：generateAudio=true 无音轨证据' };
  }
  if (!cap.nativeSpeechGeneration) {
    return { routable: false, reason: 'nativeSpeechGeneration=false：P0 音画门禁未通过，原生口播不可路由' };
  }
  if (cap.mandarinSpeechIntelligibility !== 'verified') {
    return {
      routable: false,
      reason: `mandarinSpeechIntelligibility=${cap.mandarinSpeechIntelligibility}：中文口播可懂性未验证，不可路由`,
    };
  }
  if (cap.audiovisualLipSync !== 'verified') {
    return {
      routable: false,
      reason: `audiovisualLipSync=${cap.audiovisualLipSync}：口型同步未验证，不可路由`,
    };
  }
  if (cap.crossShotVoiceContinuity !== 'verified') {
    return {
      routable: false,
      reason: `crossShotVoiceContinuity=${cap.crossShotVoiceContinuity}：跨镜声音连续性未验证，不可路由`,
    };
  }
  if (cap.maxNativeSpeechSec <= 0) {
    return { routable: false, reason: 'maxNativeSpeechSec=0：无实测口播时长上限，不可路由' };
  }
  return { routable: true, reason: 'P0 音画门禁全部通过（口播可懂/口型同步/跨镜连续/时长上限）' };
}

/** 静音 fallback 永远可路由（不需要任何已验证能力） */
export function canRouteSilentFallback(_cap: ProviderCapabilities): RouteDecision {
  return { routable: true, reason: 'silent_fallback 不依赖任何已验证能力，始终可用' };
}

/** 给定 audioMode，返回该模式是否可路由（native_if_verified 需要音画门禁） */
export function canRouteAudioMode(cap: ProviderCapabilities, audioMode: 'native_if_verified' | 'silent_fallback'): RouteDecision {
  return audioMode === 'native_if_verified' ? canRouteNativeSpeech(cap) : canRouteSilentFallback(cap);
}
