/**
 * Dual-input contract, product assets, migration plan, first-frame wiring, publish gate.
 * Exercises real shipped modules (no re-implemented stubs of units under test).
 */
import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import express from 'express';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'live-tu-dual-input-'));
process.env.DATA_DIR = path.join(tempRoot, 'data');
process.env.UPLOADS_DIR = path.join(tempRoot, 'uploads');
process.env.NODE_ENV = 'test';
process.env.ALLOW_MOCK_FALLBACK = 'false';
process.env.PIPELINE_WORKER_DISABLED = 'true';

const { db, initDatabase } = await import('../lib/db');
initDatabase();

const { buildShotMigrationPlan } = await import('../lib/migration-plan');
const { evaluatePublishGate, gateAllowsCompleted } = await import('../lib/publish-gate');
const {
  assertViralDualInput,
  PipelineOrchestrator,
} = await import('../lib/pipeline-orchestrator');
const { insertProductAsset, listProductAssets, resolveRunProductAssets } = await import(
  '../lib/product-assets'
);
const { productsRouter } = await import('../routes/products');
const { requireAuth } = await import('../lib/auth');

function passwordHash(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

const password = 'dual-input-test';
db.prepare(
  `INSERT INTO users (id, username, password_hash, role)
   VALUES (?, ?, ?, ?)`
).run('admin-dual', 'admin_dual', passwordHash(password), 'admin');

// Ensure seed product exists
const productRow = db.prepare('SELECT id FROM products WHERE id = ?').get('prod_buv_cleanser');
if (!productRow) {
  db.prepare(
    `INSERT INTO products (id, name, category, positioning, price, sales_record)
     VALUES ('prod_buv_cleanser', 'Test Cleanser', '护肤', '测试定位', '49', 'test')`
  ).run();
}

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  // inject admin for product asset routes under test when cookie not present —
  // prefer real login
  next();
});
app.use('/api/auth', (await import('../lib/auth')).authRouter);
app.use('/api/products', requireAuth, productsRouter);

const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const address = server.address();
assert.ok(address && typeof address === 'object');
const baseUrl = `http://127.0.0.1:${address.port}`;

let cookie = '';

async function login() {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin_dual', password }),
  });
  const setCookie = res.headers.getSetCookie?.() || [];
  cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  if (!cookie) {
    const raw = res.headers.get('set-cookie');
    if (raw) cookie = raw.split(';')[0];
  }
  assert.equal(res.status, 200, 'login should succeed');
}

