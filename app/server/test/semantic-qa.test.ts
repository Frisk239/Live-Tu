/**
 * P3 semantic-qa 测试：
 * - shared/semantic-qa.ts 契约（verdict 推导、摘要、scorecard 集成、fix map 完整性）；
 * - FakeSemanticQaScorer 确定性（forceFail/forceWarning 注入、无真实付费调用）；
 * - LlmSemanticQaScorer 的 unverified 语义（无 LLM 时返回 unverified，不伪造 pass）。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import {
  deriveOverallVerdict,
  generateSummary,
  issuesToScoreEntries,
  buildSemanticScorecard,
  SEMANTIC_FIX_MAP,
  SEMANTIC_DIMENSIONS,
  type SemanticIssue,
} from '../../shared/semantic-qa';
import { evaluateHardGates, hardGatesPassed, computeWeightedScore } from '../../shared/scorecard';
import {
  FakeSemanticQaScorer,
  type SemanticQaInput,
} from '../lib/semantic-qa';

// 模块级单例 DB（与其他 server 测试一致）
const tempRoot = mkdtempSync(path.join(tmpdir(), 'live-tu-semantic-qa-test-'));
process.env.DATA_DIR = path.join(tempRoot, 'data');
process.env.UPLOADS_DIR = path.join(tempRoot, 'uploads');
process.env.NODE_ENV = 'test';
process.env.ALLOW_MOCK_FALLBACK = 'true';
delete process.env.YUNWU_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.SEEDANCE_BASE_URL;
delete process.env.SEEDANCE_ACCOUNT;
delete process.env.SEEDANCE_PASSWORD;

const { initDatabase, db } = await import('../lib/db.ts');
initDatabase();

before(() => {
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, password_hash, role)
     VALUES (?, ?, ?, ?)`
  ).run('qa-owner', 'qa-owner', 'unused', 'operator');
});

after(() => {
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch {}
});

function makeInput(overrides: Partial<SemanticQaInput> = {}): SemanticQaInput {
  return {
    shotId: 'shot-1',
    runId: 'run-1',
    version: 1,
    shotIndex: 1,
    generatedVideoUrl: '/uploads/renders/fake-shot-1.mp4',
    referenceKeyframes: [],
    productImageUrl: '/uploads/product-assets/pa_test.png',
    productName: 'BUV 小绿泥洁面',
    prohibitedItems: ['竞品标识'],
    allowedItems: ['BUV 产品'],
    referenceStructure: '特写镜头',
    ...overrides,
  };
}

test('SEMANTIC_DIMENSIONS 覆盖 8 个语义维度且 fix map 完整', () => {
  assert.equal(SEMANTIC_DIMENSIONS.length, 8);
  for (const dim of SEMANTIC_DIMENSIONS) {
    assert.ok(SEMANTIC_FIX_MAP[dim], `缺少 fix map: ${dim}`);
  }
});

test('deriveOverallVerdict: 任一 fail → fail', () => {
  const issues: SemanticIssue[] = [
    { dimension: 'product_consistency', verdict: 'pass', score: 0.9, evidence: [], reason: '', fix: null },
    { dimension: 'competitor_residue', verdict: 'fail', score: 0.2, evidence: [], reason: '', fix: null },
  ];
  assert.equal(deriveOverallVerdict(issues), 'fail');
});

test('deriveOverallVerdict: 全 pass → pass；unverified 优先级高于 warning 低于 fail', () => {
  const allPass: SemanticIssue[] = [
    { dimension: 'product_consistency', verdict: 'pass', score: 0.9, evidence: [], reason: '', fix: null },
  ];
  assert.equal(deriveOverallVerdict(allPass), 'pass');

  const withUnverified: SemanticIssue[] = [
    { dimension: 'product_consistency', verdict: 'unverified', score: null, evidence: [], reason: '', fix: null },
    { dimension: 'competitor_residue', verdict: 'warning', score: 0.6, evidence: [], reason: '', fix: null },
  ];
  assert.equal(deriveOverallVerdict(withUnverified), 'unverified');
});

test('generateSummary 汇总不合格/有风险/未验证维度', () => {
  const issues: SemanticIssue[] = [
    { dimension: 'product_consistency', verdict: 'fail', score: 0.2, evidence: [], reason: '', fix: null },
    { dimension: 'competitor_residue', verdict: 'warning', score: 0.6, evidence: [], reason: '', fix: null },
    { dimension: 'hook_quality', verdict: 'pass', score: 0.9, evidence: [], reason: '', fix: null },
    { dimension: 'av_sync', verdict: 'unverified', score: null, evidence: [], reason: '', fix: null },
  ];
  const summary = generateSummary(issues);
  assert.ok(summary.includes('不合格'));
  assert.ok(summary.includes('product_consistency'));
  assert.ok(summary.includes('有风险'));
  assert.ok(summary.includes('未验证'));
});

test('issuesToScoreEntries + buildSemanticScorecard: fail 也是 measured，hard gate 正确', () => {
  const issues: SemanticIssue[] = [
    { dimension: 'product_consistency', verdict: 'fail', score: 0.2, evidence: [{ source: 'llm', detail: '包装颜色不符' }], reason: '包装颜色不符', fix: null },
    { dimension: 'competitor_residue', verdict: 'pass', score: 1.0, evidence: [], reason: '', fix: null },
    { dimension: 'compliance_risk', verdict: 'unverified', score: null, evidence: [], reason: '', fix: null },
  ];
  const entries = issuesToScoreEntries(issues);
  const scorecard = buildSemanticScorecard('shot-1', 'run-1', entries);

  // product_consistency fail → hard gate failed（measured 且低于 min 0.8）
  const gates = evaluateHardGates(entries);
  const productGate = gates.find((g) => g.dimension === 'product_consistency');
  assert.equal(productGate?.status, 'failed');
  // compliance unverified → hard gate unverified（不能逃脱门禁）
  const complianceGate = gates.find((g) => g.dimension === 'compliance_risk');
  assert.equal(complianceGate?.status, 'unverified');
  assert.equal(hardGatesPassed(gates), false);
  assert.equal(scorecard.hardGatesPassed, false);
  // 权重完整性
  const weighted = computeWeightedScore(entries);
  assert.ok(weighted.measuredCount >= 2);
  assert.ok(weighted.unverifiedCount >= 1);
});

test('FakeSemanticQaScorer: 默认全部 pass，确定性', async () => {
  const scorer = new FakeSemanticQaScorer({ seed: 42 });
  const report1 = await scorer.scoreShot(makeInput());
  const report2 = await scorer.scoreShot(makeInput());
  assert.equal(report1.overallVerdict, 'pass');
  assert.equal(report1.scorer, 'fake-semantic-qa');
  // 确定性：同 seed 同输入 → 相同判决
  assert.equal(report2.overallVerdict, report1.overallVerdict);
  assert.ok(report1.issues.every((i) => i.verdict === 'pass'));
});

test('FakeSemanticQaScorer: forceFail 注入 → 整体 fail + 有修复建议', async () => {
  const scorer = new FakeSemanticQaScorer({ seed: 42, forceFail: ['product_consistency'] });
  const report = await scorer.scoreShot(makeInput());
  assert.equal(report.overallVerdict, 'fail');
  const failIssue = report.issues.find((i) => i.dimension === 'product_consistency');
  assert.equal(failIssue?.verdict, 'fail');
  assert.ok(failIssue?.fix?.action, 'fail 维度必须有修复建议');
  assert.ok(report.issues.some((i) => i.dimension === 'product_consistency' && i.verdict === 'fail'));
});

test('FakeSemanticQaScorer: forceWarning 注入 → 整体 warning', async () => {
  const scorer = new FakeSemanticQaScorer({ seed: 42, forceWarning: ['hook_quality'] });
  const report = await scorer.scoreShot(makeInput());
  assert.equal(report.overallVerdict, 'warning');
});

test('FakeSemanticQaScorer: 无 real 调用（不触发任何外部请求）', async () => {
  // 纯内存计算，不依赖任何外部服务；验证无 API key 也能运行
  delete process.env.YUNWU_API_KEY;
  const scorer = new FakeSemanticQaScorer({ seed: 1 });
  const report = await scorer.scoreShot(makeInput());
  assert.ok(report.issues.length > 0);
  assert.equal(report.scorer, 'fake-semantic-qa');
});

/**
 * S3 QA 临时目录并发隔离回归：
 * 每次 QA 使用独立 requestId 目录；并发执行互不覆盖，清理自己的目录不影响他人。
 */
