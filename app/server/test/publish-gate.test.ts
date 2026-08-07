/**
 * S1 publish-gate 证据可解释性测试：
 * - 每个 blocker/warning 必须携带 blockerEvidence/warningEvidence（source + detail）；
 * - product_conditioned 声明在缺少服务端证据 URL 时不得给满确定性加分（防御性降级）；
 * - unverified QA 不得默认 ok/passed；
 * - 远端不可探测语义与 S0 修复保持一致（跨用户/跨产品/客户端伪造在路由层拦截，此处验证门禁层）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluatePublishGate, gateAllowsCompleted, resolveFirstFrameSource } from '../lib/publish-gate';

test('[P0] unverified 产物不得进入 completed：gateAllowsCompleted 必须 passed && status==="passed"', () => {
  // 复现审查发现的契约漏洞：QA 未验证但无 blocker → passed=true, status='unverified'
  const report = evaluatePublishGate({
    videoUrl: '/uploads/renders/x.mp4',
    source: 'ffmpeg',
    durationSec: 15,
    resolution: '1080x1920',
    firstFrameSource: 'product_conditioned',
    evidence: { firstFrameEvidenceUrl: '/uploads/product-assets/pa_1.png' },
    qaReport: { status: 'unverified', ok: false, reason: 'remote_url_unverified' },
  });
  assert.equal(report.passed, true, '复现：技术项满足时 passed 成立');
  assert.equal(report.status, 'unverified');
  assert.equal(gateAllowsCompleted(report, false), false, '[P0] unverified 不得允许 completed');
  assert.equal(gateAllowsCompleted(report, true), false, '[P0] 即使允许 mock 也不得 completed');

  // 真通过：passed && status==='passed' → 允许 completed
  const ok = evaluatePublishGate({
    videoUrl: '/uploads/renders/x.mp4',
    source: 'ffmpeg',
    durationSec: 15,
    resolution: '1080x1920',
    firstFrameSource: 'product_conditioned',
    evidence: { firstFrameEvidenceUrl: '/uploads/product-assets/pa_1.png' },
    qaReport: { status: 'verified', ok: true },
  });
  assert.equal(ok.status, 'passed');
  assert.equal(gateAllowsCompleted(ok, false), true);
});

test('gateAllowsCompleted：failed/needs_review 均不得 completed', () => {
  const failed = evaluatePublishGate({
    videoUrl: '',
    source: 'mock',
    isMockFallback: true,
    allowMockFallback: false,
  });
  assert.equal(gateAllowsCompleted(failed, false), false);
  const needsReview = evaluatePublishGate({
    videoUrl: '/uploads/renders/x.mp4',
    source: 'mock',
    isMockFallback: true,
    allowMockFallback: true, // 允许 mock 兜底 → 仅 warning，无 hard blocker → needs_review
    firstFrameSource: 'product_conditioned',
    evidence: { firstFrameEvidenceUrl: '/uploads/product-assets/pa_1.png' },
    qaReport: { status: 'verified', ok: true },
  });
  assert.equal(needsReview.status, 'needs_review', 'mock 兜底未授权发布应进入 needs_review');
  assert.equal(gateAllowsCompleted(needsReview, true), false);
});

test('blocker/warning 全部携带证据来源（source+detail），发布页可解释', () => {
  const report = evaluatePublishGate({
    videoUrl: '',
    source: 'mock',
    isMockFallback: true,
    allowMockFallback: false,
    firstFrameSource: 'viral_keyframe',
    durationSec: 5,
    resolution: '',
    complianceWarnings: [{ word: '违禁' }],
    qaReport: { status: 'unverified', ok: false },
  });
  assert.ok(report.blockers.length >= 2, '缺视频/mock/首帧应产生 blocker');
  assert.ok(report.warnings.length >= 1);
  for (const b of report.blockers) {
    const ev = report.blockerEvidence[b];
    assert.ok(ev, `blocker ${b} 必须有证据条目`);
    assert.ok(ev.source, `blocker ${b} 必须注明来源`);
    assert.ok(ev.detail, `blocker ${b} 必须有人工可读解释`);
  }
  for (const w of report.warnings) {
    const ev = report.warningEvidence[w];
    assert.ok(ev, `warning ${w} 必须有证据条目`);
    assert.ok(ev.source && ev.detail);
  }
  assert.equal(report.status, 'failed');
});

test('未验证 QA：不默认通过，状态为 unverified（passed 时不静默）', () => {
  const report = evaluatePublishGate({
    videoUrl: '/uploads/renders/x.mp4',
    source: 'ffmpeg',
    durationSec: 12,
    resolution: '1080x1920',
    aspectRatio: '9:16',
    firstFrameSource: 'product_conditioned',
    evidence: { firstFrameEvidenceUrl: '/uploads/product-assets/pa_1.png' },
    qaReport: { status: 'unverified', ok: false, reason: 'remote_url_unverified' },
  });
  assert.equal(report.passed, true, '技术项满足时 passed 可成立');
  assert.equal(report.status, 'unverified', 'QA 未验证 → 整体 unverified');
  assert.ok(report.warnings.includes('qa_unverified'));
});

test('QA 有失败项（warning）→ 语义分降低并带警告', () => {
  const report = evaluatePublishGate({
    videoUrl: '/uploads/renders/x.mp4',
    durationSec: 12,
    resolution: '1080x1920',
    firstFrameSource: 'product_conditioned',
    evidence: { firstFrameEvidenceUrl: '/uploads/product-assets/pa_1.png' },
    qaReport: { status: 'warning', ok: false, checks: [{ name: 'black_frame', ok: false }] },
  });
  assert.ok(report.warnings.includes('qa_warning'));
  assert.ok(report.scores.semantic < 0.6, 'warning QA 语义分必须下调');
});

test('product_conditioned 声明但服务端证据 URL 缺失：防御性降级，不给 0.85 假确定性', () => {
  const withEvidence = evaluatePublishGate({
    videoUrl: '/uploads/renders/x.mp4',
    durationSec: 12,
    resolution: '1080x1920',
    firstFrameSource: 'product_conditioned',
    evidence: { firstFrameEvidenceUrl: '/uploads/product-assets/pa_1.png' },
    qaReport: { status: 'verified', ok: true },
  });
  assert.equal(withEvidence.scores.productIdentity, 0.85);

  const noEvidence = evaluatePublishGate({
    videoUrl: '/uploads/renders/x.mp4',
    durationSec: 12,
    resolution: '1080x1920',
    firstFrameSource: 'product_conditioned',
    evidence: {},
    qaReport: { status: 'verified', ok: true },
  });
  assert.equal(noEvidence.scores.productIdentity, 0.7, '无证据声明必须降级');
  assert.ok(noEvidence.warnings.includes('first_frame_source_unspecified'));
});

test('resolveFirstFrameSource：product_conditioned 无证据 → undefined（S0 provenance 不回归）', () => {
  assert.equal(resolveFirstFrameSource('product_conditioned', []), undefined);
  assert.equal(resolveFirstFrameSource('product_conditioned', ['/uploads/product-assets/pa_1.png']), 'product_conditioned');
  assert.equal(resolveFirstFrameSource('viral_keyframe', ['/uploads/x.png']), 'viral_keyframe');
  assert.equal(resolveFirstFrameSource(null, []), undefined);
});

test('通过场景：全部满足 → passed，无 blocker 且证据完整', () => {
  const report = evaluatePublishGate({
    videoUrl: '/uploads/renders/x.mp4',
    source: 'ffmpeg',
    durationSec: 15,
    resolution: '1080x1920',
    aspectRatio: '9:16',
    hasSubtitles: true,
    hasAudio: true,
    firstFrameSource: 'product_conditioned',
    evidence: { firstFrameEvidenceUrl: '/uploads/product-assets/pa_1.png' },
    narrativeBeatsPresent: true,
    clipCount: 4,
    qaReport: { status: 'verified', ok: true },
  });
  assert.equal(report.passed, true);
  assert.equal(report.status, 'passed');
  assert.equal(report.blockers.length, 0);
  assert.equal(report.warnings.length, 0);
  assert.ok(report.scorerVersion);
});

test('客户端伪造防护：mock 未授权时永远 blocker（不回归 S0）', () => {
  const report = evaluatePublishGate({
    videoUrl: '/uploads/renders/x.mp4',
    source: 'mock',
    isMockFallback: true,
    allowMockFallback: false,
    firstFrameSource: 'product_conditioned',
    evidence: { firstFrameEvidenceUrl: '/uploads/product-assets/pa_1.png' },
  });
  assert.ok(report.blockers.includes('mock_result_not_publishable'));
  assert.equal(report.status, 'failed');
  assert.equal(report.scores.compliance, 0);
});
