import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

test('upgrades a populated legacy database without losing business data', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'live-tu-migration-test-'));
  const dataDir = path.join(root, 'data');
  const uploadsDir = path.join(root, 'uploads');
  const dbPath = path.join(dataDir, 'pipeline.db');

  const { mkdirSync } = await import('node:fs');
  mkdirSync(dataDir, { recursive: true });
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT,
      positioning TEXT NOT NULL,
      price TEXT NOT NULL,
      sales_record TEXT,
      model343_clays TEXT,
      model343_extracts TEXT,
      model343_surfactants TEXT,
      sgs_oil_8h TEXT,
      sgs_oil_14d TEXT,
      sgs_blackhead_14d TEXT,
      prohibited_words TEXT,
      target_audience TEXT,
      custom_selling_points TEXT,
      cover_image TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE materials (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      url TEXT NOT NULL,
      media_type TEXT NOT NULL,
      size TEXT,
      duration TEXT,
      dimensions TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      current_step INTEGER NOT NULL,
      pipeline_data TEXT NOT NULL,
      thumbnail_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE presets (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      tag TEXT NOT NULL,
      description TEXT NOT NULL,
      cover_image TEXT NOT NULL,
      pipeline_data TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO products (id, name, positioning, price)
      VALUES ('legacy-product', 'Legacy Product', 'legacy positioning', '99');
    INSERT INTO materials (id, name, file_path, url, media_type)
      VALUES ('legacy-material', 'Legacy Material', 'uploads/materials/legacy.png',
              '/uploads/materials/legacy.png', 'image');
    INSERT INTO tasks (id, title, status, current_step, pipeline_data)
      VALUES ('legacy-task', 'Legacy Task', 'draft', 2, '{}');
    INSERT INTO presets (id, title, tag, description, cover_image, pipeline_data)
      VALUES ('legacy-preset', 'Legacy Preset', 'legacy', 'legacy description', '', '{}');
  `);
  legacy.close();

  const previousDataDir = process.env.DATA_DIR;
  const previousUploadsDir = process.env.UPLOADS_DIR;
  process.env.DATA_DIR = dataDir;
  process.env.UPLOADS_DIR = uploadsDir;

  try {
    const databaseModule = await import(`../lib/db.ts?migration-test=${Date.now()}`);
    databaseModule.initDatabase();
    const migrated = databaseModule.db;

    const versions = migrated
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all() as Array<{ version: number }>;
    assert.deepEqual(
      versions.map((row) => row.version),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]
    );

    const tableColumns = (table: string) =>
      new Set(
        (migrated.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
          .map((column) => column.name)
      );
    assert.ok(tableColumns('products').has('custom_attributes_json'));
    assert.ok(tableColumns('materials').has('tags'));
    assert.ok(tableColumns('materials').has('owner_id'));
    assert.ok(tableColumns('materials').has('storage_url'));
    assert.ok(tableColumns('materials').has('size_bytes'));
    assert.ok(tableColumns('shot_generation_tasks').has('concat_status'));
    assert.ok(tableColumns('shot_generation_tasks').has('concatenated_video_url'));
    assert.ok(tableColumns('tasks').has('owner_id'));
    assert.ok(tableColumns('presets').has('category'));
    assert.ok(tableColumns('presets').has('formula'));
    assert.ok(
      migrated
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'permissions'")
        .get()
    );
    assert.ok(
      migrated
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'role_permissions'"
        )
        .get()
    );
    assert.ok(tableColumns('permissions').has('key'));
    assert.ok(tableColumns('permissions').has('name'));
    assert.ok(
      migrated
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'seedance_task_ownership'"
        )
        .get()
    );
    assert.equal(
      (migrated.prepare('SELECT COUNT(*) AS count FROM permissions').get() as {
        count: number;
      }).count,
      17
    );
    assert.deepEqual(
      (
        migrated
          .prepare(
            "SELECT permission_key FROM role_permissions WHERE role = 'operator' ORDER BY permission_key"
          )
          .all() as Array<{ permission_key: string }>
      ).map((row) => row.permission_key),
      [
        'module.materials.read',
        'module.materials.write',
        'module.pipeline.read',
        'module.pipeline.write',
        'module.presets.read',
        'module.tasks.read',
        'module.tasks.write',
      ]
    );
    assert.equal(
      (migrated.prepare(
        "SELECT COUNT(*) AS count FROM role_permissions WHERE role = 'admin'"
      ).get() as { count: number }).count,
      17
    );

    assert.equal(
      (migrated.prepare("SELECT name FROM products WHERE id = 'legacy-product'").get() as {
        name: string;
      }).name,
      'Legacy Product'
    );
    assert.equal(
      (migrated.prepare("SELECT title FROM tasks WHERE id = 'legacy-task'").get() as {
        title: string;
      }).title,
      'Legacy Task'
    );
    assert.equal(
      (migrated.prepare("SELECT name FROM materials WHERE id = 'legacy-material'").get() as {
        name: string;
      }).name,
      'Legacy Material'
    );
    assert.equal(
      (
        migrated
          .prepare("SELECT title FROM presets WHERE id = 'legacy-preset'")
          .get() as { title: string }
      ).title,
      'Legacy Preset'
    );

    assert.ok(
      migrated
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pipeline_runs'")
        .get()
    );
    assert.ok(
      migrated
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'media_ownership'"
        )
        .get()
    );
    assert.ok(
      migrated
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'video_preprocess_cache'"
        )
        .get()
    );
    assert.ok(
      migrated
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'shot_generation_tasks'"
        )
        .get()
    );
    assert.equal(
      (migrated.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys,
      1
    );
    migrated.close();
  } finally {
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    if (previousUploadsDir === undefined) delete process.env.UPLOADS_DIR;
    else process.env.UPLOADS_DIR = previousUploadsDir;
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error: any) {
      // node:sqlite may keep a Windows file handle alive until module teardown even after close().
      // The migration assertions are authoritative; cleanup must not mask their result.
      if (process.platform !== 'win32' || error?.code !== 'EPERM') throw error;
    }
  }
});
