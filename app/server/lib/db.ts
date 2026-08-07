import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID, randomBytes, scryptSync } from 'node:crypto';
import { defaultPresets } from './preset-seeds.js';
import {
  OPERATOR_PERMISSION_KEYS,
  PERMISSION_KEYS,
  PERMISSION_NAMES,
} from './permission-catalog.js';
import {
  MODEL_CATALOG,
  assertModelCatalogIntegrity,
} from './model-catalog.js';
import {
  RUN_STATUS_CHECK_SQL,
  SHOT_STATUS_CHECK_SQL,
  STEP_STATUS_CHECK_SQL,
  RUN_STATUSES,
  STEP_STATUSES,
} from '../../shared/run-state.js';

export { defaultPresets };

// S0：启动前断言模型目录本身可信（ID 唯一、每类恰好一个默认模型）。
// 目录重复曾导致 fresh DB / CI 初始化 UNIQUE constraint failed（P0），必须让它在启动时立刻暴露。
assertModelCatalogIntegrity();

const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
const uploadsDir = path.resolve(process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads'));
const materialsDir = path.join(uploadsDir, 'materials');
const bgmDir = path.join(uploadsDir, 'bgm');
const rendersDir = path.join(uploadsDir, 'renders');

[dataDir, uploadsDir, materialsDir, bgmDir, rendersDir].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

const dbPath = path.join(dataDir, 'pipeline.db');
export const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

type Migration = {
  version: number;
  name: string;
  up: () => void;
  /**
   * 默认在事务内执行（原子 + 自动回滚）。
   * 需要重建表并临时切换 PRAGMA foreign_keys 的迁移必须设为 false：
   * SQLite 不允许在事务内切换 foreign_keys，这类迁移自己管理事务与完整性校验。
   */
  transactional?: boolean;
};

function hasColumn(table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((item) => item.name === column);
}

/**
 * 取新旧两表共有列（按名字求交集，顺序取新表列序）。
 */
function sharedColumnNames(oldTable: string, newTable: string): string[] {
  const oldCols = db.prepare(`PRAGMA table_info(${oldTable})`).all() as Array<{ name: string }>;
  const newCols = db.prepare(`PRAGMA table_info(${newTable})`).all() as Array<{ name: string }>;
  const oldNames = new Set(oldCols.map((c) => c.name));
  return newCols.map((c) => c.name).filter((n) => oldNames.has(n));
}

/**
 * 把旧表共有列数据复制到新表（INSERT INTO ... SELECT），返回复制行数。
 * 必须在事务内、旧表尚未 DROP 前调用。
 */
function copySharedRows(oldTable: string, newTable: string): number {
  const shared = sharedColumnNames(oldTable, newTable);
  if (shared.length === 0) return 0;
  const colList = shared.map((n) => `"${n}"`).join(', ');
  const result = db
    .prepare(`INSERT INTO ${newTable} (${colList}) SELECT ${colList} FROM ${oldTable}`)
    .run();
  return Number(result.changes);
}

/**
 * SQLite 表重建（官方 12 步流程简化版）：用于修改 CHECK 约束等无法 ALTER 的 DDL。
 * - 迁移期间临时关闭外键检查（PRAGMA foreign_keys 连接级、须在事务外切换）；
 * - 先把旧表共有列数据 INSERT...SELECT 进新表，再 DROP 旧表——绝不静默清空存量数据；
 * - 重建后执行 PRAGMA foreign_key_check 验证引用完整性，失败则抛错阻止迁移通过。
 */
function rebuildTable(table: string, checkColumnSql: string, createNew: (checkSql: string) => void) {
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      createNew(checkColumnSql);
      // 数据保全：新表建好后、旧表删除前，先复制共有列全部存量行。
      // （v28 修复：此前直接 DROP 旧表会清空 shot_versions 等表的全部版本历史。）
      const copied = copySharedRows(table, `${table}_new`);
      db.exec(`DROP TABLE ${table}`);
      db.exec(`ALTER TABLE ${table}_new RENAME TO ${table}`);
      db.exec('COMMIT');
      if (copied > 0) {
        console.warn(`[db] rebuildTable: ${table} 已保全 ${copied} 行存量数据`);
      }
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length > 0) {
      throw new Error(
        `重建 ${table} 后外键校验失败：${JSON.stringify(violations.slice(0, 5))}`
      );
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

function runMigrations(migrations: Migration[]) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>)
      .map((row) => row.version)
  );
  const insert = db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)');

  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    if (applied.has(migration.version)) continue;
    if (migration.transactional === false) {
      migration.up();
      insert.run(migration.version, migration.name);
      continue;
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      migration.up();
      insert.run(migration.version, migration.name);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`数据库迁移 ${migration.version} (${migration.name}) 失败`, { cause: error });
    }
  }
}

