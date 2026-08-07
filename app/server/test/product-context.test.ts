import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'live-tu-product-context-'));
process.env.DATA_DIR = path.join(tempRoot, 'data');
process.env.UPLOADS_DIR = path.join(tempRoot, 'uploads');
process.env.NODE_ENV = 'test';

const { db, initDatabase } = await import('../lib/db');
const {
  assertPublishableVideoContext,
  markStaleArtifactsExceptProduct,
  registerGeneratedMedia,
  isTrustedFirstFrameEvidence,
} = await import('../lib/publish-context');
const { PipelineOrchestrator } = await import('../lib/pipeline-orchestrator');
type StepExecutor = import('../lib/pipeline-orchestrator').StepExecutor;

before(() => {
  initDatabase();
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role)
     VALUES ('ctx-owner', 'ctx', 'not-used', 'operator')`
  ).run();
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role)
     VALUES ('other-owner', 'other', 'not-used', 'operator')`
  ).run();
});

after(() => {
  db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** 用 fake executor 跑一个绑定指定产品的完整 Run，等待落库后返回 run id */
async function runPipelineFor(
  ownerId: string,
  productId: string,
  idempotencyKey: string,
  previewUrl: string
): Promise<string> {
  const fakeExecutor: StepExecutor = {
    async execute(step) {
      if (step === 1) return { data: { static_image_prompt: 'prompt', shotList: [] }, source: 'fake' };
      if (step === 2) {
        return { data: { video_prompt: 'motion', previewVideoUrl: previewUrl }, source: 'fake' };
      }
      if (step === 3) return { data: { title: 'title', hook: 'hook', cta: 'cta' }, source: 'fake' };
      if (step === 4) return { data: { bgm_recommendation: { track_name: 'track' } }, source: 'fake' };
      return {
        data: {
          videoUrl: previewUrl.replace('preview', 'final'),
          publishReport: { passed: true, status: 'passed', blockers: [], warnings: [] },
        },
        source: 'fake',
      };
    },
    async pollSeedance() { throw new Error('not expected'); },
    async pollShotSession() { throw new Error('not expected'); },
    async submitShot() { throw new Error('not expected'); },
  };
  const orchestrator = new PipelineOrchestrator('http://unused', fakeExecutor);
  const id = orchestrator.start({
    ownerId,
    idempotencyKey,
    productId,
    pipelineData: {
      step1: { inputs: { mediaUrl: 'https://example.com/reference.mp4' } },
      step2: { inputs: { videoModel: 'Seedance 2.0 Fast' } },
      step3: { inputs: {} },
      step4: { inputs: {} },
      step5: { inputs: {} },
    },
  }).id;
  // 编排是异步落库的：等待 5 个 step artifact 全部写入（最多 5s）
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const count = (
      db.prepare('SELECT COUNT(*) AS count FROM artifacts WHERE run_id = ?').get(id) as { count: number }
    ).count;
    if (count >= 5) return id;
    // 失败态也算跑完（避免死等）：检查 run 是否失败
    const run = db.prepare('SELECT status FROM pipeline_runs WHERE id = ?').get(id) as { status: string };
    if (['failed', 'cancelled'].includes(run.status)) return id;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`run ${id} artifacts did not land within 5s`);
}

test('S0: context-switch marks own other-product artifacts stale; publish guard blocks them', async () => {
  const productA = 'prod_buv_cleanser';
  const productB = 'prod_copper_serum';
  const urlA = '/uploads/renders/ctx-a-preview.mp4';
  const urlB = '/uploads/renders/ctx-b-preview.mp4';

  const runA = await runPipelineFor('ctx-owner', productA, 'ctx-run-a', urlA);
  const runB = await runPipelineFor('ctx-owner', productB, 'ctx-run-b', urlB);

  // 切换前：各自绑定自己产品的产物都可以通过校验（携带当前 revision）
  const revOf = (id: string) =>
    String((db.prepare('SELECT revision FROM products WHERE id = ?').get(id) as { revision: number }).revision);
  assert.equal(assertPublishableVideoContext(productA, [urlA], revOf(productA), 'ctx-owner').ok, true);
  assert.equal(assertPublishableVideoContext(productB, [urlB], revOf(productB), 'ctx-owner').ok, true);

  // 跨产品引用必须被拒绝（旧产品产物冒充新产品结果）
  const mismatch = assertPublishableVideoContext(productB, [urlA], revOf(productB), 'ctx-owner');
  assert.equal(mismatch.ok, false);
  assert.ok(mismatch.ok === false && mismatch.code === 'PRODUCT_MISMATCH');

  // 切换到 B：ctx-owner 名下 A 的产物全部 stale
  const { staleCount } = markStaleArtifactsExceptProduct(productB, 'ctx-owner');
  assert.ok(staleCount >= 5, `至少作废 A 的 5 个产物，实际 ${staleCount}`);
  assert.equal(
    (db.prepare('SELECT stale FROM artifacts WHERE run_id = ? AND step_number = 2').get(runA) as { stale: number }).stale,
    1
  );
  // B 自己的产物不受影响
  assert.equal(
    (db.prepare('SELECT stale FROM artifacts WHERE run_id = ? AND step_number = 2').get(runB) as { stale: number }).stale,
    0
  );

  // stale 产物：即使绑定产品匹配也禁止发布
  const staleVerdict = assertPublishableVideoContext(productA, [urlA], revOf(productA), 'ctx-owner');
  assert.equal(staleVerdict.ok, false);
  assert.ok(staleVerdict.ok === false && staleVerdict.code === 'STALE_ARTIFACT');
});

test('S0 P0 fix: another user switching products must NOT stale my artifacts', async () => {
  const productA = 'prod_buv_cleanser';
  const productB = 'prod_copper_serum';
  const urlMine = '/uploads/renders/ctx-mine-preview.mp4';
  const urlOther = '/uploads/renders/ctx-other-preview.mp4';

  const myRun = await runPipelineFor('ctx-owner', productA, 'ctx-run-mine', urlMine);
  // 其他用户（另一个 owner）绑定 A 的 run
  const otherRun = await runPipelineFor('other-owner', productA, 'ctx-run-other', urlOther);

  // other-owner 切换到 B：只应作废 other-owner 自己的 A 产物
  const { staleCount } = markStaleArtifactsExceptProduct(productB, 'other-owner');
  assert.ok(staleCount >= 5, `other-owner 自己的 A 产物应被作废，实际 ${staleCount}`);
  assert.equal(
    (db.prepare('SELECT stale FROM artifacts WHERE run_id = ? AND step_number = 2').get(otherRun) as { stale: number }).stale,
    1,
    'other-owner 的产物必须被作废'
  );
  assert.equal(
    (db.prepare('SELECT stale FROM artifacts WHERE run_id = ? AND step_number = 2').get(myRun) as { stale: number }).stale,
    0,
    'P0：我的产物绝不能被其他用户的切换作废'
  );
  // 我的产物仍可通过发布校验（携带当前 revision）
  const revOf = (id: string) =>
    String((db.prepare('SELECT revision FROM products WHERE id = ?').get(id) as { revision: number }).revision);
  assert.equal(assertPublishableVideoContext(productA, [urlMine], revOf(productA), 'ctx-owner').ok, true);
});

test('S0 P1 fix: publish guard blocks artifacts from an outdated product version', async () => {
  const productA = 'prod_buv_cleanser';
  const urlA = '/uploads/renders/ctx-ver-preview.mp4';
  const run = await runPipelineFor('ctx-owner', productA, 'ctx-run-ver', urlA);
  const artifact = db
    .prepare('SELECT product_version FROM artifacts WHERE run_id = ? AND step_number = 2')
    .get(run) as { product_version: string | null };
  assert.ok(artifact.product_version, 'run 应记录 product_version');

  // 版本一致 → 放行
  assert.equal(assertPublishableVideoContext(productA, [urlA], artifact.product_version, 'ctx-owner').ok, true);
  // 版本不一致（产品信息被修改）→ 阻断
  const verdict = assertPublishableVideoContext(productA, [urlA], '2099-01-01 00:00:00', 'ctx-owner');
  assert.equal(verdict.ok, false);
  assert.ok(verdict.ok === false && verdict.code === 'PRODUCT_VERSION_MISMATCH');
});

test('S0: publish guard passes for unbound/external URLs (no provenance to trace)', () => {
  assert.equal(assertPublishableVideoContext(undefined, ['https://cdn.example.com/uploaded.mp4'], null, 'ctx-owner').ok, true);
  assert.equal(assertPublishableVideoContext('prod_buv_cleanser', [null, undefined], null, 'ctx-owner').ok, true);
});

test('S0 P1 fix: same-second product edit invalidates old artifacts via monotonic revision', async () => {
  const productA = 'prod_buv_cleanser';
  const urlA = '/uploads/renders/ctx-rev-preview.mp4';
  const run = await runPipelineFor('ctx-owner', productA, 'ctx-run-rev', urlA);
  const before = db.prepare('SELECT revision FROM products WHERE id = ?').get(productA) as {
    revision: number;
  };
  const artifact = db
    .prepare('SELECT product_version FROM artifacts WHERE run_id = ? AND step_number = 2')
    .get(run) as { product_version: string | null };
  assert.equal(artifact.product_version, String(before.revision));

  // 同秒内编辑产品：updated_at 不变，但 revision 必须递增
  db.prepare('UPDATE products SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(productA);
  const after = db.prepare('SELECT revision, updated_at FROM products WHERE id = ?').get(productA) as {
    revision: number;
    updated_at: string;
  };
  assert.equal(after.revision, before.revision + 1);

  // 旧 revision 的成片必须被阻断
  const verdict = assertPublishableVideoContext(productA, [urlA], String(after.revision), 'ctx-owner');
  assert.equal(verdict.ok, false);
  assert.ok(verdict.ok === false && verdict.code === 'PRODUCT_VERSION_MISMATCH');
  // 重新生成（新 URL + 新 revision 登记）后放行；
  // 同 URL 的旧 artifact 记录按保守语义保持阻断（真实生成的文件名带时间戳，不会同 URL）
  const newUrl = '/uploads/renders/ctx-rev-regenerated.mp4';
  registerGeneratedMedia(productA, after.revision, [newUrl], 'ctx-owner');
  assert.equal(assertPublishableVideoContext(productA, [newUrl], String(after.revision), 'ctx-owner').ok, true);
  const stillOld = assertPublishableVideoContext(productA, [urlA], String(after.revision), 'ctx-owner');
  assert.equal(stillOld.ok, false);
});

test('S0 P1 fix: first-frame provenance evidence must be server-verifiable, not client-claimed', () => {
  const productA = 'prod_buv_cleanser';
  // 客户端伪造任意非空字符串 → 不可信
  assert.equal(isTrustedFirstFrameEvidence(productA, 'https://evil.example.com/fake.png', 'ctx-owner'), false);
  assert.equal(isTrustedFirstFrameEvidence(productA, '', 'ctx-owner'), false);
  assert.equal(isTrustedFirstFrameEvidence(undefined, '/uploads/x.png', 'ctx-owner'), false);
  // product_assets 中登记的真实产品资产 → 可信
  db.prepare(
    `INSERT INTO product_assets (id, product_id, role, url) VALUES ('pa-trust-test', ?, 'hero', '/uploads/product-assets/real-hero.jpg')`
  ).run(productA);
  assert.equal(isTrustedFirstFrameEvidence(productA, '/uploads/product-assets/real-hero.jpg', 'ctx-owner'), true);
  // generated_media 登记的本产品未过期产物 → 可信
  registerGeneratedMedia(productA, 1, ['/uploads/renders/real-shot.mp4'], 'ctx-owner');
  assert.equal(isTrustedFirstFrameEvidence(productA, '/uploads/renders/real-shot.mp4', 'ctx-owner'), true);
});

test('S0 P0 fix: manual pipeline outputs registered as generated_media cannot cross-publish after product switch', async () => {
  const productA = 'prod_buv_cleanser';
  const productB = 'prod_copper_serum';
  const manualUrl = '/uploads/renders/manual-step2-preview.mp4';
  const revA = (db.prepare('SELECT revision FROM products WHERE id = ?').get(productA) as { revision: number }).revision;

  // 手工 Step2 产物登记（模拟 /api/pipeline/step2 注册路径）
  const { registered } = registerGeneratedMedia(productA, revA, [manualUrl], 'ctx-owner');
  assert.equal(registered, 1);
  // 重复登记同 URI 不重复
  assert.equal(registerGeneratedMedia(productA, revA, [manualUrl], 'ctx-owner').registered, 0);

  // 本产品同版本 → 放行
  assert.equal(assertPublishableVideoContext(productA, [manualUrl], String(revA), 'ctx-owner').ok, true);

  // 切换到 B 后：同一 URL 作为 B 的成片 → 阻断（跨产品）
  const mismatch = assertPublishableVideoContext(productB, [manualUrl], String(revA), 'ctx-owner');
  assert.equal(mismatch.ok, false);
  assert.ok(mismatch.ok === false && mismatch.code === 'PRODUCT_MISMATCH');

  // 用户切到 B（作废非 B 产品产物）→ A 的登记产物 stale → 即使以 A 身份发布也阻断
  markStaleArtifactsExceptProduct(productB, 'ctx-owner');
  const stale = assertPublishableVideoContext(productA, [manualUrl], String(revA), 'ctx-owner');
  assert.equal(stale.ok, false);
  assert.ok(stale.ok === false && stale.code === 'STALE_ARTIFACT');
});

test('S0 P0 fix: one user cannot stale or claim another user manual media', () => {
  const productA = 'prod_buv_cleanser';
  const productB = 'prod_copper_serum';
  const sharedUrl = '/uploads/renders/shared-name.mp4';
  const revA = (db.prepare('SELECT revision FROM products WHERE id = ?').get(productA) as { revision: number }).revision;

  assert.equal(registerGeneratedMedia(productA, revA, [sharedUrl], 'ctx-owner').registered, 1);
  assert.equal(registerGeneratedMedia(productB, revA, [sharedUrl], 'other-owner').registered, 1);

  markStaleArtifactsExceptProduct(productB, 'other-owner');

  assert.equal(
    assertPublishableVideoContext(productA, [sharedUrl], String(revA), 'ctx-owner').ok,
    true,
    'another user switching products must not stale my manual output'
  );
  assert.equal(
    isTrustedFirstFrameEvidence(productA, sharedUrl, 'other-owner'),
    false,
    'another user must not reuse my manual output as trusted provenance'
  );
});

test('S0 P1 fix: legacy artifacts with product binding but no version are blocked', async () => {
  const productA = 'prod_buv_cleanser';
  // 模拟升级前遗留 artifact：有 product_id、product_version 为 NULL
  db.prepare(
    `INSERT INTO artifacts (id, run_id, step_number, artifact_type, uri, content_json, source, product_id, product_version)
     VALUES ('legacy-art-1', ?, 5, 'step5_output', '/uploads/renders/legacy-final.mp4', '{}', 'real', ?, NULL)`
  ).run(
    (
      db.prepare("SELECT id FROM pipeline_runs WHERE owner_id = 'ctx-owner' ORDER BY created_at, id LIMIT 1")
        .get() as { id: string }
    ).id,
    productA
  );

  const verdict = assertPublishableVideoContext(
    productA,
    ['/uploads/renders/legacy-final.mp4'],
    String((db.prepare('SELECT revision FROM products WHERE id = ?').get(productA) as { revision: number }).revision),
    'ctx-owner'
  );
  assert.equal(verdict.ok, false, 'legacy 有产品绑定但无版本记录的产物必须阻断');
  assert.ok(verdict.ok === false && verdict.code === 'PRODUCT_VERSION_MISMATCH');

  // 无产品绑定的产物（上传素材等）不受产品上下文守卫限制
  db.prepare(
    `INSERT INTO artifacts (id, run_id, step_number, artifact_type, uri, content_json, source)
     VALUES ('unbound-art-1', ?, 5, 'step5_output', '/uploads/renders/unbound-final.mp4', '{}', 'real')`
  ).run(
    (
      db.prepare("SELECT id FROM pipeline_runs WHERE owner_id = 'ctx-owner' ORDER BY created_at, id LIMIT 1")
        .get() as { id: string }
    ).id
  );
  assert.equal(assertPublishableVideoContext(productA, ['/uploads/renders/unbound-final.mp4'], null, 'ctx-owner').ok, true);
});
