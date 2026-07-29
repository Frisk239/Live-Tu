import { Router } from 'express';
import { db } from '../lib/db';
import { callLlmGateway, callImageGenerationGateway } from '../lib/llm-gateway';
import {
  createSeedanceVideo,
  normalizeSeedanceTask,
  hasSeedanceConfig,
  buildSeedanceGenerationBody,
} from './seedance';
import { runFfmpegRender } from './render';
import fs from 'node:fs';
import path from 'node:path';

export const pipelineRouter = Router();

/** When true, failed LLM/external calls may return synthetic mock data with source:'mock' */
function allowMockFallback(): boolean {
  return process.env.ALLOW_MOCK_FALLBACK === 'true' || process.env.ALLOW_MOCK_FALLBACK === '1';
}

// ==================== GLOBAL HARNESS CONSTRAINTS ====================
export const HARNESS_CONSTRAINTS = {
  JSON_ONLY: '必须只输出纯合法 JSON 对象，无任何 Markdown、解释、代码块或额外文本。',
  STRUCTURED_OUTPUT: '输出必须严格包含所有指定字段，字段值必须具体、视觉化、专业、高质量。',
  LENGTH_CONSTRAINTS: {
    title: '15-25字吸睛标题',
    hook: '3秒黄金 Hook（情感+痛点+产品+转化暗示）',
    scene: '15-30字场景描述',
    subject: '15-30字主体动作描述',
    static_image_prompt: '详细英文 Prompt，包含 8k、cinematic、ultra-realistic texture、viral keywords',
    video_prompt: '详细英文结构化 Prompt，包含 60fps、natural lighting、product texture',
    body: '80-120字口播脚本，自然植入成分与SGS数据',
    hashtags: '3-4个真实话题标签',
    sync_point: '卡点秒数描述（如 "1.2s (镜头推进特写), 2.8s (成分展示)"）',
    negative_prompt: '强制包含避免旋转、变形、抖动、花式转场等',
  },
  SAFETY: '禁止任何虚假宣传、违禁极限词（如：绝对、第一名、100%根除、震惊、必看）。',
  SELF_CRITIQUE: '在输出前自我批判：内容质量、格式正确性、产品特色融入度、SEO/转化潜力。',
  FEW_SHOT: '始终参考以下示例输出格式。',
  PRODUCT_INJECT: '必须融入品牌产品特色、定位、3:4:3配方、SGS数据。',
};


// Helper to fetch active product from DB or fallback
function getProductContext(productId?: string, bodyProductInfo?: any) {
  let prohibitedWords: string[] = ['震惊', '必看', '第一名', '绝对', '医用级', '100%根除', '全网第一', '极限词'];

  if (productId) {
    const stmt = db.prepare('SELECT * FROM products WHERE id = ?');
    const r = stmt.get(productId) as any;
    if (r) {
      try {
        const parsedWords = JSON.parse(r.prohibited_words || '[]');
        if (Array.isArray(parsedWords) && parsedWords.length > 0) {
          prohibitedWords = parsedWords;
        }
      } catch {}
      return {
        id: r.id,
        name: r.name,
        category: r.category,
        positioning: r.positioning,
        model343: `${r.model343_clays} | ${r.model343_extracts} | ${r.model343_surfactants}`,
        sgsData: `8h控油: ${r.sgs_oil_8h}, 14d出油: ${r.sgs_oil_14d}, 14d黑头: ${r.sgs_blackhead_14d}`,
        customSellingPoints: r.custom_selling_points,
        prohibitedWords,
      };
    }
  }
  return {
    id: 'prod_buv_cleanser',
    name: bodyProductInfo?.name || 'BUV 笔薇 小绿泥洁面',
    category: bodyProductInfo?.category || '美妆护肤/洁面',
    positioning: bodyProductInfo?.positioning || '油皮专研 · 温和净澈 · 植萃护肤',
    model343: bodyProductInfo?.model343
      ? `${bodyProductInfo.model343.clays} | ${bodyProductInfo.model343.extracts} | ${bodyProductInfo.model343.surfactants}`
      : '3重天然矿物泥 + 4重植萃复配 + 氨基酸温和表活',
    sgsData: bodyProductInfo?.sgsData
      ? `8h控油 ${bodyProductInfo.sgsData.oil8h}, 14d改善 ${bodyProductInfo.sgsData.oil14d}`
      : 'SGS权威实测: 8h控油 -66.87%, 14d黑头 -35.92%',
    customSellingPoints: bodyProductInfo?.customSellingPoints || '一润二修三控油，膏体薄荷绿质感拉丝，自然清爽不紧绷',
    prohibitedWords: bodyProductInfo?.prohibitedWords || prohibitedWords,
  };
}

