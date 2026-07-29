import { db } from '../server/lib/db';

async function updateDbModels() {
  console.log('更新 SQLite 数据库中的 model_config 配置行...');

  db.exec('DELETE FROM model_config');

  const insertStmt = db.prepare(`
    INSERT INTO model_config (
      id, name, category, provider, base_url, api_key, model_code,
      recommended_scenario, speed_rating, speed_ms, quality_rating,
      description, badge, enabled, is_default
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const models = [
    // 文本/多模态模型 (云雾 api3.wlai.vip)
    ['Gemini 3.6 Flash', 'Gemini 3.6 Flash', 'text', '云雾 / Google', 'https://api3.wlai.vip/v1', '', 'gemini-3.6-flash', '5步工作台全链路反推与多模态视觉理解（默认）', '极快', '0.9s', '专业级', '云雾实测可用：文本+识图多模态', '默认', 1, 1],
    ['GPT-4o', 'GPT-4o', 'text', '云雾 / OpenAI', 'https://api3.wlai.vip/v1', '', 'gpt-4o', '全能文案润色与多模态解析', '快速', '1.2s', '专业级', '云雾实测可用：文本+识图', null, 1, 0],
    ['DeepSeek V3', 'DeepSeek V3', 'text', '云雾 / DeepSeek', 'https://api3.wlai.vip/v1', '', 'deepseek-chat', '卖点库提炼、电商爆款文案', '极快', '0.8s', '专业级', '云雾实测可用：纯文本', null, 1, 0],

    // 图片生成模型 (云雾 api3.wlai.vip)
    ['GPT Image 1', 'GPT Image 1', 'image', '云雾 / OpenAI', 'https://api3.wlai.vip/v1', '', 'gpt-image-1', '产品首帧/质感静态图文生图（默认）', '标准', '35s', '写实级', '云雾实测可用 gpt-image-1', '默认', 1, 1],
    ['GPT Image 1 Mini', 'GPT Image 1 Mini', 'image', '云雾 / OpenAI', 'https://api3.wlai.vip/v1', '', 'gpt-image-1-mini', '轻量快速文生图', '快速', '30s', '高清', '云雾实测可用 gpt-image-1-mini', null, 1, 0],
    ['GPT Image 1.5', 'GPT Image 1.5', 'image', '云雾 / OpenAI', 'https://api3.wlai.vip/v1', '', 'gpt-image-1.5', '更强指令遵循的文生图', '标准', '27s', '写实级', '云雾实测可用 gpt-image-1.5', null, 1, 0],
    ['GPT Image 2', 'GPT Image 2', 'image', '云雾 / OpenAI', 'https://api3.wlai.vip/v1', '', 'gpt-image-2', 'OpenAI 最新图像生成', '标准', '35s', '写实级', '云雾实测可用 gpt-image-2', null, 1, 0],
    ['Seedream 4.5', 'Seedream 4.5', 'image', '云雾 / 字节', 'https://api3.wlai.vip/v1', '', 'doubao-seedream-4-5-251128', '字节 Seedream 文生图，速度快', '快速', '13s', '专业级', '云雾实测可用（返回 URL）', null, 1, 0],
    ['Z-Image Turbo', 'Z-Image Turbo', 'image', '云雾 / 通义', 'https://api3.wlai.vip/v1', '', 'z-image-turbo', '开源高效文生图', '极快', '13s', '高清', '云雾实测可用 z-image-turbo', null, 1, 0],

    // 视频生成模型 (星河中转 ai.xmhaini.com)
    ['Seedance 2.0 Fast', 'Seedance 2.0 Fast', 'video', '星河中转 / Seedance', 'https://ai.xmhaini.com', '', 'doubao-seedance-2-0-fast', '快节奏卡点、抖音前3秒冲击力', '极快', '3.2s', '高清', '走星河 Seedance 2.0 中转', '中转默认', 1, 1],
    ['Seedance 2.0', 'Seedance 2.0', 'video', '星河中转 / Seedance', 'https://ai.xmhaini.com', '', 'doubao-seedance-2-0', '商业级物理运镜，膏体拉丝镜头', '精细', '7.2s', '物理级', '星河中转 Seedance 2.0 标准模型', null, 1, 0],
  ];

  for (const m of models) {
    insertStmt.run(...m);
  }

  console.log('✓ SQLite 数据库 model_config 表更新完成！当前写入记录数:', models.length);
}

updateDbModels().catch(console.error);