before(async () => {
  await login();
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

// ---------- pure builders ----------

test('buildShotMigrationPlan requires product assets and marks product_conditioned frames', () => {
  assert.throws(
    () =>
      buildShotMigrationPlan(
        { shotList: [{ shotIndex: 1, description: 'hook' }] },
        []
      ),
    /产品视觉资产缺失/
  );

  const plan = buildShotMigrationPlan(
    {
      shotList: [
        {
          shotIndex: 1,
          shotType: 'Hook',
          description: 'hook',
          keyframeUrl: '/uploads/materials/keyframes/viral_kf.jpg',
        },
        { shotIndex: 2, shotType: 'Demo', description: 'demo' },
        { shotIndex: 3, shotType: 'CTA', description: 'cta' },
      ],
      style: '抖音卡点',
      migrationHints: {
        mustKeep: ['前3秒Hook'],
        mustReplace: ['竞品包装'],
      },
    },
    [
      { id: 'pa1', url: '/uploads/product-assets/hero.png', role: 'hero' },
      { id: 'pa2', url: '/uploads/product-assets/angle.png', role: 'angle' },
    ],
    { productName: '小绿泥' }
  );

  assert.equal(plan.firstFrameSource, 'product_conditioned');
  assert.equal(plan.productHeroUrl, '/uploads/product-assets/hero.png');
  assert.ok(plan.shots.length >= 3);
  for (const shot of plan.shots) {
    assert.equal(shot.firstFrameSource, 'product_conditioned');
    assert.ok(shot.productFirstFrameUrl.startsWith('/uploads/product-assets/'));
    assert.notEqual(
      shot.productFirstFrameUrl,
      '/uploads/materials/keyframes/viral_kf.jpg',
      'final first frame must not be viral keyframe'
    );
    assert.ok(shot.productAssetIds.includes('pa1') || shot.productAssetIds.length > 0);
  }
  // structure ref may still hold viral keyframe
  assert.equal(plan.shots[0].referenceKeyframeUrl, '/uploads/materials/keyframes/viral_kf.jpg');
});

test('evaluatePublishGate blocks mock when fallback disabled and viral first frames', () => {
  const mockFail = evaluatePublishGate({
    videoUrl: '/uploads/renders/x.mp4',
    source: 'mock',
    durationSec: 20,
    resolution: '1080x1920',
    isMockFallback: true,
    allowMockFallback: false,
    firstFrameSource: 'product_conditioned',
  });
  assert.equal(mockFail.passed, false);
  assert.ok(mockFail.blockers.includes('mock_result_not_publishable'));
  assert.equal(gateAllowsCompleted(mockFail, false), false);

  const missingVideo = evaluatePublishGate({
    videoUrl: '',
    source: 'ffmpeg',
    allowMockFallback: false,
  });
  assert.equal(missingVideo.passed, false);
  assert.ok(missingVideo.blockers.includes('missing_video_url'));

  const viralFrame = evaluatePublishGate({
    videoUrl: '/uploads/renders/x.mp4',
    source: 'ffmpeg',
    durationSec: 20,
    resolution: '1080x1920',
    firstFrameSource: 'viral_keyframe',
    allowMockFallback: false,
  });
  assert.equal(viralFrame.passed, false);
  assert.ok(viralFrame.blockers.includes('final_first_frame_is_viral_not_product'));

  const ok = evaluatePublishGate({
    videoUrl: '/uploads/renders/final.mp4',
    source: 'ffmpeg',
    durationSec: 20,
    resolution: '1080x1920',
    firstFrameSource: 'product_conditioned',
    allowMockFallback: false,
    narrativeBeatsPresent: true,
    clipCount: 4,
  });
  assert.equal(ok.passed, true);
  assert.equal(ok.status, 'passed');
  assert.equal(gateAllowsCompleted(ok, false), true);
});

// ---------- dual-input at orchestrator start ----------

test('assertViralDualInput / orchestrator.start reject viral mode without product assets', () => {
  // clear product assets for cleanser
  db.prepare('DELETE FROM product_assets WHERE product_id = ?').run('prod_buv_cleanser');
  db.prepare('UPDATE products SET cover_image = NULL WHERE id = ?').run('prod_buv_cleanser');

  assert.throws(
    () =>
      assertViralDualInput({
        ownerId: 'admin-dual',
        idempotencyKey: 'k1',
        productId: 'prod_buv_cleanser',
        directOutMode: 'viral',
        pipelineData: {
          directOutMode: 'viral',
          step1: { inputs: { mediaUrl: '/uploads/materials/viral.mp4' } },
        },
      }),
    (err: any) => err?.code === 'MISSING_PRODUCT_ASSETS' || /产品图/.test(String(err?.message))
  );

  const orchestrator = new PipelineOrchestrator('http://unused');
  assert.throws(
    () =>
      orchestrator.start({
        ownerId: 'admin-dual',
        idempotencyKey: 'k-no-assets',
        productId: 'prod_buv_cleanser',
        directOutMode: 'viral',
        pipelineData: {
          directOutMode: 'viral',
          step1: { inputs: { mediaUrl: 'https://example.com/viral.mp4' } },
          step2: { inputs: {} },
          step3: { inputs: {} },
          step4: { inputs: {} },
          step5: { inputs: {} },
        },
      }),
    (err: any) => Number(err?.status) === 400 || /产品图/.test(String(err?.message))
  );
});

test('orchestrator accepts viral mode when product assets exist; step2 body uses product frame', async () => {
  insertProductAsset({
    id: 'pa_test_hero',
    productId: 'prod_buv_cleanser',
    role: 'hero',
    url: '/uploads/product-assets/hero_test.png',
    filePath: 'uploads/product-assets/hero_test.png',
    sortOrder: 0,
    ownerId: 'admin-dual',
  });

  const assets = resolveRunProductAssets({
    productId: 'prod_buv_cleanser',
    productAssetIds: ['pa_test_hero'],
  });
  assert.equal(assets.length, 1);
  assert.equal(assets[0].url, '/uploads/product-assets/hero_test.png');

  let capturedStep2Body: any = null;
  const fakeExecutor = {
    async execute(step: number, body: unknown) {
      if (step === 2) capturedStep2Body = body;
      const outputs: Record<number, any> = {
        1: {
          static_image_prompt: 'prompt',
          shotList: [
            {
              shotIndex: 1,
              description: 'hook',
              keyframeUrl: '/uploads/materials/keyframes/viral_only.jpg',
            },
            { shotIndex: 2, description: 'demo' },
          ],
        },
        2: {
          video_prompt: 'motion',
          firstFrameSource: 'product_conditioned',
          productFirstFrameUrl: '/uploads/product-assets/hero_test.png',
          previewVideoUrl: '/uploads/renders/preview.mp4',
        },
        3: { title: 't', hook: 'h', cta: 'c' },
        4: { bgm_recommendation: { track_name: 't', audioSampleUrl: '/uploads/bgm/a.mp3' } },
        5: {
          videoUrl: '/uploads/renders/final.mp4',
          publishReport: { passed: true, status: 'passed' },
        },
      };
      return { data: outputs[step], source: 'fake' };
    },
    async pollSeedance() {
      throw new Error('not expected');
    },
    async pollShotSession() {
      throw new Error('not expected');
    },
  };

  process.env.PIPELINE_WORKER_DISABLED = 'false';
  const orchestrator = new PipelineOrchestrator('http://unused', fakeExecutor as any);
  const run = orchestrator.start({
    ownerId: 'admin-dual',
    idempotencyKey: 'k-with-assets-' + Date.now(),
    productId: 'prod_buv_cleanser',
    productAssetIds: ['pa_test_hero'],
    directOutMode: 'viral',
    pipelineData: {
      directOutMode: 'viral',
      productAssetIds: ['pa_test_hero'],
      step1: { inputs: { mediaUrl: 'https://example.com/viral-ref.mp4' } },
      step2: { inputs: {} },
      step3: { inputs: {} },
      step4: { inputs: {} },
      step5: { inputs: {} },
    },
  });

  const deadline = Date.now() + 8_000;
  let snapshot = orchestrator.get(run.id, 'admin-dual', true);
  while (Date.now() < deadline && !['completed', 'failed', 'cancelled'].includes(snapshot.status)) {
    await new Promise((r) => setTimeout(r, 30));
    snapshot = orchestrator.get(run.id, 'admin-dual', true);
  }
  assert.equal(snapshot.status, 'completed', snapshot.errorMessage || 'run should complete');
  assert.ok(capturedStep2Body, 'step2 body should be captured');
  assert.equal(
    capturedStep2Body.imageUrl,
    '/uploads/product-assets/hero_test.png',
    'final first frame must be product asset'
  );
  assert.notEqual(
    capturedStep2Body.imageUrl,
    'https://example.com/viral-ref.mp4',
    'must not use viral media as final first frame'
  );
  assert.equal(capturedStep2Body.firstFrameSource, 'product_conditioned');
  assert.equal(capturedStep2Body.viralMediaUrl, 'https://example.com/viral-ref.mp4');
  process.env.PIPELINE_WORKER_DISABLED = 'true';
});

// ---------- product assets HTTP API ----------

test('POST/GET product assets API attaches and lists assets', async () => {
  const productId = 'prod_buv_cleanser';
  const addRes = await fetch(`${baseUrl}/api/products/${productId}/assets`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
    },
    body: JSON.stringify({
      url: '/uploads/product-assets/api_hero.jpg',
      role: 'hero',
      sortOrder: 0,
    }),
  });
  const addJson = await addRes.json();
  assert.ok(addRes.status === 201 || addRes.status === 200, JSON.stringify(addJson));
  assert.equal(addJson.success, true);
  assert.ok(addJson.data?.id);
  assert.equal(addJson.data?.url, '/uploads/product-assets/api_hero.jpg');

  const listRes = await fetch(`${baseUrl}/api/products/${productId}/assets`, {
    headers: { Cookie: cookie },
  });
  const listJson = await listRes.json();
  assert.equal(listRes.status, 200);
  assert.equal(listJson.success, true);
  assert.ok(Array.isArray(listJson.data));
  assert.ok(listJson.data.some((a: any) => a.url === '/uploads/product-assets/api_hero.jpg'));

  const listed = listProductAssets(productId);
  assert.ok(listed.length >= 1);
});