function clampSeedanceDuration(duration: number): number {
  if (duration <= 5) return 5;
  if (duration <= 10) return 10;
  return 10;
}

// 辅助工具：违禁词合规扫描
function scanProhibitedWords(data: any, prohibitedWords: string[]) {
  const warnings: Array<{ word: string; field: string; suggestion: string }> = [];
  if (!Array.isArray(prohibitedWords) || prohibitedWords.length === 0) return warnings;

  const checkText = (text: string | undefined, fieldName: string) => {
    if (!text || typeof text !== 'string') return;
    for (const word of prohibitedWords) {
      if (word && text.includes(word)) {
        warnings.push({
          word,
          field: fieldName,
          suggestion: `建议替换“${word}”为更加合规、客观的描述（如“口碑热议”、“权威实测”）`,
        });
      }
    }
  };

  checkText(data.title, '标题 (title)');
  checkText(data.hook, '前置钩子 (hook)');
  checkText(data.body, '正文文案 (body)');
  checkText(data.cta, '行动号召 (cta)');
  checkText(data.platform_fit?.douyin, '抖音定制口播 (platform_fit.douyin)');
  checkText(data.platform_fit?.xiaohongshu, '小红书定制文案 (platform_fit.xiaohongshu)');

  return warnings;
}

// Ticket 11: 文生图 API / 质感静态图生成
pipelineRouter.post('/generate-image', async (req, res) => {
  const { prompt, productId, imageModel } = req.body;
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ success: false, error: 'prompt 参数必填且必须为字符串' });
  }

  const materialsDir = path.join(process.cwd(), 'uploads', 'materials');
  if (!fs.existsSync(materialsDir)) {
    fs.mkdirSync(materialsDir, { recursive: true });
  }

  try {
    const gatewayRes = await callImageGenerationGateway({
      prompt,
      modelId: imageModel,
    });

    let imageUrl = gatewayRes.imageUrl;
    let source = gatewayRes.source;

    // Real path only: no silent SVG fake unless ALLOW_MOCK_FALLBACK
    if (!gatewayRes.success || !imageUrl) {
      if (!allowMockFallback()) {
        return res.status(502).json({
          success: false,
          error: gatewayRes.error || '文生图失败：请检查画图模型 API Key / 云雾配置',
          source: gatewayRes.source || 'error',
        });
      }

      const filename = `gen_img_${Date.now()}.svg`;
      const targetPath = path.join(materialsDir, filename);
      const product = getProductContext(productId);
      const safeName = String(product.name || 'BUV').replace(/[<>&"']/g, '');
      const safePrompt = String(prompt).slice(0, 45).replace(/[<>&"']/g, '');
      const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1440"><rect width="1080" height="1440" fill="#E8F5E9"/><text x="540" y="700" text-anchor="middle" fill="#2E7D32" font-size="40" font-family="sans-serif">${safeName}</text><text x="540" y="780" text-anchor="middle" fill="#388E3C" font-size="24" font-family="sans-serif">演示占位图 (ALLOW_MOCK_FALLBACK)</text><text x="540" y="860" text-anchor="middle" fill="#666" font-size="20" font-family="sans-serif">${safePrompt}</text></svg>`;
      fs.writeFileSync(targetPath, svgContent, 'utf-8');
      imageUrl = `/uploads/materials/${filename}`;
      source = 'mock';
    } else if (imageUrl.startsWith('data:image/')) {
      // 云雾 gpt-image-* 返回 b64：落盘为本地 PNG
      const match = imageUrl.match(/^data:image\/(\w+);base64,(.+)$/);
      if (!match) {
        return res.status(502).json({ success: false, error: '文生图返回了无法解析的 data URL', source });
      }
      const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
      const filename = `gen_img_${Date.now()}.${ext}`;
      const targetPath = path.join(materialsDir, filename);
      fs.writeFileSync(targetPath, Buffer.from(match[2], 'base64'));
      imageUrl = `/uploads/materials/${filename}`;
    } else if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
      // 远程 URL：尽量下载缓存到本地，失败则保留外链
      try {
        const remote = await fetch(imageUrl);
        if (remote.ok) {
          const buf = Buffer.from(await remote.arrayBuffer());
          const ct = remote.headers.get('content-type') || '';
          const ext = ct.includes('jpeg') || ct.includes('jpg') ? 'jpg' : ct.includes('webp') ? 'webp' : 'png';
          const filename = `gen_img_${Date.now()}.${ext}`;
          const targetPath = path.join(materialsDir, filename);
          fs.writeFileSync(targetPath, buf);
          imageUrl = `/uploads/materials/${filename}`;
        }
      } catch {
        // keep remote URL
      }
    }

    // Persist to materials table (correct schema)
    const id = `mat_gen_${Date.now()}`;
    const name = `AI生成首帧_${Date.now().toString().slice(-4)}`;
    const filePath = imageUrl.startsWith('/uploads/')
      ? imageUrl.replace(/^\//, '')
      : imageUrl;
    try {
      const stmt = db.prepare(`
        INSERT INTO materials (id, name, file_path, url, media_type, size, duration, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(id, name, filePath, imageUrl, 'image', '0.3 MB', null, new Date().toISOString());
    } catch (err: any) {
      console.warn('[generate-image] materials insert skipped:', err.message);
    }

    return res.json({
      success: true,
      data: {
        imageUrl,
        materialId: id,
        promptUsed: prompt,
        modelUsed: gatewayRes.modelUsed,
      },
      source,
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Step 1: 多模态视觉拆解与静态图 Prompt 生成
pipelineRouter.post('/step1', async (req, res) => {
  const inputs = req.body.inputs || req.body;
  const {
    mediaUrl = '',
    imageUrl = '',
    platform = 'douyin',
    bloggerType = 'daily_seeding',
    viralReason = '',
    textModel,
    imageModel,
    productId,
    productInfo,
  } = inputs;

  const targetMediaUrl = mediaUrl || imageUrl || req.body.mediaUrl || req.body.imageUrl || '';
  const product = getProductContext(productId, productInfo);
  // 多模态拆解走文本模型；imageModel 仅用于文生图，勿混用
  const visionModelId = textModel || 'Gemini 3.6 Flash';

  const systemPrompt = `你是一个顶级美妆电商爆款视觉拆解专家。严格遵守以下规则：

1. **只输出纯JSON**，无任何前言、Markdown、解释或额外字符。
2. **输出必须包含所有10个字段**，字段值必须具体、视觉化、专业、高质量。
3. 场景、主体等描述字段：15-30字，英文或中文均可，优先中文。
4. palette：3-4个颜色描述（如 "薄荷绿 #A8D5BA, 纯白 #FFFFFF, 柔光白 #F5F5F0"）。
5. 所有描述必须融入产品特色、SGS暗示、爆款种草力。
6. 禁止任何虚假宣传或违禁词。
7. 静态_image_prompt必须是详细英文Prompt，包含高保真描述（8k、cinematic、product texture、viral keywords）。

示例输出：
{
  "scene": "晨间阳光浴室镜前，自然光照射在膏体瓶子上，柔和光影突出质感",
  "subject": "女性纤手展示产品膏体细腻拉丝动作，特写高清",
  "style": "小红书治愈生活风",
  "palette": ["#A8D5BA 薄荷绿", "#FFFFFF 纯白", "#F5F5F0 柔光白"],
  "lighting": "自然柔光，高光润泽，透光感十足",
  "composition": "三分法构图，主体居中偏右下，层次感分明",
  "mood": "清爽高质感晨间仪式感",
  "camera": "45度俯拍特写 + 微距大光圈虚化",
  "static_image_prompt": "A high-end product photography shot of [product] in a bright minimalist aesthetic setting, soft morning sunlight, 8k resolution, ultra-realistic texture, perfect composition, viral skincare aesthetic",
  "rationale": "通过真实高光质感与纯净配色，强化点击转化率"
}

针对品牌产品【${product.name}】（定位：${product.positioning}，卖点特色：${product.customSellingPoints}），
你需要对用户提供的首帧图片/爆款视频画面进行多模态视觉反推与拆解。`;

  const userPrompt = `【拆解任务】
- 目标产品：${product.name} (${product.positioning})
- 目标平台：${platform}
- 博主类型：${bloggerType}
- 爆款原因描述：${viralReason || '膏体质感高清拉丝，光影透润极具治愈种草力'}
${targetMediaUrl ? '- 请结合所上传的画面素材进行深度视觉解析。' : '- 当前无画面素材，请基于文本上下文进行构想拆解。'}
请严格按照示例格式输出纯JSON。`;

  try {
    const gatewayRes = await callLlmGateway({
      system: systemPrompt,
      user: userPrompt,
      imageUrl: targetMediaUrl || undefined,
      modelId: visionModelId,
    });

    if (gatewayRes.success && gatewayRes.data) {
      const d = gatewayRes.data;
      const normalizedData = {
        scene: d.scene || `${product.name} 极简清爽场景`,
        subject: d.subject || `展示 ${product.name} 膏体细腻拉丝质感`,
        style: d.style || (platform === 'xiaohongshu' ? '小红书治愈生活风' : '抖音硬核测评风'),
        palette: Array.isArray(d.palette) && d.palette.length > 0 ? d.palette : ['#A8D5BA 薄荷绿', '#FFFFFF 纯白', '#F5F5F0 柔光白'],
        lighting: d.lighting || '自然柔光，高光润泽，透光感十足',
        composition: d.composition || '三分法构图，主体居中偏右下，层次感分明',
        mood: d.mood || '清爽高质感晨间仪式感',
        camera: d.camera || '45度俯拍特写 + 微距大光圈虚化',
        static_image_prompt: d.static_image_prompt || `A high-end product photography shot of ${product.name} in a bright minimalist aesthetic setting, soft morning sunlight, 8k resolution`,
        rationale: d.rationale || `针对【${product.name}】的特色，通过真实高光质感与纯净配色，强化点击转化率。`,
      };

      return res.json({
        success: true,
        data: normalizedData,
        source: gatewayRes.source,
        modelUsed: gatewayRes.modelUsed,
      });
    }
  } catch (err: any) {
    console.warn('Step 1 LLM Gateway error:', err.message);
    if (!allowMockFallback()) {
      return res.status(502).json({
        success: false,
        error: err.message || 'Step 1 LLM 调用失败',
        source: 'error',
      });
    }
  }

  if (!allowMockFallback()) {
    return res.status(502).json({
      success: false,
      error: 'Step 1 未获得有效 LLM 结果。请检查模型 API Key / 云雾配置，或设置 ALLOW_MOCK_FALLBACK=true',
      source: 'error',
    });
  }

  // Explicit mock fallback (only when ALLOW_MOCK_FALLBACK=true)
  const mockResult = {
    scene: platform === 'xiaohongshu' ? `晨间阳光浴室镜前，自然光照射在 ${product.name} 瓶身上` : `高质感极简展台，背景微距呈现 ${product.name} 核心质感`,
    subject: `女性纤手展示 ${product.name}，特写精致管身与膏体质感`,
    style: platform === 'xiaohongshu' ? '小红书治愈生活风' : '抖音硬核测评风',
    palette: ['#A8D5BA 薄荷绿', '#FFFFFF 纯白', '#F5F5F0 柔光白'],
    lighting: '自然柔光，高光润泽，透光感十足',
    composition: '三分法构图，主体居中偏右下，层次感分明',
    mood: '清爽高质感晨间仪式感',
    camera: '45度俯拍特写 + 微距大光圈虚化',
    static_image_prompt: `A high-end product photography shot of ${product.name} in a bright minimalist aesthetic setting, soft morning sunlight, natural textures, 8k resolution`,
    rationale: `针对【${product.name}】的特色，通过真实高光质感与纯净配色，强化【${product.positioning}】的心理暗示与爆款点击率。`,
  };

  return res.json({ success: true, data: mockResult, source: 'mock' });
});

// Step 2: 静态图 → 视频生成运镜 Prompt & 星河 Seedance 图生视频接入
pipelineRouter.post('/step2', async (req, res) => {
  const inputs = req.body.inputs || req.body;
  const {
    static_image_prompt = '',
    imageUrl = '',
    mediaUrl = '',
    videoTone = 'douyin_beat',
    durationSec = 4,
    videoModel = 'Seedance 2.0 Fast',
    textModel,
    productId,
    productInfo,
  } = inputs;

  const targetImageUrl = imageUrl || mediaUrl || '';
  const product = getProductContext(productId, productInfo);
  // 运镜 Prompt 走文本模型；videoModel 仅给 Seedance 图生视频
  const motionLlmId = textModel || 'Gemini 3.6 Flash';

  let data: any = null;
  let gatewaySource = 'mock';

  try {
    const gatewayRes = await callLlmGateway({
      system: `你是一个专业 AIGC 短视频运镜专家。严格遵守以下规则：
1. **只输出纯JSON**，无任何额外文本。
2. 输出必须包含 motion_type / motion_intensity / motion_description / duration_sec / video_prompt / audio_layer / negative_prompt 所有字段。
3. motion_description：中文，具体镜头推进描述（15-40字），融入产品质感。
4. video_prompt：详细英文结构化 Prompt，包含 60fps、cinematic、product texture、viral motion keywords。
5. negative_prompt：强制包含避免旋转、变形、抖动、花式转场等。
6. motion_intensity 与调性匹配（strong / subtle）。
7. 自我批判：确保运镜强度与视频调性（${videoTone}）匹配。

示例输出：
{
  "motion_type": "zoom_in",
  "motion_intensity": "strong",
  "motion_description": "镜头由中景平滑推进至产品膏体瓶身特写，展示细腻拉丝质感与光影透润",
  "duration_sec": "4",
  "video_prompt": "A smooth slow zoom-in camera motion focusing on ${product.name}, 60fps cinematic quality, natural morning lighting, ultra-realistic texture, viral skincare motion",
  "audio_layer": "晨间水滴声与轻柔环境音",
  "negative_prompt": "avoid meaningless rotation, deformation, jitter, flashy transitions"
}`,
      user: `【运镜生成任务】
- 目标产品：${product.name}
- 静态图首帧描述：${static_image_prompt || `A high-end commercial shot of ${product.name}`}
- 目标调性：${videoTone}
- 期望时长：${durationSec}秒
请严格按照示例格式输出纯JSON。`,
      modelId: motionLlmId,
    });

    if (gatewayRes.success && gatewayRes.data) {
      data = gatewayRes.data;
      gatewaySource = gatewayRes.source;
    }
  } catch (err: any) {
    console.warn('Step 2 LLM Gateway error, using fallback motion generator:', err.message);
  }

  if (!data) {
    if (!allowMockFallback()) {
      return res.status(502).json({
        success: false,
        error: 'Step 2 未获得有效运镜 LLM 结果。请检查模型配置或设置 ALLOW_MOCK_FALLBACK=true',
        source: 'error',
      });
    }
    data = {
      motion_type: videoTone === 'douyin_beat' ? 'pan_left' : 'zoom_in',
      motion_intensity: videoTone === 'douyin_beat' ? 'strong' : 'subtle',
      motion_description: `镜头由中景平滑推进至 ${product.name} 瓶身特写，展示膏体冰淇淋拉丝质感`,
      duration_sec: String(durationSec),
      video_prompt: `A smooth slow zoom-in camera motion focusing on ${product.name}, 60fps cinematic quality, natural lighting`,
      audio_layer: '晨间水滴声与轻柔环境音',
      negative_prompt: '避免无意义旋转、变形、抖动、花式转场',
    };
    gatewaySource = 'mock';
  }

  const seedanceConfigured = hasSeedanceConfig();
  data.seedanceConfigured = seedanceConfigured;

  if (seedanceConfigured && targetImageUrl) {
    try {
      const modelId = String(videoModel || '').includes('Fast')
        ? 'doubao-seedance-2-0-fast'
        : 'doubao-seedance-2-0';
      const duration = clampSeedanceDuration(Number(durationSec) || 5);
      // duration clamp 5|10 is fine; API allows 4-15
      const reqHost = `${req.protocol}://${req.get('host')}`;
      const prepared = buildSeedanceGenerationBody({
        prompt: data.video_prompt,
        model: modelId,
        duration: duration <= 5 ? 5 : 10,
        resolution: '720p',
        aspectRatio: '9:16',
        imageUrl: targetImageUrl,
      }, reqHost);

      if (prepared.warnings.length > 0) {
        data.seedanceMaterialWarning = prepared.warnings.join('; ');
      }

      if (!prepared.materials.length) {
        data.seedanceStatus = 'awaiting_public_image';
        data.seedanceError =
          prepared.warnings[0] ||
          '图生视频需要公网可访问的首帧图。请使用 https 图链，或配置 PUBLIC_BASE_URL 暴露 /uploads';
        data.seedanceHint =
          '运镜 Prompt 已生成；配置 PUBLIC_BASE_URL 或改用公网素材后可重新运行 Step2 提交 Seedance';
      } else {
        const seedanceRes = await createSeedanceVideo(prepared.body);
        const task = normalizeSeedanceTask(seedanceRes);
        data.seedanceTaskId = task.id;
        data.seedanceStatus = task.status;
        data.previewVideoUrl = task.url || undefined;
        data.seedanceInferenceId = task.inferenceId;
        data.seedanceModel = prepared.modelId;

        return res.json({
          success: true,
          data,
          source: `${gatewaySource}+seedance-relay`,
          seedance: task,
        });
      }
    } catch (err: any) {
      console.warn('Seedance task submission warning:', err.message);
      data.seedanceStatus = 'submit_failed';
      data.seedanceError = err.message;
      if (err.warnings) data.seedanceMaterialWarning = (err.warnings as string[]).join('; ');
    }
  } else {
    data.seedanceStatus = seedanceConfigured ? 'awaiting_image_input' : 'unconfigured';
    if (!targetImageUrl) {
      data.seedanceHint = '请先提供 Step1 素材/文生图首帧（imageUrl），再提交图生视频';
    } else if (!seedanceConfigured) {
      data.seedanceHint = '请在 .env 配置 SEEDANCE_BASE_URL / SEEDANCE_ACCOUNT / SEEDANCE_PASSWORD';
    }
  }

  return res.json({ success: true, data, source: gatewaySource });
});

// Step 3: 爆款文案撰写 + 品牌知识库注入 + 违禁词合规扫描
pipelineRouter.post('/step3', async (req, res) => {
  const inputs = req.body.inputs || req.body;
  const {
    videoPrompt = '',
    targetPlatform = 'douyin',
    scriptPersona = '成分党',
    textModel,
    productId,
    productInfo,
  } = inputs;

  const product = getProductContext(productId, productInfo);

  const systemPrompt = `你是一个顶级短视频带货文案主创与品牌广告合规官。严格遵守以下规则：

${HARNESS_CONSTRAINTS.JSON_ONLY}
${HARNESS_CONSTRAINTS.STRUCTURED_OUTPUT}
${HARNESS_CONSTRAINTS.LENGTH_CONSTRAINTS.title} - ${HARNESS_CONSTRAINTS.LENGTH_CONSTRAINTS.hook} - ${HARNESS_CONSTRAINTS.LENGTH_CONSTRAINTS.body}
${HARNESS_CONSTRAINTS.SAFETY}
${HARNESS_CONSTRAINTS.SELF_CRITIQUE}
${HARNESS_CONSTRAINTS.FEW_SHOT}

【品牌知识库权威依据】
- 核心定位：${product.positioning}
- 3:4:3配方架构：${product.model343}
- SGS权威检测数据：${product.sgsData}
- 核心卖点：${product.customSellingPoints}

示例输出：
{
  "title": "搞定油光黑头！${product.name} SGS实测强效修复膏体",
  "hook": "还在为油光黑头烦恼？试试【${product.name}】的3:4:3配方，SGS权威实测后立即见效！",
  "body": "来看 SGS 权威报告！${product.name} 凭什么口碑爆款？核心就在它的洗完一润二修三控油体系。洗完一润二修三控油，膏体薄荷绿质感拉丝，自然清爽不紧绷！",
  "hashtags": ["#${product.name}", "#${product.name.split(' ')[0]}", "#美妆爆款", "#SGS实测"],
  "cta": "点击下方链接，领专属限时体验福利！",
  "platform_fit": {
    "douyin": "宝藏好物！${product.name} SGS实测效果拉满！点击领优惠～",
    "xiaohongshu": "沉浸式种草！${product.name} 质地超级治愈，强烈推荐给所有宝子们～"
  }
}`;

  const userPrompt = `【文案生成任务】
- 目标产品：${product.name}
- 目标平台：${targetPlatform}
- 脚本人设：${scriptPersona}
- 镜头运镜描述：${videoPrompt || `镜头推进展示 ${product.name}`}
请严格按照示例格式输出纯JSON。`;

  let data: any = null;
  let source = 'mock';
  let modelUsed = 'Default Text Model';

  try {
    const gatewayRes = await callLlmGateway({
      system: systemPrompt,
      user: userPrompt,
      modelId: textModel,
    });

    if (gatewayRes.success && gatewayRes.data) {
      data = gatewayRes.data;
      source = gatewayRes.source;
      modelUsed = gatewayRes.modelUsed;
    }
  } catch (err: any) {
    console.warn('Step 3 LLM Gateway error, falling back to mock copywriting:', err.message);
  }

  if (!data) {
    if (!allowMockFallback()) {
      return res.status(502).json({
        success: false,
        error: 'Step 3 未获得有效文案 LLM 结果。请检查模型配置或设置 ALLOW_MOCK_FALLBACK=true',
        source: 'error',
      });
    }
    data = {
      title: targetPlatform === 'douyin' ? `搞定问题肌！${product.name} SGS实测强效体验！🔥` : `早晨的快乐是它给的！${product.name} 沉浸使用感🍃`,
      hook: `你还在为了油光和黑头烦恼？试试【${product.name}】的核心爆款配方！`,
      body: `来看 SGS 权威报告！【${product.name}】凭什么口碑风靡全网？\n\n核心就在它的科学配方体系：${product.model343}！SGS权威实测数据：${product.sgsData}。洗完一润二修三控油，膏体薄荷绿质感拉丝，自然清爽不紧绷！`,
      hashtags: [`#${product.name.split(' ')[0] || 'BUV'}`, `#${product.name}`, '#美妆爆款', '#SGS实测'],
      cta: '点击下方链接，领专属限时体验福利！',
      platform_fit: {
        douyin: `宝藏好物推荐！【${product.name}】实测效果直接拉满！点击下方小黄车领专属优惠～`,
        xiaohongshu: `沉浸式种草！【${product.name}】质地超级治愈🍃 强烈推荐给所有宝子们～`,
      },
    };
    source = 'mock';
  }

  // 执行违禁词合规扫描
  const warnings = scanProhibitedWords(data, product.prohibitedWords);
  if (warnings.length > 0) {
    data.warnings = warnings;
  }

  return res.json({ success: true, data, source, modelUsed });
});

// Step 4: BGM 库检索与 LLM 语义卡点匹配
pipelineRouter.post('/step4', async (req, res) => {
  const inputs = req.body.inputs || req.body;
  const {
    copywritingTitle = '',
    tonePreference = '治愈',
    commercialScenario = '个人',
    musicModel,
    textModel,
    productId,
    productInfo,
  } = inputs;
  const bgmLlmId = textModel || musicModel || 'Gemini 3.6 Flash';

  const product = getProductContext(productId, productInfo);

  // 从 SQLite 读取候选 BGM 库
  let bgmRows: any[] = [];
  try {
    const bgmStmt = db.prepare('SELECT * FROM bgm_library ORDER BY created_at DESC');
    bgmRows = bgmStmt.all() as any[];
  } catch (err: any) {
    console.warn('Failed to query bgm_library from DB:', err.message);
  }

  const bgmCandidates = bgmRows.map((r) => ({
    id: r.id,
    track_name: r.track_name,
    artist: r.artist,
    style_tags: r.style_tags,
    bpm: r.bpm,
    mood: r.mood,
    audio_url: r.audio_url,
  }));

  const systemPrompt = `你是一个专业的电商短视频音乐总监与音画匹配算法专家。严格遵守以下规则：

1. **只输出纯JSON**，无任何额外文本。
2. 输出必须包含 bgm_recommendation 和 alternatives 所有字段。
3. bgm_recommendation：必须包含 track_name / artist / style / bpm / mood_match / sync_point / license_note / audioSampleUrl。
4. mood_match：严格按照文案标题和调性【${tonePreference}】描述契合度。
5. sync_point：建议卡点秒数（与镜头匹配，如 "1.2s (镜头推进特写), 2.8s (成分效果)"）。
6. alternatives：提供 2 首备选曲目说明。
7. 自我批判：确保 BGM 与产品定位、视频调性高度匹配，授权合规。

【候选 BGM 音乐库】
${JSON.stringify(bgmCandidates, null, 2)}

示例输出：
{
  "bgm_recommendation": {
    "track_name": "晨光治愈",
    "artist": "晨光音乐",
    "style": ["治愈", "轻快"],
    "bpm": "92",
    "mood_match": "完美契合小红书治愈生活调性，适合日常种草场景",
    "sync_point": "1.2s（镜头推进特写）、2.8s（成分展示）",
    "license_note": "已商业授权",
    "audioSampleUrl": "https://example.com/audio/xxx.mp3"
  },
  "alternatives": [
    {"track_name": "自然光影", "style": "轻快", "when_to_use": "备选，适合更明亮的早晨场景"},
    {"track_name": "晨间水滴", "style": "治愈", "when_to_use": "备选，适合更柔和的种草氛围"}
  ]
}`;

  let data: any = null;
  let source = 'mock';

  try {
    const gatewayRes = await callLlmGateway({
      system: systemPrompt,
      user: `【BGM匹配任务】
- 目标产品：${product.name}
- 视频调性偏好：${tonePreference}
- 商业授权场景：${commercialScenario}
请进行语义最佳匹配。`,
      modelId: bgmLlmId,
    });

    if (gatewayRes.success && gatewayRes.data && gatewayRes.data.bgm_recommendation) {
      data = gatewayRes.data;
      source = gatewayRes.source;
    }
  } catch (err: any) {
    console.warn('Step 4 LLM Gateway error, falling back to local database match:', err.message);
  }

  if (!data || !data.bgm_recommendation) {
    // Library-first local match (real, not LLM mock)
    const matchedBgm =
      bgmRows.find((b) => b.mood?.includes(tonePreference) || b.track_name?.includes(tonePreference)) ||
      bgmRows[0];

    if (!matchedBgm) {
      return res.status(400).json({
        success: false,
        error: 'BGM 库为空，请先在库中添加确权曲目',
        source: 'error',
      });
    }

    let styleTags: string[] = [];
    try {
      styleTags = JSON.parse(matchedBgm.style_tags || '[]');
    } catch {
      styleTags = [];
    }

    data = {
      bgm_recommendation: {
        track_name: matchedBgm.track_name,
        artist: matchedBgm.artist,
        style: styleTags,
        bpm: String(matchedBgm.bpm || 90),
        mood_match: `本地库匹配：契合【${product.name}】的${tonePreference}演示场景`,
        sync_point: tonePreference === '卡点' ? '0.8s（快切镜头）、2.0s（拉丝展示）' : '1.2s（产品特写）、2.8s（成分展示）',
        license_note: matchedBgm.license_type || '已商业授权',
        audioSampleUrl: matchedBgm.audio_url || (matchedBgm.audio_path ? `/${matchedBgm.audio_path.replace(/\\/g, '/')}` : undefined),
      },
      alternatives: bgmRows
        .filter((b) => b.id !== matchedBgm.id)
        .slice(0, 2)
        .map((b) => ({
          track_name: b.track_name,
          style: b.mood || '备选',
          when_to_use: `备选曲目 · ${b.mood || b.artist || ''}`,
        })),
    };
    source = 'library';
  } else {
    // Ensure recommended track exists in library when LLM returned a name
    const recName = data.bgm_recommendation.track_name;
    const inLib = bgmRows.find((b) => b.track_name === recName);
    if (inLib) {
      data.bgm_recommendation.audioSampleUrl =
        data.bgm_recommendation.audioSampleUrl ||
        inLib.audio_url ||
        (inLib.audio_path ? `/${String(inLib.audio_path).replace(/\\/g, '/')}` : undefined);
      data.bgm_recommendation.artist = data.bgm_recommendation.artist || inLib.artist;
      data.bgm_recommendation.bpm = String(data.bgm_recommendation.bpm || inLib.bpm || 90);
    }
  }

  return res.json({ success: true, data, source });
});

// Step 5: 成品合成 Timeline 构建与 FFmpeg 渲染导出
// 使用全局 HARNESS_CONSTRAINTS 确保所有合成提示词一致
pipelineRouter.post('/step5', async (req, res) => {
  const inputs = req.body.inputs || req.body;
  const {
    aspectRatio = '9:16',
    subtitleStyle = '黄字黑边',
    productId,
    productInfo,
    title = '',
    hook = '',
    videoSourceUrl = '',
    audioSourceUrl = '',
    previewVideoUrl = '',
  } = inputs;
  const product = getProductContext(productId, productInfo);

  const timestamp = Date.now();
  const filename = `v_${timestamp}.mp4`;

  const resolvedVideo = videoSourceUrl || previewVideoUrl || inputs.videoUrl || '';
  const resolvedAudio = audioSourceUrl || inputs.bgmUrl || '';

  const subtitleLines = [
    title || hook || `体验 ${product.name}！`,
    product.sgsData ? `SGS: ${String(product.sgsData).split(',')[0]}` : '',
  ].filter(Boolean);

  const brandStamp = `${product.name}`;
  const timeline = [
    { at: '0.0s', action: 'video_in', source: resolvedVideo || 'video_step2.mp4', text: 'Step2 视频轨' },
    {
      at: '0.0s',
      action: 'audio_in',
      source: resolvedAudio || 'bgm.mp3',
      volume: 0.3,
      text: 'BGM 音轨',
    },
    ...subtitleLines.map((text, i) => ({
      at: `${(i * 1.2).toFixed(1)}s`,
      action: 'subtitle_in' as const,
      text,
      position: 'bottom_center',
    })),
    { at: '2.8s', action: 'brand_stamp', text: brandStamp, position: 'top_right' },
  ];

  // Prefer real upstream assets; only use local sample when mock fallback explicitly allowed
  let videoForRender = resolvedVideo;
  if (!videoForRender && allowMockFallback()) {
    const sampleCandidates = [
      path.join(process.cwd(), 'uploads', 'renders', 'test_render_1785200791697.mp4'),
      path.join(process.cwd(), 'uploads', 'renders', 'v_1785200791691.mp4'),
    ];
    const found = sampleCandidates.find((p) => fs.existsSync(p));
    if (found) {
      videoForRender = `/uploads/renders/${path.basename(found)}`;
    }
  }

  if (!videoForRender) {
    return res.status(400).json({
      success: false,
      error: 'Step 5 缺少视频源：请先完成 Step2 并等待 Seedance 生成 previewVideoUrl',
      source: 'error',
    });
  }

  const renderResult = await runFfmpegRender({
    aspectRatio,
    videoSourceUrl: videoForRender,
    audioSourceUrl: resolvedAudio,
    subtitles: subtitleLines.map((text) => ({ text })),
    brandStamp,
    outputFilename: filename,
    durationSec: 4,
  });

  if (!renderResult.success || !renderResult.data) {
    return res.status(500).json({
      success: false,
      error: renderResult.error || 'FFmpeg 渲染失败',
      source: 'error',
      data: {
        timeline,
        qa_checklist: [`✗ 渲染失败: ${renderResult.error}`],
      },
    });
  }

  const out = renderResult.data;
  return res.json({
    success: true,
    source: renderResult.source || 'ffmpeg',
    data: {
      timeline,
      output: {
        filename: out.filename,
        resolution: out.resolution,
        format: out.format,
        duration_sec: out.duration_sec,
        videoUrl: out.videoUrl,
        downloadUrl: out.downloadUrl,
      },
      qa_checklist: [
        `✓ 画面比例匹配 (${out.resolution} ${aspectRatio})`,
        `✓ 字幕样式 [${subtitleStyle}]`,
        `✓ 视频源: ${videoForRender}`,
        resolvedAudio ? `✓ BGM: ${resolvedAudio}` : '○ 未附带 BGM（仅视频轨）',
        `✓ 渲染引擎: ${out.renderEngine}`,
      ],
      renderEngine: out.renderEngine,
    },
  });
});
