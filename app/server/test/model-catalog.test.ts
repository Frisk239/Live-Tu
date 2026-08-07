import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'live-tu-model-catalog-'));
process.env.DATA_DIR = path.join(tempRoot, 'data');
process.env.UPLOADS_DIR = path.join(tempRoot, 'uploads');
process.env.NODE_ENV = 'test';

const { db, initDatabase } = await import('../lib/db');
const { MODEL_CATALOG, assertModelCatalogIntegrity } = await import('../lib/model-catalog');

before(() => {
  initDatabase();
});

after(() => {
  db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('S0: catalog is unique with exactly one default per category (P0 duplicate regression)', () => {
  // 不抛错即通过；重复 GPT Image 2 曾导致 fresh DB UNIQUE constraint failed
  assertModelCatalogIntegrity();
  const ids = MODEL_CATALOG.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, 'catalog ids must be unique');
  for (const category of ['text', 'image', 'video']) {
    const defaults = MODEL_CATALOG.filter((m) => m.category === category && m.isDefault === 1);
    assert.equal(defaults.length, 1, `catalog category ${category} must have exactly one default`);
  }
  assert.equal(MODEL_CATALOG.filter((m) => m.id === 'GPT Image 2').length, 1);
});

test('S0: fresh DB seeds the full catalog without duplicates', () => {
  const rows = db.prepare('SELECT id, category, is_default FROM model_config').all() as Array<{
    id: string;
    category: string;
    is_default: number;
  }>;
  assert.equal(rows.length, MODEL_CATALOG.length);
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);
  for (const category of ['text', 'image', 'video']) {
    const defaults = rows.filter((r) => r.category === category && r.is_default === 1);
    assert.equal(defaults.length, 1, `seeded category ${category} must have exactly one default`);
  }
  assert.equal(rows.filter((r) => r.id === 'GPT Image 2').length, 1);
});

test('S0: restart must NOT overwrite admin-modified model config', async () => {
  // 管理员在「模型配置中心」禁用 GPT-4o、把默认文本模型换成 DeepSeek V3
  db.prepare("UPDATE model_config SET enabled = 0 WHERE id = 'GPT-4o'").run();
  db.prepare(
    `UPDATE model_config SET is_default = CASE WHEN id = 'DeepSeek V3' THEN 1 ELSE 0 END WHERE category = 'text'`
  ).run();

  // 模拟重启：重新 initDatabase（同目录）
  const dataDir = process.env.DATA_DIR!;
  const uploadsDir = process.env.UPLOADS_DIR!;
  initDatabase();

  assert.equal(
    (db.prepare("SELECT enabled FROM model_config WHERE id = 'GPT-4o'").get() as { enabled: number }).enabled,
    0,
    '管理员禁用的模型在重启后必须保持禁用'
  );
  assert.equal(
    (db.prepare("SELECT is_default FROM model_config WHERE id = 'DeepSeek V3'").get() as { is_default: number }).is_default,
    1,
    '管理员改的默认模型在重启后必须保留'
  );
  // 每类仍恰好一个默认（不因重启漂移）
  for (const category of ['text', 'image', 'video']) {
    const count = (
      db.prepare(
        'SELECT COUNT(*) AS count FROM model_config WHERE category = ? AND is_default = 1'
      ).get(category) as { count: number }
    ).count;
    assert.equal(count, 1, `category ${category} must keep exactly one default after restart`);
  }
  assert.equal(dataDir, process.env.DATA_DIR);
  assert.equal(uploadsDir, process.env.UPLOADS_DIR);
});

test('S0 P1 fix: frontend default-model constants agree with the server catalog (single source)', async () => {
  // 前端 fallback（API 故障时使用）必须与服务端 typed catalog 的默认模型一致，
  // 防止「前端默认 GPT Image 2、服务端 fallback gpt-image-1」之类的双源漂移。
  const { DEFAULT_TEXT_MODEL, DEFAULT_IMAGE_MODEL, DEFAULT_VIDEO_MODEL, DEFAULT_MODEL_CONFIG } =
    await import('../../src/data/models');
  const catalogDefaults = {
    text: MODEL_CATALOG.find((m) => m.category === 'text' && m.isDefault === 1)!.id,
    image: MODEL_CATALOG.find((m) => m.category === 'image' && m.isDefault === 1)!.id,
    video: MODEL_CATALOG.find((m) => m.category === 'video' && m.isDefault === 1)!.id,
  };
  assert.equal(DEFAULT_TEXT_MODEL, catalogDefaults.text);
  assert.equal(DEFAULT_IMAGE_MODEL, catalogDefaults.image);
  assert.equal(DEFAULT_VIDEO_MODEL, catalogDefaults.video);

  // 前端配置每类恰好一个 isDefault（曾出现 GPT Image 1 与 GPT Image 2 双默认）
  for (const category of ['textModels', 'imageModels', 'videoModels'] as const) {
    const defaults = DEFAULT_MODEL_CONFIG[category].filter((m) => m.isDefault === true);
    assert.equal(defaults.length, 1, `${category} must have exactly one default`);
  }
  assert.equal(
    DEFAULT_MODEL_CONFIG.imageModels.find((m) => m.isDefault === true)?.id,
    'GPT Image 2'
  );
});
