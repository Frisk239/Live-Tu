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
}
