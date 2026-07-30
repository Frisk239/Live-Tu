import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { defaultPresets } from './preset-seeds.js';

export { defaultPresets };

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
};

function hasColumn(table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((item) => item.name === column);
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

  // Seed default product if empty
  const countStmt = db.prepare('SELECT COUNT(*) as count FROM products');
  const result = countStmt.get() as { count: number };
  if (result.count === 0) {
    const insertStmt = db.prepare(`
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

  // Seed default model configs if empty
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

    // Only seed models verified against 云雾 (api3.wlai.vip). is_default = one per category.
    // Text/multimodal default: gemini-3.6-flash. Image default: gpt-image-1 (real /images/generations).
    const initialModels = [
      // Text + multimodal (vision via OpenAI-compat chat/completions)
      ['Gemini 3.6 Flash', 'Gemini 3.6 Flash', 'text', '云雾 / Google', 'https://api3.wlai.vip/v1', '', 'gemini-3.6-flash', '5步工作台全链路反推与多模态视觉理解（默认）', '极快', '0.9s', '专业级', '云雾实测可用：文本+识图多模态', '默认', 1, 1],
      ['GPT-4o', 'GPT-4o', 'text', '云雾 / OpenAI', 'https://api3.wlai.vip/v1', '', 'gpt-4o', '全能文案润色与多模态解析', '快速', '1.2s', '专业级', '云雾实测可用：文本+识图', null, 1, 0],
      ['DeepSeek V3', 'DeepSeek V3', 'text', '云雾 / DeepSeek', 'https://api3.wlai.vip/v1', '', 'deepseek-chat', '卖点库提炼、电商爆款文案', '极快', '0.8s', '专业级', '云雾实测可用：纯文本', null, 1, 0],

      // Image gen (OpenAI /images/generations — 云雾实测 200)
      ['GPT Image 1', 'GPT Image 1', 'image', '云雾 / OpenAI', 'https://api3.wlai.vip/v1', '', 'gpt-image-1', '产品首帧/质感静态图文生图（默认）', '标准', '35s', '写实级', '云雾实测可用 gpt-image-1', '默认', 1, 1],
      ['GPT Image 1 Mini', 'GPT Image 1 Mini', 'image', '云雾 / OpenAI', 'https://api3.wlai.vip/v1', '', 'gpt-image-1-mini', '轻量快速文生图', '快速', '30s', '高清', '云雾实测可用 gpt-image-1-mini', null, 1, 0],
      ['GPT Image 1.5', 'GPT Image 1.5', 'image', '云雾 / OpenAI', 'https://api3.wlai.vip/v1', '', 'gpt-image-1.5', '更强指令遵循的文生图', '标准', '27s', '写实级', '云雾实测可用 gpt-image-1.5', null, 1, 0],
      ['GPT Image 2', 'GPT Image 2', 'image', '云雾 / OpenAI', 'https://api3.wlai.vip/v1', '', 'gpt-image-2', 'OpenAI 最新图像生成', '标准', '35s', '写实级', '云雾实测可用 gpt-image-2', null, 1, 0],
      ['Seedream 4.5', 'Seedream 4.5', 'image', '云雾 / 字节', 'https://api3.wlai.vip/v1', '', 'doubao-seedream-4-5-251128', '字节 Seedream 文生图，速度快', '快速', '13s', '专业级', '云雾实测可用（返回 URL）', null, 1, 0],
      ['Z-Image Turbo', 'Z-Image Turbo', 'image', '云雾 / 通义', 'https://api3.wlai.vip/v1', '', 'z-image-turbo', '开源高效文生图', '极快', '13s', '高清', '云雾实测可用 z-image-turbo', null, 1, 0],

      // Video (Seedance 中转，非云雾)
      ['Seedance 2.0 Fast', 'Seedance 2.0 Fast', 'video', '星河中转 / Seedance', '/api/seedance', '', 'doubao-seedance-2-0-fast', '快节奏卡点、抖音前3秒冲击力', '极快', '3.2s', '高清', '走星河 Seedance 2.0 中转', '中转默认', 1, 1],
      ['Seedance 2.0', 'Seedance 2.0', 'video', '星河中转 / Seedance', '/api/seedance', '', 'doubao-seedance-2-0', '商业级物理运镜，膏体拉丝镜头', '精细', '7.2s', '物理级', '星河中转 Seedance 2.0 标准模型', null, 1, 0],
    ];

    for (const m of initialModels) {
      insertModel.run(...m);
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

    const initialBgmList = [
      // 1. 治愈Lofi (70-90BPM)
      ['bgm_morning_breeze', 'Morning Breeze (BUV 晨间清爽)', 'Chillout SoundLab', JSON.stringify(['治愈Lofi', '晨间轻音乐', '护肤日常']), 82, '治愈Lofi', '已商业授权', 'uploads/bgm/morning_breeze.mp3', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3'],
      ['bgm_lofi_rain', 'Lofi Rain Coffee & Skincare', 'Lofi Beats Co.', JSON.stringify(['治愈Lofi', '舒缓氛围', '雨声夜间']), 78, '治愈Lofi', '已商业授权', 'uploads/bgm/lofi_rain.mp3', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-5.mp3'],
      ['bgm_cozy_bedroom', 'Cozy Bedroom Lofi Chill', 'Soft Velvet', JSON.stringify(['治愈Lofi', '睡前修护', '温柔柔声']), 85, '治愈Lofi', '已商业授权', 'uploads/bgm/cozy_bedroom.mp3', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-11.mp3'],
      ['bgm_green_tea_chill', 'Green Tea Cleanse Lofi', 'Zenith Chill', JSON.stringify(['治愈Lofi', '植萃温和', '清爽淡雅']), 76, '治愈Lofi', '已商业授权', 'uploads/bgm/green_tea_chill.mp3', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-12.mp3'],
      ['bgm_sunlight_window', 'Sunlight Window Afternoon', 'Warm Beats', JSON.stringify(['治愈Lofi', '阳光质感', '日常Vlog']), 88, '治愈Lofi', '已商业授权', 'uploads/bgm/sunlight_window.mp3', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-13.mp3'],

      // 2. 轻快Pop (100-120BPM)
      ['bgm_pop_sunshine', 'Sunshine Pop Upbeat Vibe', 'Bright Music', JSON.stringify(['轻快Pop', '阳光活力', '开箱分享']), 115, '轻快Pop', '已商业授权', 'uploads/bgm/pop_sunshine.mp3', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-6.mp3'],
      ['bgm_happy_routine', 'Happy Morning Routine Pop', 'Joy Groove', JSON.stringify(['轻快Pop', '元气满分', '护肤打卡']), 108, '轻快Pop', '已商业授权', 'uploads/bgm/happy_routine.mp3', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-14.mp3'],
      ['bgm_fresh_vibes', 'Fresh Bright Summer Vibes', 'Solar Pop', JSON.stringify(['轻快Pop', '清爽通透', '夏日控油']), 112, '轻快Pop', '已商业授权', 'uploads/bgm/fresh_vibes.mp3', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-15.mp3'],
      ['bgm_chic_style', 'Chic Style Fashion Groove', 'Trendy Beats', JSON.stringify(['轻快Pop', '时尚种草', '彩妆搭配']), 105, '轻快Pop', '已商业授权', 'uploads/bgm/chic_style.mp3', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-16.mp3'],
      ['bgm_sparkle_bounce', 'Sparkle Bounce Fun Beat', 'Pop Factor', JSON.stringify(['轻快Pop', '青春活泼', '好物推荐']), 118, '轻快Pop', '已商业授权', 'uploads/bgm/sparkle_bounce.mp3', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3'],

      // 3. 卡点Electronic (125-140BPM)
      ['bgm_trap_beat', 'Trap Tech Beat 128BPM (抖音卡点神曲)', 'Phonk Master', JSON.stringify(['卡点Electronic', '重低音Trap', '左右脸对比']), 128, '卡点Electronic', '已商业授权', 'uploads/bgm/trap_beat.mp3', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3'],
      ['bgm_edm_drop', 'Electro Drop Bass Boost 130BPM', 'Cyber Synth', JSON.stringify(['卡点Electronic', '强音卡点', '硬核拉丝']), 130, '卡点Electronic', '已商业授权', 'uploads/bgm/edm_drop.mp3', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-7.mp3'],
      ['bgm_cyber_pulse', 'Cyber Pulse Future Bass 135BPM', 'Future Sonic', JSON.stringify(['卡点Electronic', '科技质感', '成分党拆解']), 135, '卡点Electronic', '已商业授权', 'uploads/bgm/cyber_pulse.mp3', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3'],
      ['bgm_glitch_rhythm', 'Glitch Rhythm Staccato', 'Pulse Lab', JSON.stringify(['卡点Electronic', '反转卡点', '视觉冲击']), 126, '卡点Electronic', '已商业授权', 'uploads/bgm/glitch_rhythm.mp3', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3'],
      ['bgm_hyper_energy', 'Hyper Energy Neon Beat 138BPM', 'Neon Waves', JSON.stringify(['卡点Electronic', '高燃卡点', '爆品对标']), 138, '卡点Electronic', '已商业授权', 'uploads/bgm/hyper_energy.mp3', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-8.mp3'],
      ['bgm_techno_stomp', 'Techno Stomp Cleanse Power 132BPM', 'Electro Power', JSON.stringify(['卡点Electronic', '深度洁净', '强效控油']), 132, '卡点Electronic', '已商业授权', 'uploads/bgm/techno_stomp.mp3', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-9.mp3'],

      // 4. 品质Ambient (60-80BPM)
      ['bgm_pure_ambient', 'Pure Water Ambient Glow (小红书沉浸种草)', 'Soft Ambient', JSON.stringify(['品质Ambient', '纯水声', '高级调性']), 75, '品质Ambient', '已商业授权', 'uploads/bgm/pure_ambient.mp3', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3'],
      ['bgm_deep_focus', 'Deep Focus Luxury Ambient', 'Zenith Sound', JSON.stringify(['品质Ambient', '高级清透', '贵妇修护']), 65, '品质Ambient', '已商业授权', 'uploads/bgm/deep_focus.mp3', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-8.mp3'],
      ['bgm_spa_sanctuary', 'SPA Sanctuary Oasis', 'Healing Atmosphere', JSON.stringify(['品质Ambient', '静谧沉浸', '精油芳疗']), 70, '品质Ambient', '已商业授权', 'uploads/bgm/spa_sanctuary.mp3', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-10.mp3'],
      ['bgm_glass_skin_flow', 'Glass Skin Serene Flow', 'Aura Tone', JSON.stringify(['品质Ambient', '透亮质感', '水光护肤']), 68, '品质Ambient', '已商业授权', 'uploads/bgm/glass_skin_flow.mp3', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-11.mp3'],
      ['bgm_velvet_touch', 'Velvet Touch Minimal Soundscape', 'Minimal Sound', JSON.stringify(['品质Ambient', '极简品质', '极速退红']), 62, '品质Ambient', '已商业授权', 'uploads/bgm/velvet_touch.mp3', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-12.mp3'],

      // 5. 节奏R&B (90-110BPM)
      ['bgm_energy_pulse', 'Rhythmic Energy Pulse (硬核测评节奏)', 'Dynamic Sound', JSON.stringify(['节奏R&B', '商业卡点', '硬核测评']), 110, '节奏R&B', '已商业授权', 'uploads/bgm/energy_pulse.mp3', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3'],
      ['bgm_chill_rnb', 'Chill Sunset R&B Routine', 'Smooth Grooves', JSON.stringify(['节奏R&B', '生活方式', '夜间修护']), 95, '节奏R&B', '已商业授权', 'uploads/bgm/chill_rnb.mp3', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-9.mp3'],
      ['bgm_velvet_groove', 'Velvet R&B Urban Groove', 'Urban Lounge', JSON.stringify(['节奏R&B', '都市精致', '洗护蓬松']), 98, '节奏R&B', '已商业授权', 'uploads/bgm/velvet_groove.mp3', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-13.mp3'],
      ['bgm_smooth_breeze', 'Smooth Breeze R&B Jam', 'Soul Collective', JSON.stringify(['节奏R&B', '慵懒舒缓', '护肤洗发']), 92, '节奏R&B', '已商业授权', 'uploads/bgm/smooth_breeze.mp3', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-14.mp3'],
      ['bgm_silk_glide', 'Silk Glide Soulful Beat', 'Rhythm Lab', JSON.stringify(['节奏R&B', '丝滑拉丝', '质感特写']), 104, '节奏R&B', '已商业授权', 'uploads/bgm/silk_glide.mp3', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-15.mp3'],
      ['bgm_midnight_rnb', 'Midnight Oasis Soft R&B', 'Night Groove', JSON.stringify(['节奏R&B', '晚间精养', '修护精华']), 90, '节奏R&B', '已商业授权', 'uploads/bgm/midnight_rnb.mp3', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-16.mp3'],

      // 6. ASMR纯音效
      ['bgm_asmr_water', 'ASMR Pure Water Droplets & Texture', 'Sound Nature Lab', JSON.stringify(['ASMR纯音效', '水滴拉丝', '极致沉浸']), 0, 'ASMR纯音效', '已商业授权', 'uploads/bgm/asmr_water.mp3', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-10.mp3'],
      ['bgm_asmr_foaming', 'ASMR Foam Lathering & Bubbles', 'Foley Sound Studio', JSON.stringify(['ASMR纯音效', '绵密泡泡', '洁面按压']), 0, 'ASMR纯音效', '已商业授权', 'uploads/bgm/asmr_foaming.mp3', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3'],
      ['bgm_asmr_unboxing', 'ASMR Glass Bottle Tapping & Crisp Opening', 'Tactile Audio', JSON.stringify(['ASMR纯音效', '瓶身敲击', '开箱拆封']), 0, 'ASMR纯音效', '已商业授权', 'uploads/bgm/asmr_unboxing.mp3', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3'],
      ['bgm_asmr_dropper', 'ASMR Pipette Droplet & Skincare Application', 'Pure Sense', JSON.stringify(['ASMR纯音效', '滴管倾倒', '精华涂抹']), 0, 'ASMR纯音效', '已商业授权', 'uploads/bgm/asmr_dropper.mp3', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-5.mp3'],
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

  // One-shot migration: older seeds stored enabled=0 for every model, which emptied UI selectors
  try {
    const enabledCount = (db.prepare('SELECT COUNT(*) as count FROM model_config WHERE enabled = 1').get() as { count: number }).count;
    const totalModels = (db.prepare('SELECT COUNT(*) as count FROM model_config').get() as { count: number }).count;
    if (totalModels > 0 && enabledCount === 0) {
      db.exec('UPDATE model_config SET enabled = 1');
    }
  } catch (err) {
    console.warn('[db] model_config enabled migration skipped:', err);
  }

  // Migration: drop fake / unusable models; ensure verified 云雾 defaults
  // (Imagen/NanoBanana/Claude/R1 等在云雾侧无渠道或不可用；文生图实测 gpt-image-1 可用)
  try {
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
    const del = db.prepare('DELETE FROM model_config WHERE id = ?');
    for (const id of fakeIds) del.run(id);

    const upsert = db.prepare(`
      INSERT INTO model_config (
        id, name, category, provider, base_url, api_key, model_code,
        recommended_scenario, speed_rating, speed_ms, quality_rating,
        description, badge, enabled, is_default
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        category = excluded.category,
        provider = excluded.provider,
        model_code = excluded.model_code,
        recommended_scenario = excluded.recommended_scenario,
        speed_rating = excluded.speed_rating,
        speed_ms = excluded.speed_ms,
        quality_rating = excluded.quality_rating,
        description = excluded.description,
        badge = excluded.badge,
        enabled = excluded.enabled,
        is_default = excluded.is_default
    `);

    const yunwuBase = (process.env.YUNWU_BASE_URL || 'https://api3.wlai.vip/v1').replace(/\/$/, '');
    const realModels: any[][] = [
      ['Gemini 3.6 Flash', 'Gemini 3.6 Flash', 'text', '云雾 / Google', yunwuBase, '', 'gemini-3.6-flash', '5步工作台全链路反推与多模态视觉理解（默认）', '极快', '0.9s', '专业级', '云雾实测可用：文本+识图多模态', '默认', 1, 1],
      ['GPT-4o', 'GPT-4o', 'text', '云雾 / OpenAI', yunwuBase, '', 'gpt-4o', '全能文案润色与多模态解析', '快速', '1.2s', '专业级', '云雾实测可用：文本+识图', null, 1, 0],
      ['DeepSeek V3', 'DeepSeek V3', 'text', '云雾 / DeepSeek', yunwuBase, '', 'deepseek-chat', '卖点库提炼、电商爆款文案', '极快', '0.8s', '专业级', '云雾实测可用：纯文本', null, 1, 0],
      ['GPT Image 1', 'GPT Image 1', 'image', '云雾 / OpenAI', yunwuBase, '', 'gpt-image-1', '产品首帧/质感静态图文生图（默认）', '标准', '35s', '写实级', '云雾实测可用 gpt-image-1', '默认', 1, 1],
      ['GPT Image 1 Mini', 'GPT Image 1 Mini', 'image', '云雾 / OpenAI', yunwuBase, '', 'gpt-image-1-mini', '轻量快速文生图', '快速', '30s', '高清', '云雾实测可用 gpt-image-1-mini', null, 1, 0],
      ['GPT Image 1.5', 'GPT Image 1.5', 'image', '云雾 / OpenAI', yunwuBase, '', 'gpt-image-1.5', '更强指令遵循的文生图', '标准', '27s', '写实级', '云雾实测可用 gpt-image-1.5', null, 1, 0],
      ['GPT Image 2', 'GPT Image 2', 'image', '云雾 / OpenAI', yunwuBase, '', 'gpt-image-2', 'OpenAI 最新图像生成', '标准', '35s', '写实级', '云雾实测可用 gpt-image-2', null, 1, 0],
      ['Seedream 4.5', 'Seedream 4.5', 'image', '云雾 / 字节', yunwuBase, '', 'doubao-seedream-4-5-251128', '字节 Seedream 文生图，速度快', '快速', '13s', '专业级', '云雾实测可用（返回 URL）', null, 1, 0],
      ['Z-Image Turbo', 'Z-Image Turbo', 'image', '云雾 / 通义', yunwuBase, '', 'z-image-turbo', '开源高效文生图', '极快', '13s', '高清', '云雾实测可用 z-image-turbo', null, 1, 0],
      ['Seedance 2.0 Fast', 'Seedance 2.0 Fast', 'video', '星河中转 / Seedance', '/api/seedance', '', 'doubao-seedance-2-0-fast', '快节奏卡点、抖音前3秒冲击力', '极快', '3.2s', '高清', '走星河 Seedance 2.0 中转', '中转默认', 1, 1],
      ['Seedance 2.0', 'Seedance 2.0', 'video', '星河中转 / Seedance', '/api/seedance', '', 'doubao-seedance-2-0', '商业级物理运镜，膏体拉丝镜头', '精细', '7.2s', '物理级', '星河中转 Seedance 2.0 标准模型', null, 1, 0],
    ];
    for (const m of realModels) upsert.run(...m);

    // Ensure single default per category
    db.exec(`UPDATE model_config SET is_default = 0 WHERE category = 'text'`);
    db.exec(`UPDATE model_config SET is_default = 1 WHERE id = 'Gemini 3.6 Flash'`);
    db.exec(`UPDATE model_config SET is_default = 0 WHERE category = 'image'`);
    db.exec(`UPDATE model_config SET is_default = 1 WHERE id = 'GPT Image 1'`);
    db.exec(`UPDATE model_config SET is_default = 0 WHERE category = 'video'`);
    db.exec(`UPDATE model_config SET is_default = 1 WHERE id = 'Seedance 2.0 Fast'`);
  } catch (err) {
    console.warn('[db] real-models migration skipped:', err);
  }

  // Backfill empty model API keys / base URLs from 云雾 env (docs/云雾.txt + .env)
  // Gateway already falls back at runtime; this makes 模型中心 UI reflect real routing.
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
