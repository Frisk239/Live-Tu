/**
 * ProviderCapabilities 契约测试（纯模块，零外部调用）：
 * - 默认值全部不可路由（绝不假装能力存在）；
 * - schema 校验（缺字段/非法三态 → invalid）；
 * - 路由判定：nativeReferenceVideo 需要联合组实测通过阈值；
 * - nativeSpeechGeneration 只有音画门禁全部 verified 才可路由；
 * - silent_fallback 永远可路由；
 * - 未验证能力不伪造（maskedV2V 等如实 false）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultProviderCapabilities,
  validateProviderCapabilities,
  isVideoReferenceRoutable,
  isNativeSpeechRoutable,
  type ProviderCapabilities,
} from '../../shared/provider-capabilities';
import {
  canRouteNativeReferenceVideo,
  canRouteNativeSpeech,
  canRouteSilentFallback,
  canRouteAudioMode,
} from '../domain/viral-recreation/provider-capabilities';

/** P0 联合组全通过的 fake 能力（供路由判定测试） */
function fullCapabilities(): ProviderCapabilities {
  return {
    provider: 'relay',
    modelCode: 'doubao-seedance-2-0-fast',
    probedAt: Date.now(),
    probedBy: 'test',
    nativeReferenceVideo: true,
    firstFrame: true,
    multiReferenceImages: true,
    maskedV2V: false,
    firstLastFrame: false,
    maxReferenceVideoSec: 15,
    maxOutputSec: 15,
    observedQuality: {
      motionRetentionGain: 0.4,
      productIdentityDelta: 0.0,
      productIdentityRate: 0.85,
      motionRetentionRate: 0.8,
      textContaminationRate: 0.02,
      usableRate: 0.9,
    },
    nativeGeneratedAudio: true,
    nativeSpeechGeneration: true,
    mandarinSpeechIntelligibility: 'verified',
    audiovisualLipSync: 'verified',
    crossShotVoiceContinuity: 'verified',
    maxNativeSpeechSec: 5,
    evidence: { probeRunId: 'test-run', artifactUrls: [], notes: [] },
  };
}

test('默认能力全部不可路由（未探测时绝不假装能力存在）', () => {
  const caps = defaultProviderCapabilities('relay', 'doubao-seedance-2-0-fast');
  assert.equal(caps.nativeReferenceVideo, false);
  assert.equal(caps.nativeSpeechGeneration, false);
  assert.equal(caps.maskedV2V, false);
  assert.equal(caps.firstFrame, false);
  assert.equal(caps.maxReferenceVideoSec, 0);
  assert.equal(caps.maxOutputSec, 0);
  assert.equal(caps.mandarinSpeechIntelligibility, 'unverified');
  assert.equal(caps.audiovisualLipSync, 'unverified');
  assert.equal(caps.crossShotVoiceContinuity, 'unverified');
  assert.equal(isVideoReferenceRoutable(caps), false);
  assert.equal(isNativeSpeechRoutable(caps), false);
  assert.equal(canRouteNativeReferenceVideo(caps).routable, false);
  assert.equal(canRouteNativeSpeech(caps).routable, false);
  // 静音 fallback 不依赖任何已验证能力
  assert.equal(canRouteSilentFallback(caps).routable, true);
  assert.equal(canRouteAudioMode(caps, 'silent_fallback').routable, true);
  assert.equal(canRouteAudioMode(caps, 'native_if_verified').routable, false);
});

test('schema 校验：完整对象通过，缺字段/非法三态失败', () => {
  assert.equal(validateProviderCapabilities(fullCapabilities()).valid, true);

  const missingProvider = fullCapabilities();
  (missingProvider as any).provider = '';
  assert.equal(validateProviderCapabilities(missingProvider).valid, false);

  const badTri = fullCapabilities();
  (badTri as any).mandarinSpeechIntelligibility = 'maybe';
  const check = validateProviderCapabilities(badTri);
  assert.equal(check.valid, false);
  assert.ok(check.errors.some((e) => e.includes('mandarinSpeechIntelligibility')));

  const badBool = fullCapabilities();
  (badBool as any).nativeReferenceVideo = 'yes';
  assert.equal(validateProviderCapabilities(badBool).valid, false);

  assert.equal(validateProviderCapabilities(null).valid, false);
  assert.equal(validateProviderCapabilities(42).valid, false);
});

