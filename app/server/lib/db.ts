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
      custom_attributes_json TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  try {
    db.exec(`ALTER TABLE products ADD COLUMN custom_attributes_json TEXT;`);
  } catch (_e) {
    // Column already exists
  }

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

  try {
    db.exec(`ALTER TABLE presets ADD COLUMN category TEXT DEFAULT 'universal';`);
  } catch (_e) {}
  try {
    db.exec(`ALTER TABLE presets ADD COLUMN formula TEXT DEFAULT 'hook_demo_cta';`);
  } catch (_e) {}
  try {
    db.exec(`ALTER TABLE materials ADD COLUMN tags TEXT DEFAULT '[]';`);
  } catch (_e) {}

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
      ['bgm_morning_breeze', 'Morning Breeze (BUV 晨间清爽)', 'Chillout SoundLab', JSON.stringify(['治愈Lofi', '晨间轻音乐']), 82, '治愈', '已商业授权', 'uploads/bgm/morning_breeze.mp3', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3'],
      ['bgm_trap_beat', 'Trap Tech Beat 128BPM (抖音卡点神曲)', 'Phonk Master', JSON.stringify(['卡点Electronic', '重低音Trap']), 128, '卡点', '已商业授权', 'uploads/bgm/trap_beat.mp3', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3'],
      ['bgm_pure_ambient', 'Pure Water Ambient Glow (小红书沉浸种草)', 'Soft Ambient', JSON.stringify(['品质Ambient', '纯水声']), 75, '高级', '已商业授权', 'uploads/bgm/pure_ambient.mp3', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3'],
      ['bgm_energy_pulse', 'Rhythmic Energy Pulse (硬核测评节奏)', 'Dynamic Sound', JSON.stringify(['节奏R&B', '商业卡点']), 120, '反差', '已商业授权', 'uploads/bgm/energy_pulse.mp3', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3'],
      ['bgm_lofi_rain', 'Lofi Rain Coffee & Skincare', 'Lofi Beats Co.', JSON.stringify(['治愈Lofi', '舒缓氛围']), 78, '治愈', '已商业授权', 'uploads/bgm/lofi_rain.mp3', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-5.mp3'],
      ['bgm_pop_sunshine', 'Sunshine Pop Upbeat Vibe', 'Bright Music', JSON.stringify(['轻快Pop', '阳光活力']), 115, '活泼', '已商业授权', 'uploads/bgm/pop_sunshine.mp3', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-6.mp3'],
      ['bgm_edm_drop', 'Electro Drop Bass Boost 130BPM', 'Cyber Synth', JSON.stringify(['卡点Electronic', '强音卡点']), 130, '卡点', '已商业授权', 'uploads/bgm/edm_drop.mp3', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-7.mp3'],
      ['bgm_deep_focus', 'Deep Focus Luxury Ambient', 'Zenith Sound', JSON.stringify(['品质Ambient', '高级清透']), 65, '高级', '已商业授权', 'uploads/bgm/deep_focus.mp3', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-8.mp3'],
      ['bgm_chill_rnb', 'Chill Sunset R&B Routine', 'Smooth Grooves', JSON.stringify(['节奏R&B', '生活方式']), 95, '舒适', '已商业授权', 'uploads/bgm/chill_rnb.mp3', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-9.mp3'],
      ['bgm_asmr_water', 'ASMR Pure Water Droplets & Texture', 'Sound Nature Lab', JSON.stringify(['ASMR/纯音效', '极致沉浸']), 0, '沉浸', '已商业授权', 'uploads/bgm/asmr_water.mp3', 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-10.mp3'],
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
      INSERT INTO presets (id, title, tag, description, cover_image, pipeline_data, category, formula)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const defaultPresets = [
      [
        'preset_xhs_healing',
        '小红书治愈生活风 (美妆/护肤)',
        '治愈种草',
        '适用于晨间自然光、高润泽肌感与生活Vlog，强调沉浸感与治愈情绪',
        'https://images.unsplash.com/photo-1556228720-195a672e8a03?auto=format&fit=crop&w=600&q=80',
        JSON.stringify({
          step1: { status: 'completed', inputs: { mediaUrl: 'https://images.unsplash.com/photo-1556228720-195a672e8a03?auto=format&fit=crop&w=600&q=80', platform: 'xiaohongshu', bloggerType: 'daily_seeding', viralReason: '自然光质感+高辨识度绿泥膏体拉丝，评论区问询度高', imageModel: 'GPT Image 1' }, output: { scene: '晨间阳光浴室镜前，暖淡阳光从左侧百叶窗透入', subject: '女性纤手持 BUV 绿泥洁面管身，挤出绿泥膏体带有细腻磨砂颗粒', style: '小红书治愈风', palette: ['#A8D5BA 薄荷绿', '#FFFFFF 纯白', '#F5F5F0 暖白'], lighting: '晨间自然柔光，高光微润，无明显阴影', composition: '三分法对角线构图，管身与膏体居中偏右下', mood: '清爽治愈晨间仪式感', camera: '45度俯拍特写 + 微距大光圈虚化', static_image_prompt: 'a young Asian woman holding BUV mint green clay cleanser tube in a bright sunny bathroom, morning natural light through white blinds, product close-up, creamy mint green texture visible, clean minimalist background, lifestyle photography, high end skincare ad style, soft focus background, 8k resolution', rationale: '小红书爆款=真实晨间场景+产品膏体质感显现+低饱和治愈色调，天然薄荷绿增强油皮清爽心理暗示' } },
          step2: { status: 'completed', inputs: { static_image_prompt: 'a young Asian woman holding BUV mint green clay cleanser tube...', imageUrl: 'https://images.unsplash.com/photo-1556228720-195a672e8a03?auto=format&fit=crop&w=600&q=80', videoTone: 'xiaohongshu_healing', durationSec: 4, videoModel: 'Seedance 2.0 Fast' }, output: { motion_type: 'zoom_in', motion_intensity: 'subtle', motion_description: '镜头由中景缓慢向前推近至 BUV 绿泥膏体挤出瞬间，阳光光斑在管身上缓慢流动', duration_sec: '4', video_prompt: 'A slow smooth zoom-in shot, camera moves closer to the BUV green clay cleanser tube, a gentle push of creamy mint green cleanser emerging, natural morning light flickering smoothly, soft water droplets on the mirror, cinematic motion, 60fps slow motion, ultra smooth', audio_layer: '晨间水滴声 + 阳光微风环境音', negative_prompt: '避免镜头快速旋转，避免产品膏体变形，避免镜头抖动' } },
          step3: { status: 'completed', inputs: { videoPrompt: 'A slow smooth zoom-in shot...', targetPlatform: 'xiaohongshu', scriptPersona: '油皮亲妈' }, output: { title: '大油田的晨间快乐水！挤出来是冰淇淋泥膏🍃', hook: '夏天早上起来脸像喷油池？试试这支3重泥控油！', body: '每次用 BUV 笔薇小绿泥，像给毛孔做了一场冰爽 SPA！\n\n它用了亚马逊白泥+火山泥+冰河泥 3重天然泥，结合 4重控油植萃。SGS 实测 8小时控油达 -66.87%！不仅控油还不紧绷，洗完脸水嫩透亮～', hashtags: ['#BUV小绿泥', '#油皮洁面推荐', '#控油洗面奶', '#晨间护肤'], cta: '油皮姐妹快去试试，真的会爱上洗脸的感觉！', platform_fit: { douyin: '大油田救星！实测8小时控油-66.87%！BUV小绿泥洗完整天不泛油！点击下方小黄车直接领优惠～', xiaohongshu: '晨间洗脸仪式感！BUV小绿泥冰淇淋膏体敲治愈🍃 3重泥+4重植萃，SGS实测14天黑头都少了35.92%～' } } },
          step4: { status: 'completed', inputs: { copywritingTitle: '大油田的晨间快乐水！挤出来是冰淇淋泥膏🍃', tonePreference: '治愈', commercialScenario: '抖音/小红书商业化' }, output: { bgm_recommendation: { track_name: 'Morning Dew & Mint Breeze', artist: 'Chillout SoundLab', style: ['治愈Lofi', '晨间轻音乐', '环境音润饰'], bpm: '82', mood_match: '柔和的钢琴伴以低沉Lofi鼓点，完美契合晨间舒缓沉浸的洗脸场景', sync_point: '1.2s（挤出膏体瞬间）、2.8s（泡沫展现特写）', license_note: '抖音/小红书音效库免版权商业授权（CC0认证）' }, alternatives: [{ track_name: 'Soft Waterdrops', style: '纯水声+轻音乐', when_to_use: '适合小红书Vlog原声感配音' }, { track_name: 'Fresh Start Piano', style: '清爽钢琴曲', when_to_use: '适合偏大牌TVC质感短视频' }] } },
          step5: { status: 'completed', inputs: { aspectRatio: '9:16', subtitleStyle: '黄字黑边' }, output: { timeline: [{ at: '0.0s', action: 'video_in', source: 'video_step2.mp4' }, { at: '0.0s', action: 'audio_in', source: 'morning_dew.mp3', volume: 0.3 }, { at: '0.2s', action: 'subtitle_in', text: '夏天早上起来脸像喷油池？', position: 'bottom_center' }, { at: '1.5s', action: 'subtitle_in', text: 'BUV小绿泥 SGS实测8小时控油-66.87%', position: 'bottom_center' }, { at: '2.8s', action: 'brand_stamp', text: '沙利文国货控油洁面销量第一', position: 'top_right' }, { at: '3.8s', action: 'subtitle_in', text: '点击左下角领油皮福利！', position: 'bottom_center' }], output: { filename: 'buv_v_20260723_morning.mp4', resolution: '1080x1920', format: 'mp4_h264', duration_sec: 4 }, qa_checklist: ['✓ 音画精准卡点（1.2s膏体拉丝音效到位）', '✓ SGS 8小时控油数据字幕明显高亮', '✓ 字幕位于下方20%区域，不挡产品管身', '✓ 结尾带右上方沙利文第一品牌认证角标'] } },
        }),
        'xiaohongshu',
        'routine',
      ],
      [
        'preset_douyin_card',
        '抖音卡点硬核测评 (美妆/控油)',
        '卡点冲击',
        '适用于SGS数据硬核对比、重低音卡点与强转化挂车口播',
        'https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?auto=format&fit=crop&w=600&q=80',
        JSON.stringify({
          step1: { status: 'completed', inputs: { mediaUrl: 'https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?auto=format&fit=crop&w=600&q=80', platform: 'douyin', bloggerType: 'skincare_expert', viralReason: '左右半脸对比+吸油纸压脸实测，完播率高', imageModel: 'GPT Image 1' }, output: { scene: '专业皮肤实验室/高质感冷调化妆台，带有数显吸油量仪器', subject: '博主将吸油纸贴在额头，左边普通洗面奶满油，右边 BUV 洁面干爽', style: '抖音硬核测评风', palette: ['#00B060 BUV绿', '#222222 深灰', '#00E5FF 科技蓝'], lighting: '高对比冷白环形灯，细节极其清晰', composition: '左右对比分屏构图 + 中央放大标注', mood: '硬核科学专业信任感', camera: '高清平视中景，快速卡点推镜头', static_image_prompt: 'split screen photo testing skin oil levels, left side oily skin with blue blot paper saturated, right side clean matte skin holding BUV mint green cleanser, clinical beauty lab background, ring light reflections, text overlay graphics style, 4k ultra detailed', rationale: '抖音爆款=前3秒强反差钩子+实验数据可视证明+黑马产品强引导' } },
          step2: { status: 'completed', inputs: { static_image_prompt: 'split screen photo testing skin oil levels...', imageUrl: 'https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?auto=format&fit=crop&w=600&q=80', videoTone: 'douyin_beat', durationSec: 5, videoModel: 'Seedance 2.0 Fast' }, output: { motion_type: 'pan_left', motion_intensity: 'strong', motion_description: '镜头由左边油光脸快速横移至右边BUV洗完的哑光干爽脸，伴随数据图表动效弹出', duration_sec: '5', video_prompt: 'Fast dynamic whip pan shot from left oily forehead to right clean matte face with BUV green cleanser, glowing HUD data showing oil decrease -66.8%, high energy fast pacing, studio lighting, clear skin details, cinematic commercial video', audio_layer: '重低音卡点 + 机械扫描音效', negative_prompt: '避免过度虚化导致数据看不清，避免低画质' } },
          step3: { status: 'completed', inputs: { videoPrompt: 'Fast dynamic whip pan shot...', targetPlatform: 'douyin', scriptPersona: '成分党' }, output: { title: '油皮别瞎洗了！SGS实测8小时控油-66.87%！🔥', hook: '吸油纸一压全是油？你洗脸洗对了吗？', body: '看看 SGS 专业报告！BUV 笔薇小绿泥，凭什么能卖爆3000万支？\n\n核心就在它的【3:4:3 清爽控油模型】：亚马逊白泥吸走老废角质，4重植萃调节油脂。实测打出的泡沫比奶油还细！洗完8小时不出油！', hashtags: ['#BUV小绿泥', '#控油洗面奶', '#SGS实测', '#油皮救星'], cta: '点击下方链接，领买一送一专属补贴！', platform_fit: { douyin: '油皮炸裂推荐！SGS权威机构认证：8小时控油-66.87%，14天黑头少35.92%！BUV小绿泥现在只要49！速抢！', xiaohongshu: '成分党硬核扒成分！BUV小绿泥不只是控油，3重泥+4重植萃温和不伤肤，大油田洗完真的会谢！' } } },
          step4: { status: 'completed', inputs: { copywritingTitle: '油皮别瞎洗了！SGS实测8小时控油-66.87%！🔥', tonePreference: '卡点', commercialScenario: '抖音/小红书商业化' }, output: { bgm_recommendation: { track_name: 'Trap Tech Beat 128BPM', artist: 'Phonk Master', style: ['卡点Electronic', '重低音Trap', '高节奏打击'], bpm: '128', mood_match: '强节奏低音震感，极其适合抖音前3秒冲击力与硬核测评卡点', sync_point: '0.8s（吸油纸撕开）、2.2s（SGS报告弹出）、4.0s（领优惠卡点）', license_note: '抖音短视频曲库已商业授权' }, alternatives: [{ track_name: 'Future Bass Rush', style: '电音节奏', when_to_use: '适合年轻学生人群卡点' }, { track_name: 'Cyber Attack', style: '科技节奏', when_to_use: '适合实验室测评风' }] } },
          step5: { status: 'completed', inputs: { aspectRatio: '9:16', subtitleStyle: '黄字黑边' }, output: { timeline: [{ at: '0.0s', action: 'video_in', source: 'video_step2.mp4' }, { at: '0.0s', action: 'audio_in', source: 'trap_tech.mp3', volume: 0.35 }, { at: '0.0s', action: 'subtitle_in', text: '吸油纸一压全是油？你洗脸洗对了吗？', position: 'bottom_center' }, { at: '2.0s', action: 'subtitle_in', text: 'BUV小绿泥 SGS实测：8小时控油-66.87%', position: 'bottom_center' }, { at: '3.5s', action: 'brand_stamp', text: '沙利文国货控油洁面销量第一', position: 'top_right' }, { at: '4.2s', action: 'subtitle_in', text: '点击左下角，领买一送一活动！', position: 'bottom_center' }], output: { filename: 'buv_v_20260723_hardcore.mp4', resolution: '1080x1920', format: 'mp4_h264', duration_sec: 5 }, qa_checklist: ['✓ 强低音卡点精准触发', '✓ 黄字黑边高对比字幕保障完播与可读性', '✓ SGS 权威数据文字大字高亮', '✓ 左下角引导挂车箭头指引明确'] } },
        }),
        'douyin',
        'before_after',
      ],
      [
        'preset_shipin_quality',
        '视频号高端品质质感 (国货/成分)',
        '品质信任',
        '适用于沙利文销量背书、成分党硬核解析与高客单转化',
        'https://images.unsplash.com/photo-1617897903246-719242758050?auto=format&fit=crop&w=600&q=80',
        JSON.stringify({
          step1: { status: 'completed', inputs: { mediaUrl: 'https://images.unsplash.com/photo-1512290900673-7002fffe929a?auto=format&fit=crop&w=600&q=80', platform: 'shipinhao', bloggerType: 'skincare_expert', viralReason: '鼻翼毛孔细腻度对比 + 绿泥微孔吸附视觉 + 品质信任背书', imageModel: 'GPT Image 1' }, output: { scene: '高奢护肤光感镜头，洁面泡沫覆盖鼻翼与 T 区', subject: 'BUV 绿泥细腻泡沫深层揉搓，洗后鼻翼通透哑光', style: '高质感护肤大片', palette: ['#A8D5BA 薄荷绿', '#2A302E 深绿灰', '#FFFFFF 纯白'], lighting: '柔光箱 45 度侧光，透出肌肤水润微光', composition: '极近微距特写构图', mood: '极度舒爽清透沉浸', camera: '100mm 护肤微距镜头', static_image_prompt: 'extreme macro shot of nose and cheek skin with rich creamy mint green cleanser bubbles, BUV skincare product, 14-day pore refinement comparison visual, ultra detailed skin texture, soft studio lighting, water splash elements, 8k resolution', rationale: '种草黑马=直观痛点解决（黑头/毛孔）+高清透视觉感+数据背书' } },
          step2: { status: 'completed', inputs: { static_image_prompt: 'extreme macro shot of nose and cheek skin with rich creamy mint green cleanser bubbles...', imageUrl: 'https://images.unsplash.com/photo-1512290900673-7002fffe929a?auto=format&fit=crop&w=600&q=80', videoTone: 'xiaohongshu_healing', durationSec: 4, videoModel: 'Seedance 2.0 Fast' }, output: { motion_type: 'zoom_in', motion_intensity: 'subtle', motion_description: '微距镜头极其缓慢滑过洁面泡沫，泡沫在微风中微微浮动，展现丰富细腻包覆感', duration_sec: '4', video_prompt: 'Extreme macro slow motion video, camera glides over rich dense mint green cleanser foam on skin, tiny bubbles moving smoothly, soft studio light reflections, crystal clean aesthetic, 4k 60fps', audio_layer: '细腻泡沫揉搓声 + 柔和流水音效', negative_prompt: '避免皮肤噪点过重，避免画面过于暗淡' } },
          step3: { status: 'completed', inputs: { videoPrompt: 'Extreme macro slow motion video...', targetPlatform: 'shipinhao', scriptPersona: '高级感沉浸' }, output: { title: '鼻翼黑头真的被"吸"走了！14天黑头-35.92%！✨', hook: '毛孔粗大还爱长黑头？别再用撕拉面膜伤害皮肤了！', body: '用 BUV 笔薇小绿泥，3重天然泥（白泥+火山泥+冰河泥）就像毛孔磁铁，把深层油脂黑头通通吸走！SGS 权威实测 14 天黑头少 35.92%！而且加了 4 重控油植萃，洗完水润舒缓，完全不拉扯皮肤～', hashtags: ['#BUV小绿泥', '#去黑头洗面奶', '#毛孔收敛', '#油敏肌洁面'], cta: '黑头姐妹快试试，洗出通透水光肌！', platform_fit: { douyin: '黑头党狂喜！SGS权威实测14天黑头少35.92%！BUV小绿泥3重天然泥微孔吸附，现在只要49！', xiaohongshu: '告别撕拉面膜！BUV小绿泥温柔去黑头，3重泥+4重植萃，洗完鼻翼干净又清爽～', shipinhao: '国货品质之选！BUV小绿泥SGS权威认证，14天黑头-35.92%，3重天然泥温和吸附不伤肤～' } } },
          step4: { status: 'completed', inputs: { copywritingTitle: '鼻翼黑头真的被"吸"走了！14天黑头-35.92%！✨', tonePreference: '高级', commercialScenario: '抖音/小红书商业化' }, output: { bgm_recommendation: { track_name: 'Crystal Clear Water Ambience', artist: 'Pure Zen Audio', style: ['水感轻音乐', '治愈ASMR', '高质感背景音'], bpm: '90', mood_match: '清澈透亮的音色，完美衬托黑头净澈与毛孔水润收敛过程', sync_point: '1.0s（泡沫展示）、2.5s（SGS黑头报告）', license_note: '小红书音效库免版权商业授权' }, alternatives: [{ track_name: 'Pure Skin Vibe', style: '轻快Lofi', when_to_use: '适合日常 Vlog 种草' }] } },
          step5: { status: 'completed', inputs: { aspectRatio: '9:16', subtitleStyle: '白字柔影' }, output: { timeline: [{ at: '0.0s', action: 'video_in', source: 'video_step2.mp4' }, { at: '0.0s', action: 'audio_in', source: 'crystal_water.mp3', volume: 0.3 }, { at: '0.2s', action: 'subtitle_in', text: '别再用撕拉面膜伤害皮肤了！', position: 'bottom_center' }, { at: '1.8s', action: 'subtitle_in', text: 'BUV小绿泥 SGS实测：14天黑头-35.92%', position: 'bottom_center' }, { at: '3.6s', action: 'subtitle_in', text: '洗出哑光透亮好皮肤！', position: 'bottom_center' }], output: { filename: 'buv_v_20260723_pores.mp4', resolution: '1080x1920', format: 'mp4_h264', duration_sec: 4 }, qa_checklist: ['✓ SGS 14天黑头数据卡点清晰', '✓ 高清微距画面极具说服力', '✓ 音效轻盈质感高级'] } },
        }),
        'shipinhao',
        'ingredient_intro',
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
