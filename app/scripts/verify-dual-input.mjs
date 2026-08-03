/**
 * Evidence driver for dual-input + first-frame + publish gate (shipped modules).
 * Usage: node --import tsx scripts/verify-dual-input.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scratch =
  process.env.VERIFY_SCRATCH ||
  'C:/Users/a2691/AppData/Local/Temp/grok-goal-dacfb3113be2/implementer';

const tempRoot = path.join(scratch, `verify-${Date.now()}`);
process.env.DATA_DIR = path.join(tempRoot, 'data');
process.env.UPLOADS_DIR = path.join(tempRoot, 'uploads');
process.env.NODE_ENV = 'test';
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });

const { initDatabase, db } = await import('../server/lib/db.ts');
initDatabase();
const { evaluatePublishGate } = await import('../server/lib/publish-gate.ts');
const { buildShotMigrationPlan } = await import('../server/lib/migration-plan.ts');
const { assertViralDualInput } = await import('../server/lib/pipeline-orchestrator.ts');
const { insertProductAsset, listProductAssets } = await import('../server/lib/product-assets.ts');

const out = { at: new Date().toISOString(), checks: [] };

try {
  db.prepare(
    `INSERT OR IGNORE INTO products (id, name, category, positioning, price, sales_record)
     VALUES ('prod_buv_cleanser','C','c','p','1','s')`
  ).run();
} catch {
  /* exists */
}

db.prepare('DELETE FROM product_assets WHERE product_id = ?').run('prod_buv_cleanser');
db.prepare('UPDATE products SET cover_image = NULL WHERE id = ?').run('prod_buv_cleanser');

let rejectOk = false;
try {
  assertViralDualInput({
    ownerId: 'x',
    idempotencyKey: 'y',
    productId: 'prod_buv_cleanser',
    directOutMode: 'viral',
    pipelineData: {
      step1: { inputs: { mediaUrl: '/uploads/v.mp4' } },
      directOutMode: 'viral',
    },
  });
} catch (e) {
  rejectOk = /产品图|MISSING_PRODUCT/.test(String(e.message + e.code));
}
out.checks.push({ name: 'viral_without_assets_rejected', ok: rejectOk });

insertProductAsset({
  id: 'pa_api_1',
  productId: 'prod_buv_cleanser',
  role: 'hero',
  url: '/uploads/product-assets/hero.png',
});
const listed = listProductAssets('prod_buv_cleanser');
out.checks.push({ name: 'assets_listed', ok: listed.length >= 1, count: listed.length, assets: listed });

const plan = buildShotMigrationPlan(
  { shotList: [{ shotIndex: 1, keyframeUrl: '/uploads/materials/keyframes/v.jpg' }] },
  listed
);
out.checks.push({
  name: 'first_frame_product_not_viral',
  ok:
    plan.shots[0].productFirstFrameUrl !== '/uploads/materials/keyframes/v.jpg' &&
    plan.firstFrameSource === 'product_conditioned',
  productFirstFrameUrl: plan.shots[0].productFirstFrameUrl,
  firstFrameSource: plan.firstFrameSource,
  referenceKeyframeUrl: plan.shots[0].referenceKeyframeUrl,
});

const gateMock = evaluatePublishGate({
  videoUrl: '/uploads/renders/x.mp4',
  source: 'mock',
  isMockFallback: true,
  allowMockFallback: false,
  durationSec: 20,
  firstFrameSource: 'product_conditioned',
});
out.checks.push({
  name: 'gate_blocks_mock',
  ok: !gateMock.passed && gateMock.blockers.includes('mock_result_not_publishable'),
  report: gateMock,
});

const allOk = out.checks.every((c) => c.ok);
fs.mkdirSync(scratch, { recursive: true });
fs.writeFileSync(path.join(scratch, 'dual-input-api.json'), JSON.stringify(out, null, 2));
fs.writeFileSync(path.join(scratch, 'first-frame-source.log'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
db.close();
fs.rmSync(tempRoot, { recursive: true, force: true });
process.exit(allOk ? 0 : 1);