test('native_reference_video 路由：P0 联合组实测通过阈值才可路由', () => {
  const caps = fullCapabilities();
  const decision = canRouteNativeReferenceVideo(caps);
  assert.equal(decision.routable, true, decision.reason);

  // 未探测 → 不可路由
  const unprobed = defaultProviderCapabilities('relay', 'x');
  assert.equal(canRouteNativeReferenceVideo(unprobed).routable, false);

  // 动作保留率低于阈值 → 不可路由
  const lowMotion = fullCapabilities();
  lowMotion.observedQuality.motionRetentionRate = 0.3;
  assert.equal(canRouteNativeReferenceVideo(lowMotion).routable, false);

  // 产品身份率低于阈值 → 不可路由
  const lowIdentity = fullCapabilities();
  lowIdentity.observedQuality.productIdentityRate = 0.3;
  assert.equal(canRouteNativeReferenceVideo(lowIdentity).routable, false);

  // 文字污染率过高 → 不可路由
  const contaminated = fullCapabilities();
  contaminated.observedQuality.textContaminationRate = 0.5;
  assert.equal(canRouteNativeReferenceVideo(contaminated).routable, false);

  // 缺实测率（null）→ 不可路由（不得在无证据时放行）
  const noObserved = fullCapabilities();
  noObserved.observedQuality.motionRetentionRate = null;
  assert.equal(canRouteNativeReferenceVideo(noObserved).routable, false);
});

test('native_speech 路由：音画门禁全部 verified 才可路由', () => {
  const caps = fullCapabilities();
  assert.equal(canRouteNativeSpeech(caps).routable, true);

  // 任一音画门禁未通过 → 不可路由
  const noAudio = fullCapabilities();
  noAudio.nativeGeneratedAudio = false;
  assert.equal(canRouteNativeSpeech(noAudio).routable, false);

  const noSpeech = fullCapabilities();
  noSpeech.nativeSpeechGeneration = false;
  assert.equal(canRouteNativeSpeech(noSpeech).routable, false);

  const unclear = fullCapabilities();
  unclear.mandarinSpeechIntelligibility = 'unverified';
  assert.equal(canRouteNativeSpeech(unclear).routable, false);

  const lipSyncFail = fullCapabilities();
  lipSyncFail.audiovisualLipSync = 'not_supported';
  assert.equal(canRouteNativeSpeech(lipSyncFail).routable, false);

  const continuityFail = fullCapabilities();
  continuityFail.crossShotVoiceContinuity = 'unverified';
  assert.equal(canRouteNativeSpeech(continuityFail).routable, false);

  const noMax = fullCapabilities();
  noMax.maxNativeSpeechSec = 0;
  assert.equal(canRouteNativeSpeech(noMax).routable, false);
});

test('audioMode 门禁：native_if_verified 走音画门禁，silent_fallback 恒可用', () => {
  const caps = fullCapabilities();
  assert.equal(canRouteAudioMode(caps, 'native_if_verified').routable, true);
  assert.equal(canRouteAudioMode(caps, 'silent_fallback').routable, true);

  const noSpeech = fullCapabilities();
  noSpeech.nativeSpeechGeneration = false;
  assert.equal(canRouteAudioMode(noSpeech, 'native_if_verified').routable, false);
  assert.equal(canRouteAudioMode(noSpeech, 'silent_fallback').routable, true);
});

test('未验证能力不伪造：maskedV2V/firstLastFrame 默认为 false 且不可路由', () => {
  const caps = fullCapabilities();
  assert.equal(caps.maskedV2V, false); // 接口无 mask 字段 → 如实 false
  assert.equal(caps.firstLastFrame, false); // 未实测 → 如实 false
  assert.equal(isVideoReferenceRoutable(caps), true); // 只依赖已验证字段
});
