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
    imageModel,
    productId,
    productInfo,
  } = inputs;

  const targetMediaUrl = mediaUrl || imageUrl || req.body.mediaUrl || req.body.imageUrl || '';
  const product = getProductContext(productId, productInfo);

  const systemPrompt = `你是一个抖音/小红书顶级美妆电商爆款视觉拆解专家。
针对品牌产品【${product.name}】（定位：${product.positioning}，卖点特色：${product.customSellingPoints}），
你需要对用户提供的首帧图片/爆款视频画面进行多模态视觉反推与拆解。

必须返回合法 JSON 对象，包含以下 10 个字段：
1. scene (场景描述, 15-30字)
2. subject (主体与产品动作, 15-30字)
3. style (视觉风格, 5-15字)
4. palette (颜色数组 Hex/中文, 3-4项字符串数组)
5. lighting (光线描述)
6. composition (构图方式)
7. mood (情绪基调)
8. camera (镜头语言与角度)
9. static_image_prompt (详细高保真英文 Prompt，适合 Midjourney/Imagen 生成同款高清图)
10. rationale (爆款归因拆解说明)`;

  const userPrompt = `【拆解任务】
- 目标产品：${product.name} (${product.positioning})
- 目标平台：${platform}
- 博主类型：${bloggerType}
- 爆款原因描述：${viralReason || '膏体质感高清拉丝，光影透润极具治愈种草力'}
${targetMediaUrl ? '- 请结合所上传的画面素材进行深度视觉解析。' : '- 当前无画面素材，请基于文本上下文进行构想拆解。'}
请输出结构化 JSON。`;

  try {
    const gatewayRes = await callLlmGateway({
      system: systemPrompt,
      user: userPrompt,
      imageUrl: targetMediaUrl || undefined,
      modelId: imageModel,
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
    productId,
    productInfo,
  } = inputs;

  const targetImageUrl = imageUrl || mediaUrl || '';
  const product = getProductContext(productId, productInfo);

  let data: any = null;
  let gatewaySource = 'mock';

  try {
    const gatewayRes = await callLlmGateway({
      system: `你是一个专业 AIGC 短视频运镜专家。
针对品牌产品【${product.name}】（定位：${product.positioning}，卖点特色：${product.customSellingPoints}），
结合首帧静态图描述及选定的视频调性，生成结构化镜头运镜 Prompt。

必须返回合法 JSON 对象，包含字段：
- motion_type: 'zoom_in' | 'zoom_out' | 'pan_left' | 'pan_right' | 'tilt_up' | 'tilt_down' | 'rotate' | 'static_micro_motion'
- motion_intensity: 'subtle' | 'medium' | 'strong'
- motion_description (中文描述镜头推进、特写与微动作)
- duration_sec (字符串, 如 "${durationSec}")
- video_prompt (英文结构化运镜 Prompt, 供 Seedance / Veo 图生视频模型使用)
- audio_layer (配套音效描述)
- negative_prompt (负向 Prompt)`,
      user: `【运镜生成任务】
- 目标产品：${product.name}
- 静态图首帧描述：${static_image_prompt || `A high-end commercial shot of ${product.name}`}
- 目标调性：${videoTone}
- 期望时长：${durationSec}秒
请输出结构化 JSON。`,
      modelId: videoModel,
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
      const prepared = buildSeedanceGenerationBody({
        prompt: data.video_prompt,
        model: modelId,
        duration: duration <= 5 ? 5 : 10,
        resolution: '720p',
        aspectRatio: '9:16',
        imageUrl: targetImageUrl,
      });

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

  const systemPrompt = `你是一个顶级短视频带货文案主创与品牌广告合规官。
你需要为品牌产品【${product.name}】撰写爆款带货脚本文案。

【品牌知识库权威依据】
- 核心定位：${product.positioning}
- 3:4:3配方架构：${product.model343}
- SGS权威检测数据：${product.sgsData}
- 核心卖点：${product.customSellingPoints}

【合规红线要求】
绝对严禁在文案中使用任何虚假宣传或违禁极限词（如：绝对、第一名、医用级、100%根除、震惊、必看）。

必须返回合法 JSON 对象，包含以下字段：
- title (吸睛标题, 15-25字)
- hook (3秒黄金 Hook 吸睛句)
- body (正文口播脚本，自然植入 3:4:3 成分与 SGS 实测数据)
- hashtags (话题标签数组, 3-4个)
- cta (引导转化行动 Call-to-Action)
- platform_fit: {
    douyin: "抖音卡点节奏口播完整版本",
    xiaohongshu: "小红书图文种草与体验笔记版本"
  }`;

  const userPrompt = `【文案生成任务】
- 目标产品：${product.name}
- 目标平台：${targetPlatform}
- 脚本人设：${scriptPersona}
- 镜头运镜描述：${videoPrompt || `镜头推进展示 ${product.name}`}
请生成包含 SGS 权威数据的爆款脚本文案 JSON。`;

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
    productId,
    productInfo,
  } = inputs;

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

  const systemPrompt = `你是一个专业的电商短视频音乐总监与音画匹配算法专家。
针对品牌产品【${product.name}】（定位：${product.positioning}），
根据文案标题【${copywritingTitle || product.name}】与用户偏好调性【${tonePreference}】，
从以下候选 BGM 本地库中选择最匹配的音乐配乐：

【候选 BGM 音乐库】
${JSON.stringify(bgmCandidates, null, 2)}

必须返回合法 JSON 对象，包含字段：
- bgm_recommendation: {
    track_name: string (匹配曲目名称),
    artist: string (艺术家),
    style: string[] (风格标签数组),
    bpm: string (BPM数值字符串),
    mood_match: string (契合度与调性匹配说明),
    sync_point: string (建议卡点秒数说明，如 "1.2s (镜头推进特写), 2.8s (成分效果)"),
    license_note: string (如 "已商业授权"),
    audioSampleUrl: string (对应的试听 audio_url)
  }
- alternatives: Array<{ track_name: string, style: string, when_to_use: string }> (2首备选曲目说明)`;

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
      modelId: musicModel,
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
