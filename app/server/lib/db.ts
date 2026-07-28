import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

const dataDir = path.join(process.cwd(), 'data');
const uploadsDir = path.join(process.cwd(), 'uploads');
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

    const initialModels = [
      // Text Models
      ['DeepSeek V3', 'DeepSeek V3', 'text', 'DeepSeek AI Platform', 'https://api.deepseek.com/v1', 'sk-ds-prod-v3-commercial-key-998', 'deepseek-chat', '卖点库提炼、电商爆款文案生成与脚本重构', '极快', '0.8s', '专业级', '深度求索商业旗舰 LLM', 'AI推荐首选', 1, 1],
      ['DeepSeek R1', 'DeepSeek R1', 'text', 'DeepSeek AI Platform', 'https://api.deepseek.com/v1', 'sk-ds-prod-r1-reasoning-key-881', 'deepseek-reasoner', '深度思维链推理、合规规避分析', '标准', '2.5s', '影视级', '具有深度思考力的推理大模型', '深度推理', 1, 0],
      ['GPT-4o', 'GPT-4o', 'text', 'OpenAI Enterprise', 'https://api.openai.com/v1', 'sk-proj-openai-gpt4o-enterprise-key', 'gpt-4o', '全能高保真文案润色与多模态解析', '快速', '1.2s', '专业级', 'OpenAI 旗舰全能大语言模型', null, 1, 0],
      ['Gemini 3.6 Flash', 'Gemini 3.6 Flash', 'text', 'Google Gemini AIGC', 'https://generativelanguage.googleapis.com/v1beta', 'sk-google-gemini-pro-production-v1', 'gemini-3.6-flash', '5步工作台全链路反推与多模态视觉理解', '极快', '0.9s', '专业级', 'Google 极速高多模态模型', null, 1, 0],
      ['Claude 3.5 Sonnet', 'Claude 3.5 Sonnet', 'text', 'Anthropic AI', 'https://api.anthropic.com/v1', 'sk-ant-api03-claude35-sonnet-key', 'claude-3-5-sonnet-20241022', '高质感长文案创作与情感带货脚本', '标准', '1.8s', '影视级', '细腻情感文案王者', null, 1, 0],

      // Image Models
      ['Imagen 4 Ultra', 'Imagen 4 Ultra', 'image', 'Google Gemini AIGC', 'https://generativelanguage.googleapis.com/v1beta', 'sk-google-gemini-pro-production-v1', 'imagen-4-ultra', '超高清写真级重构，膏体微距特写', '精细', '4.8s', '影视级', 'Google 旗舰超高清重构模型', 'AI推荐首选', 1, 1],
      ['Imagen 4', 'Imagen 4', 'image', 'Google Gemini AIGC', 'https://generativelanguage.googleapis.com/v1beta', 'sk-google-gemini-std-key-8890', 'imagen-4-standard', '通用标准商业图，家居浴室场景', '快速', '2.1s', '高清', '标准商业级高画质', null, 1, 0],
      ['Nano Banana Pro', 'Nano Banana Pro', 'image', 'Banana AI Cloud', 'https://api.nanobanana.ai/v2', 'nb-prod-8871923091283', 'nano-banana-pro-v2', '商业摄影渲染，膏体拉丝光影', '标准', '3.5s', '专业级', '轻量化商业摄影模型', null, 1, 0],
      ['GPT Image 2', 'GPT Image 2', 'image', 'OpenAI Enterprise', 'https://api.openai.com/v1', 'sk-proj-openai-dalle2-commercial-key', 'dall-e-3-hd', '写实物理渲染，复杂多光源反射', '标准', '2.8s', '写实级', '写实物理渲染模型', null, 1, 0],

      // Video Models
      ['Seedance 2.0 Fast', 'Seedance 2.0 Fast', 'video', '星河中转 / Seedance', '/api/seedance', 'relay-account-password', 'doubao-seedance-2-0-fast', '快节奏卡点、抖音前3秒冲击力', '极快', '3.2s', '高清', '走星河 Seedance 2.0 中转', '中转默认', 1, 1],
      ['Seedance 2.0', 'Seedance 2.0', 'video', '星河中转 / Seedance', '/api/seedance', 'relay-account-password', 'doubao-seedance-2-0', '商业级物理运镜，膏体拉丝镜头', '精细', '7.2s', '物理级', '星河中转 Seedance 2.0 标准模型', null, 1, 0],
    ];

    for (const m of initialModels) {
      insertModel.run(...m);
    }
  }

  // Seed default BGM library entries if empty
  const bgmCountStmt = db.prepare('SELECT COUNT(*) as count FROM bgm_library');
  const bgmCount = (bgmCountStmt.get() as { count: number }).count;
  if (bgmCount === 0) {
    const insertBgm = db.prepare(`
      INSERT INTO bgm_library (
        id, track_name, artist, style_tags, bpm, mood, license_type, audio_path, audio_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const initialBgmList = [
      ['bgm_morning_breeze', 'Morning Breeze (BUV 晨间清爽主题曲)', 'Chillout SoundLab', JSON.stringify(['治愈Lofi', '晨间轻音乐']), 82, '治愈清爽', '已商业授权', 'uploads/bgm/morning_breeze.mp3', 'https://assets.mixkit.co/music/preview/mixkit-tech-house-vibes-130.mp3'],
      ['bgm_trap_beat', 'Trap Tech Beat 128BPM (抖音卡点神曲)', 'Phonk Master', JSON.stringify(['卡点Electronic', '重低音Trap']), 128, '卡点冲击', '已商业授权', 'uploads/bgm/trap_beat.mp3', 'https://assets.mixkit.co/music/preview/mixkit-hip-hop-02-738.mp3'],
      ['bgm_pure_ambient', 'Pure Water Ambient Glow (小红书沉浸种草)', 'Soft Ambient', JSON.stringify(['纯水声', '高级轻音乐']), 75, '高级沉浸', '已商业授权', 'uploads/bgm/pure_ambient.mp3', 'https://assets.mixkit.co/music/preview/mixkit-feeling-happy-5.mp3'],
      ['bgm_energy_pulse', 'Rhythmic Energy Pulse (硬核测评节奏)', 'Dynamic Sound', JSON.stringify(['节奏Pulse', '商业卡点']), 120, '硬核测评', '已商业授权', 'uploads/bgm/energy_pulse.mp3', 'https://assets.mixkit.co/music/preview/mixkit-games-world-beat-466.mp3'],
    ];

    for (const bgm of initialBgmList) {
      insertBgm.run(...bgm);
    }
  }

  // Seed default presets if empty
  const presetsCountStmt = db.prepare('SELECT COUNT(*) as count FROM presets');
  const presetsCount = (presetsCountStmt.get() as { count: number }).count;
  if (presetsCount === 0) {
    const insertPreset = db.prepare(`
      INSERT INTO presets (id, title, tag, description, cover_image, pipeline_data)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const defaultPresets = [
      [
        'preset_xhs_healing',
        '小红书治愈生活风 (美妆/护肤)',
        '治愈种草',
        '适用于晨间自然光、高润泽肌感与生活Vlog，强调沉浸感与治愈情绪',
        'https://images.unsplash.com/photo-1556228720-195a672e8a03?auto=format&fit=crop&w=600&q=80',
        JSON.stringify({
          step1: { platform: 'xiaohongshu', bloggerType: 'daily_seeding' },
          step2: { videoTone: 'xiaohongshu_healing', durationSec: 4 },
          step3: { targetPlatform: 'xiaohongshu', scriptPersona: '高级感沉浸' },
          step4: { tonePreference: '治愈' },
          step5: { aspectRatio: '3:4', subtitleStyle: '极简小绿红书体' },
        }),
      ],
      [
        'preset_douyin_card',
        '抖音卡点硬核测评 (美妆/控油)',
        '卡点冲击',
        '适用于SGS数据硬核对比、重低音卡点与强转化挂车口播',
        'https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?auto=format&fit=crop&w=600&q=80',
        JSON.stringify({
          step1: { platform: 'douyin', bloggerType: 'ingredients_pro' },
          step2: { videoTone: 'douyin_beat', durationSec: 4 },
          step3: { targetPlatform: 'douyin', scriptPersona: '成分党' },
          step4: { tonePreference: '卡点' },
          step5: { aspectRatio: '9:16', subtitleStyle: '黄字黑边' },
        }),
      ],
      [
        'preset_shipin_quality',
        '视频号高端品质质感 (国货/成分)',
        '品质信任',
        '适用于沙利文销量背书、成分党硬核解析与高客单转化',
        'https://images.unsplash.com/photo-1617897903246-719242758050?auto=format&fit=crop&w=600&q=80',
        JSON.stringify({
          step1: { platform: 'shipinhao', bloggerType: 'ingredients_pro' },
          step2: { videoTone: 'tvc_luxury', durationSec: 5 },
          step3: { targetPlatform: 'shipinhao', scriptPersona: '油皮亲妈' },
          step4: { tonePreference: '高级' },
          step5: { aspectRatio: '9:16', subtitleStyle: '白字柔影' },
        }),
      ],
    ];

    for (const p of defaultPresets) {
      insertPreset.run(...p);
    }
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
}