test('S0 provenance: product_conditioned claim requires real first-frame evidence URL', async () => {
  const { resolveFirstFrameSource } = await import('../lib/publish-gate');
  // 有证据：声明保留（step2 输出携带 productHeroFrameUrl / firstFrameEvidenceUrl）
  assert.equal(
    resolveFirstFrameSource('product_conditioned', ['/uploads/product-assets/hero.jpg']),
    'product_conditioned'
  );
  // 无证据：声明降级为 undefined（例如直接拿爆款原片渲染，门禁不得给假确定性加分）
  assert.equal(resolveFirstFrameSource('product_conditioned', [undefined, null, '']), undefined);
  assert.equal(resolveFirstFrameSource('product_conditioned', []), undefined);
  // 非 product_conditioned 声明原样透传
  assert.equal(resolveFirstFrameSource('viral_keyframe', ['/x.jpg']), 'viral_keyframe');
  assert.equal(resolveFirstFrameSource(undefined, ['/x.jpg']), undefined);

  // 门禁侧联动：无证据的降级走 warning（first_frame_source_unspecified），不硬失败
  const report = evaluatePublishGate({
    videoUrl: '/uploads/renders/final.mp4',
    source: 'ffmpeg',
    durationSec: 15,
    resolution: '1080x1920',
    firstFrameSource: resolveFirstFrameSource('product_conditioned', []),
    allowMockFallback: false,
  });
  assert.ok(report.warnings.includes('first_frame_source_unspecified'));
  assert.equal(report.scores.productIdentity, 0.55, '无证据时不得拿到 product_conditioned 的 0.85');
});