export function initDatabase() {
  // 1. Products Table
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
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
      custom_attributes_json TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 2. Materials Table
  db.exec(`
    CREATE TABLE IF NOT EXISTS materials (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      url TEXT NOT NULL,
      media_type TEXT NOT NULL,
      size TEXT,
      duration TEXT,
      dimensions TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 3. BGM Library Table
  db.exec(`
    CREATE TABLE IF NOT EXISTS bgm_library (
      id TEXT PRIMARY KEY,
      track_name TEXT NOT NULL,
      artist TEXT,
      style_tags TEXT,
      bpm INTEGER,
      mood TEXT,
      license_type TEXT,
      audio_path TEXT NOT NULL,
      audio_url TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 4. Tasks Table
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      current_step INTEGER NOT NULL,
      pipeline_data TEXT NOT NULL,
      thumbnail_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 5. Model Config Table
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_config (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      provider TEXT NOT NULL,
      base_url TEXT NOT NULL,
      api_key TEXT NOT NULL,
      model_code TEXT NOT NULL,
      recommended_scenario TEXT,
      speed_rating TEXT,
      speed_ms TEXT,
      quality_rating TEXT,
      description TEXT,
      badge TEXT,
      enabled INTEGER DEFAULT 1,
      is_default INTEGER DEFAULT 0
    )
  `);

  // 6. Presets Table
  db.exec(`
    CREATE TABLE IF NOT EXISTS presets (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      tag TEXT NOT NULL,
      description TEXT NOT NULL,
      cover_image TEXT NOT NULL,
      pipeline_data TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  runMigrations([
    {
      version: 1,
      name: 'add_product_preset_and_material_metadata',
      up: () => {
        if (!hasColumn('products', 'custom_attributes_json')) {
          db.exec('ALTER TABLE products ADD COLUMN custom_attributes_json TEXT');
        }
        if (!hasColumn('presets', 'category')) {
          db.exec("ALTER TABLE presets ADD COLUMN category TEXT DEFAULT 'universal'");
        }
        if (!hasColumn('presets', 'formula')) {
          db.exec("ALTER TABLE presets ADD COLUMN formula TEXT DEFAULT 'hook_demo_cta'");
        }
        if (!hasColumn('materials', 'tags')) {
          db.exec("ALTER TABLE materials ADD COLUMN tags TEXT DEFAULT '[]'");
        }
      },
    },
    {
      version: 2,
      name: 'add_users_and_auth_sessions',
      up: () => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK (role IN ('admin', 'operator')),
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
          );

          CREATE TABLE IF NOT EXISTS auth_sessions (
            token_hash TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            expires_at DATETIME NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
          );

          CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
          CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);
        `);
      },
    },
    {
      version: 3,
      name: 'add_business_data_ownership',
      up: () => {
        if (!hasColumn('tasks', 'owner_id')) {
          db.exec('ALTER TABLE tasks ADD COLUMN owner_id TEXT REFERENCES users(id)');
        }
        if (!hasColumn('materials', 'owner_id')) {
          db.exec('ALTER TABLE materials ADD COLUMN owner_id TEXT REFERENCES users(id)');
        }
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner_id);
          CREATE INDEX IF NOT EXISTS idx_materials_owner ON materials(owner_id);
        `);
      },
    },
    {
      version: 4,
      name: 'add_durable_pipeline_execution',
      up: () => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS pipeline_runs (
            id TEXT PRIMARY KEY,
            owner_id TEXT NOT NULL,
            product_id TEXT,
            status TEXT NOT NULL CHECK (
              status IN ('queued', 'running', 'waiting_external', 'completed', 'failed', 'cancelled')
            ),
            current_step INTEGER NOT NULL DEFAULT 1,
            input_json TEXT NOT NULL,
            error_code TEXT,
            error_message TEXT,
            idempotency_key TEXT NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            started_at DATETIME,
            completed_at DATETIME,
            FOREIGN KEY (owner_id) REFERENCES users(id),
            FOREIGN KEY (product_id) REFERENCES products(id),
            UNIQUE (owner_id, idempotency_key)
          );

          CREATE TABLE IF NOT EXISTS pipeline_steps (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            step_number INTEGER NOT NULL,
            status TEXT NOT NULL CHECK (
              status IN ('pending', 'running', 'waiting_external', 'completed', 'failed', 'cancelled', 'stale')
            ),
            attempt INTEGER NOT NULL DEFAULT 0,
            input_json TEXT NOT NULL DEFAULT '{}',
            output_json TEXT,
            provider_task_id TEXT,
            error_code TEXT,
            error_message TEXT,
            started_at DATETIME,
            completed_at DATETIME,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (run_id) REFERENCES pipeline_runs(id) ON DELETE CASCADE,
            UNIQUE (run_id, step_number)
          );

          CREATE TABLE IF NOT EXISTS artifacts (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            step_number INTEGER NOT NULL,
            artifact_type TEXT NOT NULL,
            uri TEXT,
            content_json TEXT,
            content_hash TEXT,
            source TEXT NOT NULL DEFAULT 'real',
            version INTEGER NOT NULL DEFAULT 1,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (run_id) REFERENCES pipeline_runs(id) ON DELETE CASCADE
          );

          CREATE TABLE IF NOT EXISTS provider_calls (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            step_number INTEGER NOT NULL,
            provider TEXT NOT NULL,
            model_code TEXT,
            provider_task_id TEXT,
            status TEXT NOT NULL,
            duration_ms INTEGER,
            input_units INTEGER,
            output_units INTEGER,
            estimated_cost REAL,
            error_code TEXT,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (run_id) REFERENCES pipeline_runs(id) ON DELETE CASCADE
          );

          CREATE TABLE IF NOT EXISTS audit_logs (
            id TEXT PRIMARY KEY,
            user_id TEXT,
            action TEXT NOT NULL,
            entity_type TEXT NOT NULL,
            entity_id TEXT,
            metadata_json TEXT NOT NULL DEFAULT '{}',
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id)
          );

          CREATE INDEX IF NOT EXISTS idx_pipeline_runs_owner_created
            ON pipeline_runs(owner_id, created_at);
          CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status
            ON pipeline_runs(status, updated_at);
          CREATE INDEX IF NOT EXISTS idx_pipeline_steps_run
            ON pipeline_steps(run_id, step_number);
          CREATE INDEX IF NOT EXISTS idx_artifacts_run_step
            ON artifacts(run_id, step_number);
          CREATE INDEX IF NOT EXISTS idx_provider_calls_run
            ON provider_calls(run_id, step_number);
          CREATE INDEX IF NOT EXISTS idx_audit_logs_entity
            ON audit_logs(entity_type, entity_id, created_at);
        `);
      },
    },
    {
      version: 5,
      name: 'add_video_preprocess_cache',
      up: () => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS video_preprocess_cache (
            id TEXT PRIMARY KEY,
            video_path TEXT NOT NULL,
            duration REAL NOT NULL DEFAULT 0,
            resolution TEXT,
            fps REAL NOT NULL DEFAULT 0,
            keyframe_timestamps TEXT NOT NULL DEFAULT '[]',
            keyframe_urls TEXT NOT NULL DEFAULT '[]',
            scene_changes TEXT NOT NULL DEFAULT '[]',
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
          );
          CREATE INDEX IF NOT EXISTS idx_video_preprocess_path
            ON video_preprocess_cache(video_path);
        `);
      },
    },
    {
      version: 6,
      name: 'add_owned_shot_generation_tasks',
      up: () => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS shot_generation_tasks (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            owner_id TEXT,
            shot_index INTEGER NOT NULL,
            status TEXT NOT NULL CHECK (
              status IN ('pending', 'generating', 'completed', 'failed', 'cancelled')
            ),
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
            FOREIGN KEY (owner_id) REFERENCES users(id),
            UNIQUE (session_id, shot_index)
          );
          CREATE INDEX IF NOT EXISTS idx_shot_tasks_session_owner
            ON shot_generation_tasks(session_id, owner_id, shot_index);
          CREATE INDEX IF NOT EXISTS idx_shot_tasks_provider
            ON shot_generation_tasks(seedance_task_id);
        `);
      },
    },
    {
      version: 7,
      name: 'add_private_material_storage_reference',
      up: () => {
        if (!hasColumn('materials', 'storage_url')) {
          db.exec('ALTER TABLE materials ADD COLUMN storage_url TEXT');
        }
      },
    },
    {
      version: 8,
      name: 'add_owned_media_registry',
      up: () => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS media_ownership (
            path TEXT PRIMARY KEY,
            owner_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS idx_media_ownership_owner
            ON media_ownership(owner_id, created_at);
        `);
      },
    },
    {
      version: 9,
      name: 'add_material_storage_accounting',
      up: () => {
        if (!hasColumn('materials', 'size_bytes')) {
          db.exec('ALTER TABLE materials ADD COLUMN size_bytes INTEGER NOT NULL DEFAULT 0');
        }
      },
    },
    {
      version: 10,
      name: 'persist_shot_session_concat_result',
      up: () => {
        if (!hasColumn('shot_generation_tasks', 'concat_status')) {
          db.exec("ALTER TABLE shot_generation_tasks ADD COLUMN concat_status TEXT DEFAULT 'pending'");
        }
        if (!hasColumn('shot_generation_tasks', 'concatenated_video_url')) {
          db.exec('ALTER TABLE shot_generation_tasks ADD COLUMN concatenated_video_url TEXT');
        }
      },
    },
    {
      version: 11,
      name: 'add_database_driven_permissions',
      up: () => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS permissions (
            key TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
          );

          CREATE TABLE IF NOT EXISTS role_permissions (
            role TEXT NOT NULL CHECK (role IN ('admin', 'operator')),
            permission_key TEXT NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (role, permission_key),
            FOREIGN KEY (permission_key) REFERENCES permissions(key)
              ON DELETE CASCADE
          );

          CREATE INDEX IF NOT EXISTS idx_role_permissions_permission
            ON role_permissions(permission_key, role);
        `);
        const insertPermission = db.prepare(
          `INSERT OR IGNORE INTO permissions (key, name, description)
           VALUES (?, ?, ?)`
        );
        const insertRolePermission = db.prepare(
          `INSERT OR IGNORE INTO role_permissions (role, permission_key)
           VALUES (?, ?)`
        );
        for (const permission of PERMISSION_KEYS) {
          insertPermission.run(permission, PERMISSION_NAMES[permission], permission);
          insertRolePermission.run('admin', permission);
        }
        for (const permission of OPERATOR_PERMISSION_KEYS) {
          insertRolePermission.run('operator', permission);
        }
      },
    },
    {
      version: 12,
      name: 'normalize_permission_metadata',
      up: () => {
        // Upgrade development databases created by the initial permission
        // migration, which used permission_key as the catalog primary key.
        if (hasColumn('permissions', 'permission_key') && !hasColumn('permissions', 'key')) {
          db.exec('ALTER TABLE permissions ADD COLUMN key TEXT');
          db.exec('UPDATE permissions SET key = permission_key WHERE key IS NULL');
          db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_permissions_key ON permissions(key)');
        }
        if (!hasColumn('permissions', 'name')) {
          db.exec("ALTER TABLE permissions ADD COLUMN name TEXT NOT NULL DEFAULT ''");
        }
        const updateName = db.prepare(
          "UPDATE permissions SET name = ? WHERE key = ? AND (name = ? OR name = '')"
        );
        for (const permission of PERMISSION_KEYS) {
          updateName.run(PERMISSION_NAMES[permission], permission, '');
        }
        const insertPermission = db.prepare(
          `INSERT OR IGNORE INTO permissions (key, name, description)
           VALUES (?, ?, ?)`
        );
        const insertRolePermission = db.prepare(
          `INSERT OR IGNORE INTO role_permissions (role, permission_key)
           VALUES (?, ?)`
        );
        for (const permission of PERMISSION_KEYS) {
          insertPermission.run(permission, PERMISSION_NAMES[permission], permission);
          insertRolePermission.run('admin', permission);
        }
        db.prepare(
          `DELETE FROM role_permissions
           WHERE role = 'operator' AND permission_key NOT IN (${OPERATOR_PERMISSION_KEYS.map(() => '?').join(', ')})`
        ).run(...OPERATOR_PERMISSION_KEYS);
        for (const permission of OPERATOR_PERMISSION_KEYS) {
          insertRolePermission.run('operator', permission);
        }
      },
    },
    {
      version: 13,
      name: 'add_seedance_task_ownership',
      up: () => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS seedance_task_ownership (
            provider_task_id TEXT PRIMARY KEY,
            owner_id TEXT NOT NULL,
            source TEXT NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS idx_seedance_task_ownership_owner
            ON seedance_task_ownership(owner_id, created_at);
        `);
      },
    },
    {
      version: 14,
      name: 'add_product_visual_assets',
      up: () => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS product_assets (
            id TEXT PRIMARY KEY,
            product_id TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'hero',
            url TEXT NOT NULL,
            file_path TEXT,
            sort_order INTEGER NOT NULL DEFAULT 0,
            owner_id TEXT,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS idx_product_assets_product
            ON product_assets(product_id, sort_order, created_at);
        `);
      },
    },
    {
      version: 15,
      name: 'shot_qa_columns',
      up: () => {
        if (!hasColumn('shot_generation_tasks', 'video_prompt')) {
          db.exec('ALTER TABLE shot_generation_tasks ADD COLUMN video_prompt TEXT');
        }
        if (!hasColumn('shot_generation_tasks', 'first_frame_url')) {
          db.exec('ALTER TABLE shot_generation_tasks ADD COLUMN first_frame_url TEXT');
        }
        if (!hasColumn('shot_generation_tasks', 'qa_status')) {
          db.exec("ALTER TABLE shot_generation_tasks ADD COLUMN qa_status TEXT DEFAULT 'pending'");
        }
        if (!hasColumn('shot_generation_tasks', 'qa_attempt')) {
          db.exec('ALTER TABLE shot_generation_tasks ADD COLUMN qa_attempt INTEGER NOT NULL DEFAULT 0');
        }
      },
    },
    {
      version: 16,
      name: 'grant_operator_knowledge_and_bgm',
      up: () => {
        const insertRolePermission = db.prepare(
          `INSERT OR IGNORE INTO role_permissions (role, permission_key)
           VALUES (?, ?)`
        );
        for (const permission of ['module.knowledge.read', 'module.knowledge.write', 'module.bgm.read']) {
          insertRolePermission.run('operator', permission);
        }
      },
    },
    {
      version: 17,
      name: 'grant_operator_models_read',
      up: () => {
        // 模型配置只读：工作台模型选择器/生图依赖模型列表（GET /models/config apiKey 已掩码）
        const insertRolePermission = db.prepare(
          `INSERT OR IGNORE INTO role_permissions (role, permission_key)
           VALUES (?, ?)`
        );
        insertRolePermission.run('operator', 'module.models.read');
      },
    },
    {
      version: 18,
      name: 'align_model_catalog',
      up: () => {
        // S0：一次性把 model_config 对齐到单一 typed catalog（model-catalog.ts）。
        // 这是唯一的目录对齐点：之后每次重启不再 upsert/重置模型配置，
        // 管理员在「模型配置中心」保存的修改（enabled/is_default/base_url 等）必须保留。
        const del = db.prepare('DELETE FROM model_config WHERE id = ?');
        const fakeIds = [
          'DeepSeek R1',
          'Claude 3.5 Sonnet',
          'Imagen 4 Ultra',
          'Imagen 4',
          'Imagen 4 Fast',
          'Nano Banana Pro',
          'Nano Banana 2 Lite',
          'Omni Flash',
          'Veo 3.1 Preview',
          'Veo 3.1 Fast Preview',
        ];
        for (const id of fakeIds) del.run(id);

        // 去重：历史脏数据可能残留重复 id（如两行 GPT Image 2），保留最早一行
        db.exec(`
          DELETE FROM model_config
          WHERE rowid NOT IN (SELECT MIN(rowid) FROM model_config GROUP BY id)
        `);

        // 补齐目录中缺失的模型；INSERT OR IGNORE 绝不覆盖管理员已修改的行
        const insert = db.prepare(`
          INSERT OR IGNORE INTO model_config (
            id, name, category, provider, base_url, api_key, model_code,
            recommended_scenario, speed_rating, speed_ms, quality_rating,
            description, badge, enabled, is_default
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const m of MODEL_CATALOG) {
          insert.run(
            m.id,
            m.id,
            m.category,
            m.provider,
            m.baseUrl,
            m.apiKey,
            m.modelCode,
            m.recommendedScenario,
            m.speedRating,
            m.speedMs,
            m.qualityRating,
            m.description,
            m.badge,
            m.enabled,
            m.isDefault
          );
        }

        // 每类恰好一个默认模型：无默认 → 取目录默认；多个默认 → 优先保留目录默认 id
        for (const category of ['text', 'image', 'video'] as const) {
          const rows = db
            .prepare(
              `SELECT id, is_default FROM model_config WHERE category = ? AND enabled = 1 ORDER BY rowid`
            )
            .all(category) as Array<{ id: string; is_default: number }>;
          const defaults = rows.filter((r) => r.is_default === 1);
          const catalogDefault = MODEL_CATALOG.find(
            (m) => m.category === category && m.isDefault === 1
          )?.id;
          if (defaults.length === 0) {
            if (catalogDefault) {
              db.prepare(
                `UPDATE model_config SET is_default = 1 WHERE id = ? AND category = ?`
              ).run(catalogDefault, category);
            }
          } else if (defaults.length > 1) {
            const keep =
              defaults.find((r) => r.id === catalogDefault)?.id || defaults[0].id;
            db.prepare(
              `UPDATE model_config SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE category = ?`
            ).run(keep, category);
          }
        }

        // 兼容历史库：旧种子曾把所有模型 enabled=0（UI 选择器被清空）
        const enabledCount = (
          db
            .prepare('SELECT COUNT(*) AS count FROM model_config WHERE enabled = 1')
            .get() as { count: number }
        ).count;
        const totalModels = (
          db.prepare('SELECT COUNT(*) AS count FROM model_config').get() as { count: number }
        ).count;
        if (totalModels > 0 && enabledCount === 0) {
          db.exec('UPDATE model_config SET enabled = 1');
        }
      },
    },
    {
      version: 19,
      name: 'add_needs_review_run_status',
      transactional: false,
      up: () => {
        // S0：软门禁路径会写 status='needs_review'，但旧 CHECK 只允许
        // ('queued','running','waiting_external','completed','failed','cancelled')，
        // 结果落库时 CHECK constraint failed 崩溃。SQLite 改 CHECK 必须重建表。
        // CHECK 表达式从 run-state.ts 单一来源生成，保证契约一致。
        rebuildTable('pipeline_runs', RUN_STATUS_CHECK_SQL, (sql) => {
          // 注意：索引名是数据库级唯一的。旧表上的 idx_pipeline_* 索引仍存在时，
          // CREATE INDEX IF NOT EXISTS ... ON pipeline_runs_new(...) 是 no-op，
          // DROP TABLE 旧表后索引会一起消失 —— 必须先删旧索引再建新索引。
          db.exec('DROP INDEX IF EXISTS idx_pipeline_runs_owner_created');
          db.exec('DROP INDEX IF EXISTS idx_pipeline_runs_status');
          db.exec(`
            CREATE TABLE pipeline_runs_new (
              id TEXT PRIMARY KEY,
              owner_id TEXT NOT NULL,
              product_id TEXT,
              ${sql},
              current_step INTEGER NOT NULL DEFAULT 1,
              input_json TEXT NOT NULL,
              error_code TEXT,
              error_message TEXT,
              idempotency_key TEXT NOT NULL,
              created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
              updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
              started_at DATETIME,
              completed_at DATETIME,
              FOREIGN KEY (owner_id) REFERENCES users(id),
              FOREIGN KEY (product_id) REFERENCES products(id),
              UNIQUE (owner_id, idempotency_key)
            )
          `);
          db.exec(`
            INSERT INTO pipeline_runs_new (
              id, owner_id, product_id, status, current_step, input_json,
              error_code, error_message, idempotency_key,
              created_at, updated_at, started_at, completed_at
            )
            SELECT
              id, owner_id, product_id, status, current_step, input_json,
              error_code, error_message, idempotency_key,
              created_at, updated_at, started_at, completed_at
            FROM pipeline_runs
          `);
          db.exec(`
            CREATE INDEX IF NOT EXISTS idx_pipeline_runs_owner_created
              ON pipeline_runs_new(owner_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status
              ON pipeline_runs_new(status, updated_at);
          `);
        });
        rebuildTable('pipeline_steps', STEP_STATUS_CHECK_SQL, (sql) => {
          db.exec('DROP INDEX IF EXISTS idx_pipeline_steps_run');
          db.exec(`
            CREATE TABLE pipeline_steps_new (
              id TEXT PRIMARY KEY,
              run_id TEXT NOT NULL,
              step_number INTEGER NOT NULL,
              ${sql},
              attempt INTEGER NOT NULL DEFAULT 0,
              input_json TEXT NOT NULL DEFAULT '{}',
              output_json TEXT,
              provider_task_id TEXT,
              error_code TEXT,
              error_message TEXT,
              started_at DATETIME,
              completed_at DATETIME,
              updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY (run_id) REFERENCES pipeline_runs(id) ON DELETE CASCADE,
              UNIQUE (run_id, step_number)
            )
          `);
          db.exec(`
            INSERT INTO pipeline_steps_new (
              id, run_id, step_number, status, attempt, input_json, output_json,
              provider_task_id, error_code, error_message,
              started_at, completed_at, updated_at
            )
            SELECT
              id, run_id, step_number, status, attempt, input_json, output_json,
              provider_task_id, error_code, error_message,
              started_at, completed_at, updated_at
            FROM pipeline_steps
          `);
          db.exec(`
            CREATE INDEX IF NOT EXISTS idx_pipeline_steps_run
              ON pipeline_steps_new(run_id, step_number);
          `);
        });
      },
    },
    {
      version: 20,
      name: 'add_artifact_provenance',
      up: () => {
        // S0：产物可追溯 + 产品上下文隔离。
        // 每个 Artifact 记录绑定的产品与版本、参考版本、模型、prompt、来源 Run；
        // 切换产品上下文后旧产品产物标记 stale，禁止再发布。
        if (!hasColumn('pipeline_runs', 'product_version')) {
          db.exec('ALTER TABLE pipeline_runs ADD COLUMN product_version TEXT');
        }
        for (const col of [
          'product_id',
          'product_version',
          'reference_version',
          'model',
          'prompt',
          'source_run_id',
        ]) {
          if (!hasColumn('artifacts', col)) {
            db.exec(`ALTER TABLE artifacts ADD COLUMN ${col} TEXT`);
          }
        }
        if (!hasColumn('artifacts', 'stale')) {
          db.exec('ALTER TABLE artifacts ADD COLUMN stale INTEGER NOT NULL DEFAULT 0');
        }
        db.exec(
          'CREATE INDEX IF NOT EXISTS idx_artifacts_product ON artifacts(product_id, stale)'
        );
      },
    },
    {
      version: 21,
      name: 'add_product_revision_and_generated_media_registry',
      up: () => {
        // S0 第二轮回合修复：
        // 1. products.revision —— 单调递增版本号。CURRENT_TIMESTAMP 是秒级，
        //    同秒内更新产品后 updated_at 不变，旧成片仍能通过版本校验。
        //    revision 每次 PUT 递增，作为唯一可信的 product_version。
        if (!hasColumn('products', 'revision')) {
          db.exec('ALTER TABLE products ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
          // 现有产品按 rowid 赋单调值，保证两两不同
          db.exec('UPDATE products SET revision = rowid WHERE revision = 0');
        }
        // 2. generated_media —— 手工五步链路（不经 orchestrator）的产物登记表。
        //    工作台直接调 /api/pipeline/step2、/step5 生成的视频/成片在此登记，
        //    发布守卫才能追溯「旧产品成片」并 100% 阻断；未登记的 URL 无法证明归属。
        db.exec(`
          CREATE TABLE IF NOT EXISTS generated_media (
            id TEXT PRIMARY KEY,
            product_id TEXT,
            product_version TEXT,
            uri TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT 'step_output',
            stale INTEGER NOT NULL DEFAULT 0,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
          );
          CREATE INDEX IF NOT EXISTS idx_generated_media_product
            ON generated_media(product_id, uri, stale);
        `);
      },
    },
    {
      version: 22,
      name: 'scope_generated_media_to_owner',
      up: () => {
        if (!hasColumn('generated_media', 'owner_id')) {
          db.exec(
            "ALTER TABLE generated_media ADD COLUMN owner_id TEXT NOT NULL DEFAULT 'system'"
          );
        }
        db.exec(`
          DROP INDEX IF EXISTS idx_generated_media_product;
          CREATE INDEX IF NOT EXISTS idx_generated_media_owner_product
            ON generated_media(owner_id, product_id, uri, stale);
        `);
      },
    },
    {
      version: 23,
      name: 'add_cost_ledger',
      up: () => {
        // S1 成本账本（生产埋点）：逐 run/shot 记录 provider、model、版本、seed、
        // 排队/生成时间、重试、失败原因、计费单位、估算/实际成本、人工选择结果、
        // prompt/pipeline/git 版本。未知成本一律存 NULL（unknown），绝不写 0。
        db.exec(`
          CREATE TABLE IF NOT EXISTS cost_ledger (
            id TEXT PRIMARY KEY,
            scope TEXT NOT NULL CHECK (scope IN ('run', 'sample', 'shot')),
            run_id TEXT,
            sample_id TEXT,
            shot_id TEXT,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            model_version TEXT NOT NULL,
            seed INTEGER,
            prompt_version TEXT NOT NULL DEFAULT 'v1.0.0 (S1 无模板)',
            queue_ms INTEGER,
            generation_ms INTEGER,
            retries INTEGER NOT NULL DEFAULT 0,
            failure_reason TEXT,
            billing_tokens INTEGER,
            billing_images INTEGER,
            billing_videos INTEGER,
            billing_audio_seconds INTEGER,
            estimated_usd_cents INTEGER,
            actual_usd_cents INTEGER,
            currency TEXT NOT NULL DEFAULT 'USD',
            source TEXT NOT NULL DEFAULT 'ledger',
            manual_choice TEXT,
            scorecard_version TEXT,
            pipeline_version TEXT,
            git_commit TEXT,
            recorded_at INTEGER NOT NULL,
            owner_id TEXT NOT NULL DEFAULT 'system'
          );
          CREATE INDEX IF NOT EXISTS idx_cost_ledger_run ON cost_ledger(run_id);
          CREATE INDEX IF NOT EXISTS idx_cost_ledger_shot ON cost_ledger(shot_id);
          CREATE INDEX IF NOT EXISTS idx_cost_ledger_owner_time
            ON cost_ledger(owner_id, recorded_at);
        `);
      },
    },
    {
      version: 24,
      name: 'increase_cost_ledger_precision_and_link_pipeline_runs',
      up: () => {
        // AI 单次调用经常低于 $0.01；从 cents 升级为 micros，避免 $0.004 被舍入成 0。
        db.exec(`
          ALTER TABLE cost_ledger
            RENAME COLUMN estimated_usd_cents TO estimated_usd_micros;
          ALTER TABLE cost_ledger
            RENAME COLUMN actual_usd_cents TO actual_usd_micros;
          UPDATE cost_ledger
            SET estimated_usd_micros = estimated_usd_micros * 10000
            WHERE estimated_usd_micros IS NOT NULL;
          UPDATE cost_ledger
            SET actual_usd_micros = actual_usd_micros * 10000
            WHERE actual_usd_micros IS NOT NULL;
        `);
        if (!hasColumn('shot_generation_tasks', 'pipeline_run_id')) {
          db.exec('ALTER TABLE shot_generation_tasks ADD COLUMN pipeline_run_id TEXT');
        }
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_shot_tasks_pipeline_run
            ON shot_generation_tasks(pipeline_run_id, shot_index);
        `);
      },
    },
    {
      version: 26,
      name: 'add_submitting_shot_status',
      transactional: false,
      up: () => {
        // S2 P0 修复：并发付费防重。'submitting' 是镜头提交的原子占位状态——
        // 条件 UPDATE（pending/failed → submitting）作为 claim，只有一个请求能成功；
        // 成功/失败后再落到 generating/completed/failed。服务重启时由 recover 处理
        // 悬挂的 submitting（标记失败，绝不自动重提，沿用 AMBIGUOUS_SUBMISSION 哲学）。
        rebuildTable('shot_generation_tasks', SHOT_STATUS_CHECK_SQL, (sql) => {
          db.exec('DROP INDEX IF EXISTS idx_shot_tasks_pipeline_run');
          db.exec(`
            CREATE TABLE shot_generation_tasks_new (
              id TEXT PRIMARY KEY,
              session_id TEXT NOT NULL,
              owner_id TEXT,
              shot_index INTEGER NOT NULL,
              ${sql},
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
            )
          `);
          db.exec(`
            CREATE INDEX IF NOT EXISTS idx_shot_tasks_pipeline_run
              ON shot_generation_tasks(pipeline_run_id, shot_index)
          `);
        });
      },
    },
    {
      version: 25,
      name: 'add_workbench_state',
      up: () => {
        // S2 工作台持久化状态：三档自主模式 + 独立付费授权 + SaveState +
        // 三处确认点 + 用户分镜草稿（promptOverride/候选选择）。
        // SaveState / AutonomyMode / ConfirmType 枚举与 shared/workbench-contract.ts 同步。
        db.exec(`
          CREATE TABLE IF NOT EXISTS workbench_state (
            id TEXT PRIMARY KEY,
            owner_id TEXT NOT NULL,
            run_id TEXT,
            session_id TEXT,
            autonomy_mode TEXT NOT NULL DEFAULT 'managed'
              CHECK (autonomy_mode IN ('managed', 'confirm_key_points', 'step_by_step')),
            paid_auth_enabled INTEGER NOT NULL DEFAULT 0,
            confirms_json TEXT NOT NULL DEFAULT '{}',
            draft_json TEXT,
            save_state TEXT NOT NULL DEFAULT 'saved'
              CHECK (save_state IN ('saving', 'saved', 'dirty', 'offline_retry')),
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
          );
          CREATE INDEX IF NOT EXISTS idx_workbench_state_owner ON workbench_state(owner_id, run_id);
          CREATE INDEX IF NOT EXISTS idx_workbench_state_session ON workbench_state(session_id);
        `);
      },
    },
    {
      version: 27,
      name: 'add_shot_versions_shot_qa_reports_golden_runs',
      up: () => {
        // P3 质量闭环：镜头版本历史 + 语义 QA 报告存储 + 黄金样例真实运行记录

        // shot_versions：每次生成/重试记录为一个版本，可比较/回退
        db.exec(`
          CREATE TABLE IF NOT EXISTS shot_versions (
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
          CREATE INDEX IF NOT EXISTS idx_shot_versions_shot ON shot_versions(shot_id, version DESC);
          CREATE INDEX IF NOT EXISTS idx_shot_versions_run ON shot_versions(run_id);
        `);

        // shot_qa_reports：每个镜头每个版本的完整 QA 报告（JSON 存储）
        db.exec(`
          CREATE TABLE IF NOT EXISTS shot_qa_reports (
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
          CREATE INDEX IF NOT EXISTS idx_qa_reports_shot ON shot_qa_reports(shot_id, version DESC);
          CREATE INDEX IF NOT EXISTS idx_qa_reports_run ON shot_qa_reports(run_id);
        `);

        // golden_runs：真实黄金样例运行记录（P3 质量基线 §一）
        db.exec(`
          CREATE TABLE IF NOT EXISTS golden_runs (
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
          CREATE INDEX IF NOT EXISTS idx_golden_runs_sample ON golden_runs(sample_id, run_index);
        `);

        // 扩展 shot_generation_tasks：增加 current_version 列
        if (!hasColumn('shot_generation_tasks', 'current_version')) {
          db.exec('ALTER TABLE shot_generation_tasks ADD COLUMN current_version INTEGER NOT NULL DEFAULT 1');
        }
      },
    },
    {
      version: 28,
      name: 'widen_shot_versions_status_check',
      transactional: false,
      up: () => {
        // P3 真实运行修复：shot_versions.status CHECK 缺 'generating'——
        // 真实 provider 异步返回 generating 时版本行插入直接 CHECK 失败（retry_failed）。
        // 重建表，扩展 CHECK 到 (pending, generating, completed, failed, reverted)。
        rebuildTable('shot_versions', 'status TEXT NOT NULL DEFAULT \'pending\'', (sql) => {
          db.exec('DROP INDEX IF EXISTS idx_shot_versions_shot');
          db.exec('DROP INDEX IF EXISTS idx_shot_versions_run');
          db.exec(`
            CREATE TABLE shot_versions_new (
              id TEXT PRIMARY KEY,
              shot_id TEXT NOT NULL,
              run_id TEXT NOT NULL,
              owner_id TEXT NOT NULL,
              version INTEGER NOT NULL,
              video_url TEXT,
              prompt TEXT,
              model_code TEXT,
              ${sql.replace(
                "status TEXT NOT NULL DEFAULT 'pending'",
                "status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'generating', 'completed', 'failed', 'reverted'))"
              )},
              qa_report_id TEXT,
              cost_ledger_id TEXT,
              failure_reason TEXT,
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY (owner_id) REFERENCES users(id)
            )
          `);
          db.exec(`
            CREATE INDEX IF NOT EXISTS idx_shot_versions_shot ON shot_versions_new(shot_id, version DESC);
            CREATE INDEX IF NOT EXISTS idx_shot_versions_run ON shot_versions_new(run_id);
          `);
        });
      },
    },
    {
      version: 29,
      name: 'conditioned_first_frames_provenance',
      up: () => {
        // 产品条件化首帧 provenance（S3「爆款视频 + 产品图 → 复刻成片」）：
        // 记录首帧如何由 参考关键帧 + 产品素材 派生，供证据 JSON / 审计 / 回归对比使用。
        // 首帧是内部派生资产（derivedFirstFrameUrl），不是用户输入。
        db.exec(`
          CREATE TABLE IF NOT EXISTS conditioned_first_frames (
            id TEXT PRIMARY KEY,
            run_id TEXT,
            session_id TEXT,
            shot_id TEXT,
            owner_id TEXT NOT NULL,
            reference_video_url TEXT,
            reference_keyframe_url TEXT,
            product_asset_urls_json TEXT NOT NULL,
            conditioned_first_frame_url TEXT NOT NULL,
            local_path TEXT,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            prompt_version TEXT NOT NULL,
            prompt TEXT,
            confidence REAL,
            preflight_status TEXT,
            preflight_issues_json TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (owner_id) REFERENCES users(id)
          );
          CREATE INDEX IF NOT EXISTS idx_cff_shot ON conditioned_first_frames(shot_id);
          CREATE INDEX IF NOT EXISTS idx_cff_session ON conditioned_first_frames(session_id);
          CREATE INDEX IF NOT EXISTS idx_cff_owner ON conditioned_first_frames(owner_id);
        `);
      },
    },
    {
      version: 30,
      name: 'shot_first_frame_derivation_context',
      up: () => {
        // S3 输入模型纠正：用户只输入 referenceVideoUrl + productAssetUrls。
        // 镜头任务记录「参考视频 / 参考关键帧」（系统自动提取的构图基座）与
        // 「派生首帧」（内部派生产物 derivedFirstFrameUrl——明确标记，不是用户输入）。
        // first_frame_url 仍为工作字段（提交时由派生流程写入）。
        if (!hasColumn('shot_generation_tasks', 'reference_keyframe_url')) {
          db.exec('ALTER TABLE shot_generation_tasks ADD COLUMN reference_keyframe_url TEXT');
        }
        if (!hasColumn('shot_generation_tasks', 'reference_video_url')) {
          db.exec('ALTER TABLE shot_generation_tasks ADD COLUMN reference_video_url TEXT');
        }
        if (!hasColumn('shot_generation_tasks', 'derived_first_frame_url')) {
          db.exec('ALTER TABLE shot_generation_tasks ADD COLUMN derived_first_frame_url TEXT');
        }
        if (!hasColumn('shot_generation_tasks', 'first_frame_preflight_status')) {
          db.exec("ALTER TABLE shot_generation_tasks ADD COLUMN first_frame_preflight_status TEXT DEFAULT 'pending'");
        }
        if (!hasColumn('shot_generation_tasks', 'first_frame_preflight_issues')) {
          db.exec('ALTER TABLE shot_generation_tasks ADD COLUMN first_frame_preflight_issues TEXT');
        }
      },
    },
    {
      version: 31,
      name: 'asset_visual_safety_state',
      up: () => {
        // P5 三轮审查：产品资产与条件化首帧持久化服务端视觉安全状态
        // （hash、face/overlay verdict、检查证据、版本、pass/unverified）；
        // unverified 必须拒绝付费提交（见 lib/visual-safety.ts）。
        for (const table of ['product_assets', 'conditioned_first_frames']) {
          if (!hasColumn(table, 'safety_status')) {
            db.exec(`ALTER TABLE ${table} ADD COLUMN safety_status TEXT DEFAULT 'unverified'`);
          }
          if (!hasColumn(table, 'safety_evidence')) {
            db.exec(`ALTER TABLE ${table} ADD COLUMN safety_evidence TEXT`);
          }
          if (!hasColumn(table, 'safety_checked_at')) {
            db.exec(`ALTER TABLE ${table} ADD COLUMN safety_checked_at TEXT`);
          }
          if (!hasColumn(table, 'safety_version')) {
            db.exec(`ALTER TABLE ${table} ADD COLUMN safety_version TEXT`);
          }
          if (!hasColumn(table, 'sha256')) {
            db.exec(`ALTER TABLE ${table} ADD COLUMN sha256 TEXT`);
          }
        }
      },
    },
    {
      version: 32,
      name: 'invalidate_unbound_visual_safety_passes',
      up: () => {
        // A legacy `pass` without a digest is not evidence about the bytes that
        // will be sent to a provider. Force it through the new hash-bound review.
        for (const table of ['product_assets', 'conditioned_first_frames']) {
          db.prepare(
            `UPDATE ${table}
                SET safety_status = 'unverified',
                    safety_evidence = COALESCE(safety_evidence, 'legacy pass without SHA-256 requires re-review')
              WHERE safety_status = 'pass'
                AND (sha256 IS NULL OR length(sha256) != 64)`
          ).run();
        }
      },
    },
    {
      version: 33,
      name: 'add_provider_capabilities_and_viral_probe_artifacts',
      up: () => {
        // P0 capability probe：provider 真实能力记录（只记录真实 probe 结论，
        // 未验证/不支持的能力如实标注；供 P3 ShotGenerationModule 路由前门禁）。
        db.exec(`
          CREATE TABLE IF NOT EXISTS provider_capabilities (
            provider TEXT NOT NULL,
            model_code TEXT NOT NULL,
            probed_at INTEGER,
            probed_by TEXT,
            capabilities_json TEXT NOT NULL,
            evidence_json TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (provider, model_code)
          );
        `);
        // P0 probe 产物 provenance：参考子视频/控制图/ASR 等控制工件的可追溯记录
        db.exec(`
          CREATE TABLE IF NOT EXISTS viral_probe_artifacts (
            id TEXT PRIMARY KEY,
            run_id TEXT,
            owner_id TEXT,
            kind TEXT NOT NULL,
            source_video_url TEXT,
            local_path TEXT,
            public_url TEXT NOT NULL,
            sha256 TEXT,
            meta_json TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
          CREATE INDEX IF NOT EXISTS idx_viral_probe_artifacts_run ON viral_probe_artifacts(run_id);
        `);
      },
    },
  ]);

  // WAL mode & busy timeout
  try {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec('CREATE INDEX IF NOT EXISTS idx_model_config_category ON model_config(category);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_model_config_default ON model_config(is_default);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_materials_created ON materials(created_at);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_bgm_mood ON bgm_library(mood);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_bgm_bpm ON bgm_library(bpm);');
    db.exec('CREATE INDEX IF NOT EXISTS idx_presets_category ON presets(category);');
  } catch (e) {
    console.warn('[db] Pragma/Index setup notice:', e);
  }

  // 系统级资源所有者占位用户：媒体所有权 FK 需要 owner 存在于 users 表。
  // 内部编排轮询（无会话用户）缓存 Seedance 产物时回退到 'system'；无法登录（随机密码 + disabled）。
  try {
    const salt = randomBytes(16);
    const hash = scryptSync(randomUUID(), salt, 64);
    db.prepare(
      `INSERT OR IGNORE INTO users (id, username, password_hash, role, enabled)
       VALUES ('system', 'system', ?, 'operator', 0)`
    ).run(`${salt.toString('hex')}:${hash.toString('hex')}`);
  } catch (e) {
    console.warn('[db] system user seed notice:', e);
  }

  // Seed default product if empty
  const countStmt = db.prepare('SELECT COUNT(*) as count FROM products');
  const result = countStmt.get() as { count: number };
  if (result.count === 0) {    const insertStmt = db.prepare(`
      INSERT INTO products (
        id, name, category, positioning, price, sales_record,
        model343_clays, model343_extracts, model343_surfactants,
        sgs_oil_8h, sgs_oil_14d, sgs_blackhead_14d,
        prohibited_words, target_audience, custom_selling_points, cover_image
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?
      )
    `);
    insertStmt.run(
      'prod_buv_cleanser',
      'BUV 笔薇 小绿泥洁面',
      '洁面膏/控油洗面奶',
      '油皮专研 · 温和净澈 · 植萃护肤',
      '49元/件',
      '连续2年沙利文国货控油洁面销量第一 / 全网3000万支 / 央视推荐',
      '亚马逊白泥 + 摩洛哥火山泥 + 曼尼古根冰河泥',
      '叶绿素 + 白柳树皮 + 药用层孔菌 + 积雪草',
      '氨基酸 + 甜菜碱 + 脂肪酸',
      '8h 控油 -66.87%',
      '14d 出油 -35.28%',
      '14d 黑头 -35.92%',
      JSON.stringify(['震惊', '必看', '第一名', '绝对', '医用级', '100%根除']),
      '18-35岁油皮/混油皮群体、注重温和控油与黑头清洁问题的年轻人',
      '一润二修三控油，膏体薄荷绿质感拉丝，自然清爽不紧绷',
      'https://images.unsplash.com/photo-1556228720-195a672e8a03?auto=format&fit=crop&w=600&q=80'
    );
    insertStmt.run(
      'prod_copper_serum',
      'BUV 蓝铜胜肽急救修护精华液',
      '精华修护',
      '高浓胜肽 · 快速退红 · 屏障强韧',
      '129元/30ml',
      '天猫修护精华新品榜 Top 1 / SGS 实测 3分钟急救舒缓',
      '99%高纯蓝铜胜肽（深层修护） + 蓝桉叶微凝珠',
      '重组Ⅲ型胶原蛋白 + 积雪草提取物（舒缓退红）',
      '5重神经酰胺 + 依克多因（屏障锁水）',
      '3分钟肌肤泛红 -42.5%',
      '7天经皮水分流失 -28.9%',
      '28天屏障厚度 +18.4%',
      JSON.stringify(['根治过敏', '秒变水光肌', '永久抗衰']),
      '敏感肌、刷酸泛红、医美后修护、换季屏障受损人群',
      '天然梦幻宝石蓝色质地，一抹即化，轻盈不黏腻，专为脆弱肌定制。',
      'https://images.unsplash.com/photo-1620916566398-39f1143ab7be?auto=format&fit=crop&w=600&q=80'
    );
    insertStmt.run(
      'prod_coffee_shampoo',
      'BUV 咖啡因微米蓬松洗发水',
      '洗护控油',
      '微米洁净 · 48小时高颅顶 · 根根立挺',
      '69元/500ml',
      '抖音美发爆款榜 Top 2 / 卖出 500万瓶',
      '德国微米级咖啡因（激活发根微循环）',
      '侧柏叶提取物 + 泛醇 B5（控油养头皮）',
      '无硅油APG微泡表活（深层清爽不堵塞）',
      '48小时持续蓬松',
      '头皮油脂分泌 -52.3%',
      '头屑发生率 -71.2%',
      JSON.stringify(['永不脱发', '三天不洗头', '生发神器']),
      '细软塌发质、扁塌油头、头皮出油发痒的年轻男女',
      '清爽无硅油配方，森林薄荷香调，洗完发根自动立挺，视觉发量暴增。',
      'https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?auto=format&fit=crop&w=600&q=80'
    );
  }

  // Seed default model configs if empty（来源：单一 typed catalog，见 model-catalog.ts）
  const modelCountStmt = db.prepare('SELECT COUNT(*) as count FROM model_config');
  const modelCount = (modelCountStmt.get() as { count: number }).count;
  if (modelCount === 0) {
    const insertModel = db.prepare(`
      INSERT INTO model_config (
        id, name, category, provider, base_url, api_key, model_code,
        recommended_scenario, speed_rating, speed_ms, quality_rating,
        description, badge, enabled, is_default
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    // 只收录云雾/星河实测可用的模型（目录已断言 ID 唯一、每类恰好一个默认）
    for (const m of MODEL_CATALOG) {
      insertModel.run(
        m.id,
        m.id,
        m.category,
        m.provider,
        m.baseUrl,
        m.apiKey,
        m.modelCode,
        m.recommendedScenario,
        m.speedRating,
        m.speedMs,
        m.qualityRating,
        m.description,
        m.badge,
        m.enabled,
        m.isDefault
      );
    }
  }

  // Seed / Upsert standard 30+ BGM library entries
  try {
    const upsertBgm = db.prepare(`
      INSERT INTO bgm_library (
        id, track_name, artist, style_tags, bpm, mood, license_type, audio_path, audio_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        track_name = excluded.track_name,
        artist = excluded.artist,
        style_tags = excluded.style_tags,
        bpm = excluded.bpm,
        mood = excluded.mood,
        license_type = excluded.license_type,
        audio_path = excluded.audio_path,
        audio_url = excluded.audio_url
    `);

    // 清理历史假曲（soundhelix 示例曲），保证库中只有真实可播放的曲目
    db.prepare("DELETE FROM bgm_library WHERE audio_url LIKE '%soundhelix.com%'").run();

    const initialBgmList = [
      // 真实曲目：Pixabay Music 免费商用（免署名），音频文件随仓库分发（assets/bgm/）
      // 卡点Trap (138-140BPM)
      ['bgm_real_trap_beat', 'Trap - Trap Beat', 'BombinSound', JSON.stringify(['卡点Trap', 'Trap', '硬核', '抖音卡点']), 140, '卡点Trap', 'pixabay-free-commercial', 'uploads/bgm/audio_c9de010abb.mp3', ''],
      ['bgm_real_trap_hype', 'Trap - Trap Hype', 'ARPMedia', JSON.stringify(['卡点Trap', 'Trap', '热血', '冲刺']), 140, '卡点Trap', 'pixabay-free-commercial', 'uploads/bgm/audio_fdf868100e.mp3', ''],
      ['bgm_real_dark_trap', 'Dark Trap', 'mirostar', JSON.stringify(['卡点Trap', 'Trap', '暗黑', '力量']), 138, '卡点Trap', 'pixabay-free-commercial', 'uploads/bgm/audio_c5812ffb52.mp3', ''],

      // 治愈Lofi (78-82BPM)
      ['bgm_real_lofi_night', 'Good Night - Lofi Cozy Chill', 'Pixabay Music', JSON.stringify(['治愈Lofi', '安眠', '舒缓']), 78, '治愈Lofi', 'pixabay-free-commercial', 'uploads/bgm/audio_e0908e8569.mp3', ''],
      ['bgm_real_lofi_beats', 'Lofi Beats', 'MondaMusic', JSON.stringify(['治愈Lofi', '休闲', '咖啡馆']), 80, '治愈Lofi', 'pixabay-free-commercial', 'uploads/bgm/audio_2895d67032.mp3', ''],
      ['bgm_real_lofi_smooth', 'Lofi Smooth', 'Pixabay Music', JSON.stringify(['治愈Lofi', '丝滑', '慵懒']), 82, '治愈Lofi', 'pixabay-free-commercial', 'uploads/bgm/audio_cd0251db86.mp3', ''],

      // 轻快Pop (118-122BPM)
      ['bgm_real_upbeat', 'Upbeat', 'Pixabay Music', JSON.stringify(['轻快Pop', '活力', '清新']), 120, '轻快Pop', 'pixabay-free-commercial', 'uploads/bgm/audio_0639a4f890.mp3', ''],
      ['bgm_real_upbeat_music', 'Upbeat - Upbeat Music', 'ARPMedia', JSON.stringify(['轻快Pop', '元气', '明亮']), 122, '轻快Pop', 'pixabay-free-commercial', 'uploads/bgm/audio_fd1bcf288f.mp3', ''],
      ['bgm_real_upbeat_mountain', 'Upbeat Music', 'The Mountain', JSON.stringify(['轻快Pop', '律动', '阳光']), 118, '轻快Pop', 'pixabay-free-commercial', 'uploads/bgm/audio_6253773ef2.mp3', ''],

      // 卡点Electronic (124-128BPM)
      ['bgm_real_electronic', 'Electronic Music', 'The Mountain', JSON.stringify(['卡点Electronic', '电子', '动感']), 126, '卡点Electronic', 'pixabay-free-commercial', 'uploads/bgm/audio_c9226f08b5.mp3', ''],
      ['bgm_real_future_bass', 'Future Bass', 'Pixabay Music', JSON.stringify(['卡点Electronic', '未来', '贝斯']), 128, '卡点Electronic', 'pixabay-free-commercial', 'uploads/bgm/audio_b382b812d7.mp3', ''],
      ['bgm_real_futuristic', 'Futuristic Beat', 'Pixabay Music', JSON.stringify(['卡点Electronic', '未来感', '科技']), 124, '卡点Electronic', 'pixabay-free-commercial', 'uploads/bgm/futuristic-beat-146661.mp3', ''],

      // 品质Ambient (70-72BPM)
      ['bgm_real_ambient_dream', 'Calm Ambient Dreamscape', 'Morgan', JSON.stringify(['品质Ambient', '空灵', '冥想']), 70, '品质Ambient', 'pixabay-free-commercial', 'uploads/bgm/audio_bedae80d67.mp3', ''],
      ['bgm_real_ambient', 'Ambient', 'The Mountain', JSON.stringify(['品质Ambient', '氛围', '舒缓']), 72, '品质Ambient', 'pixabay-free-commercial', 'uploads/bgm/audio_53434c9bdd.mp3', ''],
    ];

    for (const bgm of initialBgmList) {
      upsertBgm.run(...bgm);
    }
  } catch (err) {
    console.warn('[db] bgm upsert notice:', err);
  }

  // Seed / Upsert 8 Master Presets from preset-seeds
  try {
    db.exec(`DELETE FROM presets WHERE id IN ('preset_xhs_healing', 'preset_douyin_card', 'preset_shipin_quality');`);

    const upsertPreset = db.prepare(`
      INSERT INTO presets (id, title, tag, description, cover_image, pipeline_data, category, formula)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        tag = excluded.tag,
        description = excluded.description,
        cover_image = excluded.cover_image,
        pipeline_data = excluded.pipeline_data,
        category = excluded.category,
        formula = excluded.formula
    `);

    for (const p of defaultPresets) {
      upsertPreset.run(...p);
    }
  } catch (err) {
    console.warn('[db] preset upsert notice:', err);
  }

  // Seed default tasks if empty
  const tasksCountStmt = db.prepare('SELECT COUNT(*) as count FROM tasks');
  const tasksCount = (tasksCountStmt.get() as { count: number }).count;
  if (tasksCount === 0) {
    const insertTask = db.prepare(`
      INSERT INTO tasks (id, title, status, current_step, pipeline_data, thumbnail_url)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const defaultTasks = [
      [
        'task_seed_01',
        'BUV 小红书爆款晨间沉浸反推工程',
        'completed',
        5,
        JSON.stringify({
          step1: { inputs: { platform: 'xiaohongshu' }, status: 'completed' },
          step2: { inputs: { videoTone: 'xiaohongshu_healing' }, status: 'completed' },
          step3: { inputs: { targetPlatform: 'xiaohongshu' }, status: 'completed' },
          step4: { inputs: { tonePreference: '治愈' }, status: 'completed' },
          step5: { inputs: { aspectRatio: '3:4' }, status: 'completed' },
        }),
        'https://images.unsplash.com/photo-1556228720-195a672e8a03?auto=format&fit=crop&w=600&q=80',
      ],
      [
        'task_seed_02',
        'BUV 抖音卡点左右脸对比测评工程',
        'processing',
        3,
        JSON.stringify({
          step1: { inputs: { platform: 'douyin' }, status: 'completed' },
          step2: { inputs: { videoTone: 'douyin_beat' }, status: 'completed' },
          step3: { inputs: { targetPlatform: 'douyin' }, status: 'running' },
          step4: { inputs: {}, status: 'idle' },
          step5: { inputs: {}, status: 'idle' },
        }),
        'https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?auto=format&fit=crop&w=600&q=80',
      ],
    ];

    for (const t of defaultTasks) {
      insertTask.run(...t);
    }
  }

  // Backfill empty model API keys / base URLs from 云雾 env (docs/云雾.txt + .env)
  // Gateway already falls back at runtime; this makes 模型中心 UI reflect real routing.
  // 只填充空值，绝不覆盖管理员已保存的配置；目录对齐本身只发生在 migration 18。
  try {
    const yunwuKey = process.env.YUNWU_API_KEY || process.env.GEMINI_API_KEY || '';
    const yunwuBase = (process.env.YUNWU_BASE_URL || 'https://api3.wlai.vip/v1').replace(/\/$/, '');
    if (yunwuKey && yunwuKey !== 'MY_GEMINI_API_KEY' && !yunwuKey.startsWith('your_')) {
      // Text + image models: point empty keys to 云雾 OpenAI-compatible relay
      db.prepare(
        `UPDATE model_config
         SET api_key = CASE WHEN api_key IS NULL OR api_key = '' THEN ? ELSE api_key END,
             base_url = CASE
               WHEN (api_key IS NULL OR api_key = '') AND category IN ('text', 'image') THEN ?
               WHEN base_url IS NULL OR base_url = '' THEN ?
               ELSE base_url
             END
         WHERE category IN ('text', 'image')`
      ).run(yunwuKey, yunwuBase, yunwuBase);
    }

    // Video models: local seedance relay path
    const seedanceBase = (process.env.SEEDANCE_BASE_URL || '').replace(/\/$/, '');
    if (seedanceBase) {
      db.prepare(
        `UPDATE model_config
         SET base_url = ?
         WHERE category = 'video' AND (base_url IS NULL OR base_url = '' OR base_url = '/api/seedance')`
      ).run(seedanceBase);
    }
  } catch (err) {
    console.warn('[db] model_config env backfill skipped:', err);
  }
}