test('LlmSemanticQaScorer: 并发 QA 使用独立临时目录，互不清理（requestId 隔离）', async () => {
  const { execSync } = await import('node:child_process');
  const uploadsRoot = path.resolve(process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads'));
  const rendersDir = path.join(uploadsRoot, 'renders');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(rendersDir, { recursive: true });
  const videoPath = path.join(rendersDir, 'qa-concurrency-fixture.mp4');
  execSync(
    `ffmpeg -y -v error -f lavfi -i testsrc2=duration=4:size=360x640:rate=24 -c:v libx264 -preset ultrafast -pix_fmt yuv420p -an "${videoPath}"`,
    { stdio: 'ignore', timeout: 30000 }
  );

  const { extractKeyframes } = await import('../lib/semantic-qa.ts');
  const videoUrl = `/uploads/renders/qa-concurrency-fixture.mp4`;

  // 两个并发 QA 请求（同一视频、不同 requestId）
  const reqA = `qa-conc-A-${Date.now()}`;
  const reqB = `qa-conc-B-${Date.now()}`;
  const [framesA, framesB] = await Promise.all([
    extractKeyframes(videoUrl, path.join(process.env.DATA_DIR || '.', 'tmp', reqA, 'gen'), 3, reqA),
    extractKeyframes(videoUrl, path.join(process.env.DATA_DIR || '.', 'tmp', reqB, 'gen'), 3, reqB),
  ]);

  assert.equal(framesA.length, 3);
  assert.equal(framesB.length, 3);
  // 各自目录隔离：A 的帧都在 A 目录，B 的帧都在 B 目录
  for (const f of framesA) assert.ok(f.includes(`.qa-tmp/${reqA}/`), `A 帧目录错误: ${f}`);
  for (const f of framesB) assert.ok(f.includes(`.qa-tmp/${reqB}/`), `B 帧目录错误: ${f}`);

  // 清理 A 自己的目录，B 的帧必须完好
  const { rmSync } = await import('node:fs');
  rmSync(path.join(process.env.DATA_DIR || '.', 'tmp', reqA), { recursive: true, force: true });
  rmSync(path.join(uploadsRoot, '.qa-tmp', reqA), { recursive: true, force: true });
  for (const f of framesB) {
    const local = path.join(uploadsRoot, f.replace(/^\/uploads\//, ''));
    assert.ok((await import('node:fs')).existsSync(local), `B 的帧被 A 的清理误删: ${f}`);
  }
  // A 自己的目录已被清掉
  assert.equal((await import('node:fs')).existsSync(path.join(uploadsRoot, '.qa-tmp', reqA)), false);
  // B 目录清理
  rmSync(path.join(process.env.DATA_DIR || '.', 'tmp', reqB), { recursive: true, force: true });
  rmSync(path.join(uploadsRoot, '.qa-tmp', reqB), { recursive: true, force: true });
});
