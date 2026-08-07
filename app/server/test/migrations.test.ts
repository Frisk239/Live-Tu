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
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33]
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
    // P3：质量闭环新表
    assert.ok(
      migrated
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'shot_versions'")
        .get()
    );
    assert.ok(
      migrated
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'shot_qa_reports'")
        .get()
    );
    assert.ok(
      migrated
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'golden_runs'")
        .get()
    );
    assert.ok(tableColumns('shot_versions').has('version'));
    assert.ok(tableColumns('shot_versions').has('video_url'));
    assert.ok(tableColumns('shot_qa_reports').has('overall_verdict'));
    assert.ok(tableColumns('shot_qa_reports').has('manual_passed'));
    assert.ok(tableColumns('golden_runs').has('human_score'));
    assert.ok(tableColumns('golden_runs').has('semantic_verdict'));
    assert.ok(tableColumns('shot_generation_tasks').has('current_version'));
    // S3：产品条件化首帧 provenance 表
    assert.ok(
      migrated
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'conditioned_first_frames'"
        )
        .get()
    );
    for (const column of [
      'reference_video_url',
      'reference_keyframe_url',
      'product_asset_urls_json',
      'conditioned_first_frame_url',
      'provider',
      'model',
      'prompt_version',
      'preflight_status',
    ]) {
      assert.ok(
        tableColumns('conditioned_first_frames').has(column),
        `conditioned_first_frames.${column} must exist`
      );
    }
    // S3：镜头任务的首帧派生上下文（referenceKeyframe / derivedFirstFrame 内部化）
    for (const column of ['reference_keyframe_url', 'reference_video_url', 'derived_first_frame_url', 'first_frame_preflight_status']) {
      assert.ok(
        tableColumns('shot_generation_tasks').has(column),
        `shot_generation_tasks.${column} must exist`
      );
    }
    assert.ok(
      migrated
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'seedance_task_ownership'"
        )
        .get()
    );
    // P0：provider capability probe 记录表
    assert.ok(
      migrated
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'provider_capabilities'")
        .get()
    );
    assert.ok(
      migrated
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'viral_probe_artifacts'")
        .get()
    );
    for (const column of ['provider', 'model_code', 'capabilities_json', 'probed_at']) {
      assert.ok(
        tableColumns('provider_capabilities').has(column),
        `provider_capabilities.${column} must exist`
      );
    }
    for (const column of ['kind', 'public_url', 'sha256', 'meta_json', 'run_id']) {
      assert.ok(
        tableColumns('viral_probe_artifacts').has(column),
        `viral_probe_artifacts.${column} must exist`
      );
    }
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
        'module.bgm.read',
        'module.knowledge.read',
        'module.knowledge.write',
        'module.materials.read',
        'module.materials.write',
        'module.models.read',
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

    // --- S0 migration 18: model catalog alignment ---
    const modelIds = (migrated.prepare('SELECT id FROM model_config').all() as Array<{ id: string }>)
      .map((row) => row.id);
    assert.equal(new Set(modelIds).size, modelIds.length, 'model_config must not contain duplicate ids');
    assert.equal(
      (migrated.prepare("SELECT COUNT(*) AS count FROM model_config WHERE id = 'GPT Image 2'").get() as { count: number }).count,
      1,
      'duplicate GPT Image 2 must be deduplicated'
    );
    for (const category of ['text', 'image', 'video']) {
      const defaults = migrated
        .prepare(
          `SELECT COUNT(*) AS count FROM model_config WHERE category = ? AND is_default = 1 AND enabled = 1`
        )
        .get(category) as { count: number };
      assert.equal(defaults.count, 1, `category ${category} must have exactly one default model`);
    }
    assert.equal(
      (migrated.prepare("SELECT COUNT(*) AS count FROM model_config WHERE id = 'Imagen 4 Ultra'").get() as { count: number }).count,
      0,
      'fake models must be removed'
    );

    // --- S0 migration 19: needs_review status is accepted by the CHECK constraints ---
    const runId = 'mig-run-needs-review';
    migrated
      .prepare(
        `INSERT INTO pipeline_runs (id, owner_id, status, current_step, input_json, idempotency_key)
         VALUES (?, 'system', 'needs_review', 5, '{}', 'mig-run-nr')`
      )
      .run(runId);
    migrated
      .prepare(
        `INSERT INTO pipeline_steps (id, run_id, step_number, status)
         VALUES ('mig-step-nr', ?, 5, 'needs_review')`
      )
      .run(runId);
    assert.equal(
      (migrated.prepare("SELECT status FROM pipeline_runs WHERE id = ?").get(runId) as { status: string }).status,
      'needs_review'
    );
    // 表重建不得丢失查询索引（回归：同名 CREATE INDEX IF NOT EXISTS 曾因旧索引存在而 no-op）
    const pipelineIndexes = (
      migrated
        .prepare(
          "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_pipeline%'"
        )
        .all() as Array<{ name: string; tbl_name: string }>
    ).map((row) => `${row.name}@${row.tbl_name}`);
    assert.ok(
      pipelineIndexes.includes('idx_pipeline_runs_owner_created@pipeline_runs') &&
        pipelineIndexes.includes('idx_pipeline_runs_status@pipeline_runs') &&
        pipelineIndexes.includes('idx_pipeline_steps_run@pipeline_steps'),
      `pipeline indexes must survive table rebuild, got: ${pipelineIndexes.join(', ')}`
    );

    // --- S0 migration 20: artifact provenance columns ---
    assert.ok(tableColumns('pipeline_runs').has('product_version'));
    for (const column of [
      'product_id',
      'product_version',
      'reference_version',
      'model',
      'prompt',
      'source_run_id',
      'stale',
    ]) {
      assert.ok(tableColumns('artifacts').has(column), `artifacts.${column} must exist`);
    }

    // --- S0 migration 21: product revision + generated media registry ---
    assert.ok(tableColumns('products').has('revision'));
    const revisions = (
      migrated.prepare('SELECT revision FROM products').all() as Array<{ revision: number }>
    ).map((row) => row.revision);
    assert.equal(new Set(revisions).size, revisions.length, 'product revisions must be distinct');
    assert.ok(
      migrated
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'generated_media'")
        .get(),
      'generated_media table must exist'
    );
    for (const column of ['owner_id', 'product_id', 'product_version', 'uri', 'stale']) {
      assert.ok(tableColumns('generated_media').has(column), `generated_media.${column} must exist`);
    }

    // --- S1 migrations 23-24: cost ledger + micro-dollar precision/run linkage ---
    assert.ok(
      migrated
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cost_ledger'")
        .get(),
      'cost_ledger table must exist'
    );
    for (const column of ['scope', 'shot_id', 'provider', 'prompt_version', 'queue_ms', 'generation_ms', 'retries', 'failure_reason', 'estimated_usd_micros', 'actual_usd_micros', 'manual_choice', 'recorded_at', 'owner_id']) {
      assert.ok(tableColumns('cost_ledger').has(column), `cost_ledger.${column} must exist`);
    }
    assert.ok(tableColumns('shot_generation_tasks').has('pipeline_run_id'));

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