// ---------- viral_recreation_v2 模式 ----------

test('orchestrator: viral_recreation_v2 模式识别 + 双输入强制', async () => {
  const { isViralRecreationV2Mode, isViralDirectOutMode } = await import('../lib/pipeline-orchestrator');

  // 模式识别：directOutMode / pipelineData 两处都能识别
  assert.equal(
    isViralRecreationV2Mode({
      ownerId: 'admin-dual',
      idempotencyKey: 'v2-k1',
      directOutMode: 'viral_recreation_v2',
      pipelineData: {},
    }),
    true
  );
  assert.equal(
    isViralRecreationV2Mode({
      ownerId: 'admin-dual',
      idempotencyKey: 'v2-k2',
      pipelineData: { mode: 'viral_recreation_v2' },
    }),
    true
  );
  // 旧模式不受影响
  assert.equal(
    isViralRecreationV2Mode({
      ownerId: 'admin-dual',
      idempotencyKey: 'v2-k3',
      directOutMode: 'viral',
      pipelineData: {},
    }),
    false
  );
  // viral_recreation_v2 属于直出模式家族（双输入强制生效）
  assert.equal(
    isViralDirectOutMode({
      ownerId: 'admin-dual',
      idempotencyKey: 'v2-k4',
      directOutMode: 'viral_recreation_v2',
      pipelineData: {},
    }),
    true
  );

  // 双输入强制：缺产品图 → MISSING_PRODUCT_ASSETS
  db.prepare('DELETE FROM product_assets WHERE product_id = ?').run('prod_buv_cleanser');
  db.prepare('UPDATE products SET cover_image = NULL WHERE id = ?').run('prod_buv_cleanser');
  assert.throws(
    () =>
      assertViralDualInput({
        ownerId: 'admin-dual',
        idempotencyKey: 'v2-k5',
        productId: 'prod_buv_cleanser',
        directOutMode: 'viral_recreation_v2',
        pipelineData: {
          directOutMode: 'viral_recreation_v2',
          step1: { inputs: { mediaUrl: 'https://example.com/viral-ref.mp4' } },
        },
      }),
    (err: any) => err?.code === 'MISSING_PRODUCT_ASSETS' || /产品图/.test(String(err?.message))
  );
  // 缺爆款素材 → MISSING_VIRAL_MEDIA（需先有产品资产，否则先触发 MISSING_PRODUCT_ASSETS）
  insertProductAsset({
    id: 'pa_v2_test',
    productId: 'prod_buv_cleanser',
    role: 'hero',
    url: '/uploads/product-assets/v2_test.png',
    filePath: 'uploads/product-assets/v2_test.png',
    sortOrder: 0,
    ownerId: 'admin-dual',
  });
  assert.throws(
    () =>
      assertViralDualInput({
        ownerId: 'admin-dual',
        idempotencyKey: 'v2-k6',
        productId: 'prod_buv_cleanser',
        productAssetIds: ['pa_v2_test'],
        directOutMode: 'viral_recreation_v2',
        pipelineData: {
          directOutMode: 'viral_recreation_v2',
          step1: { inputs: {} },
        },
      }),
    (err: any) => err?.code === 'MISSING_VIRAL_MEDIA' || /爆款素材/.test(String(err?.message))
  );
});