/**
 * v28 存量数据保全回归（P3 审查确定性缺陷）：
 * rebuildTable 必须先 INSERT...SELECT 共有列，再 DROP 旧表。
 * 用带存量 shot_versions 数据的 v27 库升级到最新版本，验证版本历史完整保留。
 */
test('v28 rebuild must preserve existing shot_versions rows (no data loss on migration)', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'live-tu-v28-migration-test-'));
  const dataDir = path.join(root, 'data');
  const uploadsDir = path.join(root, 'uploads');
  const dbPath = path.join(dataDir, 'pipeline.db');

  const { mkdirSync } = await import('node:fs');
  mkdirSync(dataDir, { recursive: true });

  // 模拟 v27 库：users（shot_versions FK 目标）+ 旧版 shot_versions（status CHECK 无 'generating'）
  // + shot_qa_reports + golden_runs + shot_generation_tasks（含 current_version）
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'operator')),
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO users (id, username, password_hash, role) VALUES ('legacy-owner', 'legacy', 'x', 'operator');
    CREATE TABLE shot_versions (
      id TEXT PRIMARY KEY,
      shot_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      video_url TEXT,
      prompt TEXT,
      model_code TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'completed', 'failed', 'reverted')),
      qa_report_id TEXT,
      cost_ledger_id TEXT,
      failure_reason TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (owner_id) REFERENCES users(id)
    );
    CREATE TABLE shot_qa_reports (
      id TEXT PRIMARY KEY,
      shot_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      owner_id TEXT NOT NULL,
      report_json TEXT NOT NULL,
      tech_status TEXT DEFAULT 'unverified',
      semantic_status TEXT DEFAULT 'unverified',
      overall_verdict TEXT DEFAULT 'unverified',
      manual_passed INTEGER NOT NULL DEFAULT 0,
      manual_pass_comment TEXT,
      checked_at INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (owner_id) REFERENCES users(id)
    );
    CREATE TABLE golden_runs (
      id TEXT PRIMARY KEY,
      sample_id TEXT NOT NULL,
      run_index INTEGER NOT NULL,
      owner_id TEXT NOT NULL DEFAULT 'system',
      started_at INTEGER,
      completed_at INTEGER,
      duration_ms INTEGER,
      provider TEXT,
      model TEXT,
      model_code TEXT,
      seed INTEGER,
      prompt TEXT,
      prompt_version TEXT,
      artifact_url TEXT,
      artifact_status TEXT DEFAULT 'missing',
      tech_qa_status TEXT,
      semantic_verdict TEXT,
      semantic_report_json TEXT,
      estimated_cost_micros INTEGER,
      actual_cost_micros INTEGER,
      failure_reason TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      human_score REAL,
      human_comment TEXT,
      human_reviewer TEXT,
      git_commit TEXT DEFAULT 'unknown',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE shot_generation_tasks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      owner_id TEXT,
      shot_index INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      seedance_task_id TEXT,
      video_url TEXT,
      error_message TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      concat_status TEXT DEFAULT 'pending',
      concatenated_video_url TEXT,
      video_prompt TEXT,
      first_frame_url TEXT,
      qa_status TEXT DEFAULT 'pending',
      qa_attempt INTEGER NOT NULL DEFAULT 0,
      pipeline_run_id TEXT,
      FOREIGN KEY (owner_id) REFERENCES users(id),
      UNIQUE (session_id, shot_index)
    );
    INSERT INTO shot_versions (id, shot_id, run_id, owner_id, version, video_url, prompt, model_code, status, qa_report_id, cost_ledger_id, failure_reason)
      VALUES ('sv-legacy-v1', 'shot-legacy', 'run-legacy', 'legacy-owner', 1, '/uploads/renders/v1.mp4', 'prompt-v1', 'doubao-seedance-2-0-fast', 'completed', 'qa-1', NULL, NULL);
    INSERT INTO shot_versions (id, shot_id, run_id, owner_id, version, video_url, prompt, model_code, status, qa_report_id, cost_ledger_id, failure_reason)
      VALUES ('sv-legacy-v2', 'shot-legacy', 'run-legacy', 'legacy-owner', 2, '/uploads/renders/v2.mp4', 'prompt-v2', 'doubao-seedance-2-0-fast', 'completed', 'qa-2', NULL, NULL);
    INSERT INTO shot_versions (id, shot_id, run_id, owner_id, version, video_url, prompt, model_code, status, qa_report_id, cost_ledger_id, failure_reason)
      VALUES ('sv-legacy-failed', 'shot-legacy', 'run-legacy', 'legacy-owner', 3, NULL, 'prompt-v3', 'doubao-seedance-2-0-fast', 'failed', NULL, NULL, 'provider_error');
    INSERT INTO shot_qa_reports (id, shot_id, run_id, version, owner_id, report_json, tech_status, semantic_status, overall_verdict, manual_passed, checked_at)
      VALUES ('qa-1', 'shot-legacy', 'run-legacy', 1, 'legacy-owner', '{}', 'verified', 'pass', 'pass', 0, 1);
    INSERT INTO shot_qa_reports (id, shot_id, run_id, version, owner_id, report_json, tech_status, semantic_status, overall_verdict, manual_passed, checked_at)
      VALUES ('qa-2', 'shot-legacy', 'run-legacy', 2, 'legacy-owner', '{}', 'verified', 'pass', 'pass', 1, 2);
    INSERT INTO shot_generation_tasks (id, session_id, owner_id, shot_index, status, video_prompt, video_url)
      VALUES ('shot-legacy', 'sess-legacy', 'legacy-owner', 1, 'completed', 'prompt-v2', '/uploads/renders/v2.mp4');
  `);
  legacy.close();

  const previousDataDir = process.env.DATA_DIR;
  const previousUploadsDir = process.env.UPLOADS_DIR;
  process.env.DATA_DIR = dataDir;
  process.env.UPLOADS_DIR = uploadsDir;

  try {
    const databaseModule = await import(`../lib/db.ts?v28-test=${Date.now()}`);
    databaseModule.initDatabase();
    const migrated = databaseModule.db;

    // 1) 存量版本行全部保留（rebuildTable 数据保全）
    const rows = migrated
      .prepare('SELECT * FROM shot_versions ORDER BY version')
      .all() as Array<Record<string, any>>;
    assert.equal(rows.length, 3, `shot_versions 存量 3 行必须全部保留，实际 ${rows.length}: ${JSON.stringify(rows)}`);
    const byVersion = new Map(rows.map((r) => [r.version, r]));
    assert.equal(byVersion.get(1).video_url, '/uploads/renders/v1.mp4');
    assert.equal(byVersion.get(1).prompt, 'prompt-v1');
    assert.equal(byVersion.get(1).qa_report_id, 'qa-1');
    assert.equal(byVersion.get(2).video_url, '/uploads/renders/v2.mp4');
    assert.equal(byVersion.get(2).prompt, 'prompt-v2');
    assert.equal(byVersion.get(3).status, 'failed');
    assert.equal(byVersion.get(3).failure_reason, 'provider_error');

    // 2) 新 CHECK 约束生效：'generating' 可写入（v28 重建目的）
    migrated
      .prepare(
        `INSERT INTO shot_versions (id, shot_id, run_id, owner_id, version, status)
         VALUES ('sv-gen', 'shot-legacy', 'run-legacy', 'legacy-owner', 4, 'generating')`
      )
      .run();
    assert.equal(
      (migrated.prepare("SELECT status FROM shot_versions WHERE id = 'sv-gen'").get() as { status: string }).status,
      'generating'
    );

    // 3) 外键完整性未破坏
    assert.deepEqual(migrated.prepare('PRAGMA foreign_key_check').all(), []);

    // 4) 版本历史与 shot 任务关系仍可关联（QA 展示关系）
    // current_version 由 v27 ALTER 添加（DEFAULT 1），v28 重建后不丢失
    assert.equal(
      (migrated.prepare("SELECT current_version FROM shot_generation_tasks WHERE id = 'shot-legacy'").get() as { current_version: number }).current_version,
      1
    );
    const qaRows = (migrated.prepare("SELECT overall_verdict, manual_passed FROM shot_qa_reports ORDER BY version").all() as Array<Record<string, unknown>>)
      .map((r) => ({ overall_verdict: String(r.overall_verdict), manual_passed: Number(r.manual_passed) }));
    assert.deepEqual(qaRows, [
      { overall_verdict: 'pass', manual_passed: 0 },
      { overall_verdict: 'pass', manual_passed: 1 },
    ]);

    migrated.close();
  } finally {
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    if (previousUploadsDir === undefined) delete process.env.UPLOADS_DIR;
    else process.env.UPLOADS_DIR = previousUploadsDir;
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error: any) {
      if (process.platform !== 'win32' || error?.code !== 'EPERM') throw error;
    }
  }
});
