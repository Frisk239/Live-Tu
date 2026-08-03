import { Router } from 'express';
import { db } from '../lib/db';
import { callLlmGateway, callImageGenerationGateway } from '../lib/llm-gateway';
import {
  Step1OutputSchema,
  Step2OutputSchema,
  Step3OutputSchema,
  Step4OutputSchema,
  VideoDeconstructionOutputSchema,
  validateStepOutput,
  Step1Output,
  Step2Output,
  Step3Output,
  Step4Output,
  VideoDeconstructionOutput,
} from '../lib/schema-validators';
import {
  preprocessVideo,
  getVideoPreprocessCache,
  saveVideoPreprocessResult,
} from '../lib/video-preprocessor';
import {
  createSeedanceVideo,
  getSeedanceVideo,
  normalizeSeedanceTask,
  hasSeedanceConfig,
  buildSeedanceGenerationBody,
} from './seedance';
import { cacheRemoteMedia, runFfmpegRender } from './render';
import { cacheRemoteVideoToUploads } from './seedance';
import { qaShotVideo } from '../lib/shot-qa';
import { buildShotMigrationPlan, type ProductAssetRef } from '../lib/migration-plan';
import { resolveRunProductAssets } from '../lib/product-assets';
import { evaluatePublishGate } from '../lib/publish-gate';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { canUseMediaReference } from '../lib/media-ownership';
import { registerSeedanceTaskOwner } from '../lib/seedance-ownership';

export const pipelineRouter = Router();

function canAccessLocalPipelineMedia(req: any, mediaUrl: string, ownerId?: string): boolean {
  if (!mediaUrl.startsWith('/uploads/') && !mediaUrl.startsWith('uploads/')) return true;
  const normalized = mediaUrl.startsWith('/') ? mediaUrl : `/${mediaUrl}`;
  const effectiveOwnerId = req.authUser?.id || ownerId;
  if (!effectiveOwnerId && !req.authUser?.role) return false;
  const ownerClause = req.authUser?.role === 'admin' ? '' : 'AND materials.owner_id = ?';
  const params = req.authUser?.role === 'admin'
    ? [normalized, normalized]
    : [normalized, normalized, effectiveOwnerId];
  const material = db.prepare(
    `SELECT materials.id
       FROM materials
      WHERE (materials.url = ? OR '/' || REPLACE(materials.file_path, '\\', '/') = ?)
        ${ownerClause}
      LIMIT 1`
  ).get(...params);
  if (material) return true;
  const keyframeParams = req.authUser?.role === 'admin'
    ? [`%"${normalized}"%`]
    : [`%"${normalized}"%`, effectiveOwnerId];
  return Boolean(db.prepare(
    `SELECT materials.id
       FROM video_preprocess_cache
       JOIN materials ON materials.id = video_preprocess_cache.id
      WHERE video_preprocess_cache.keyframe_urls LIKE ?
        ${ownerClause}
      LIMIT 1`
  ).get(...keyframeParams));
}

/** 把 Seedance 中转的原始错误转成用户可行动的提示（504/下载失败/限流） */
function friendlySeedanceError(err: any): string {
  const msg = String(err?.message || err || '');
  if (/504|Gateway Time-out|timeout/i.test(msg)) {
    return '星河 Seedance 中转繁忙或超时（504），请稍后重试，或检查中转服务状态';
  }
  if (/Failed to download virtual asset URL/i.test(msg)) {
    return '星河中转无法下载首帧图：请改用公网可访问的图片地址（如仓库直链 raw.githubusercontent.com），本地/内网图片无法被中转拉取';
  }
  if (/429|Too Many Requests/i.test(msg)) {
    return 'Seedance 生成过于频繁（429），请稍等 1-2 分钟再试';
  }
  return String(msg).slice(0, 300);
}

// ==================== GLOBAL HARNESS CONSTRAINTS ====================
export const HARNESS_CONSTRAINTS = {
  JSON_ONLY: '必须只输出纯合法 JSON 对象，无任何 Markdown 标记、代码块、解释或额外文本。',
  STRUCTURED_OUTPUT: '输出必须严格包含所有指定 Schema 字段，字段值必须具体、视觉化、专业、高质量。',
  LENGTH_CONSTRAINTS: {
    title: '15-25字吸睛标题',
    hook: '3秒黄金 Hook（包含痛点引入、反差或认知颠覆）',
    scene: '15-30字场景描述',
    subject: '15-30字主体动作描述',
    static_image_prompt: '详细英文 Prompt，包含 8k, cinematic lighting, ultra-realistic product texture, commercial photography',
    video_prompt: '详细英文结构化运镜 Prompt，包含 60fps, natural smooth lighting, focus transition, product texture',
    body: '80-120字口播脚本，自然植入核心成分与SGS数据',
    hashtags: '3-4个真实话题标签',
    sync_point: '精准卡点秒数描述（如 "1.2s (镜头推进特写), 2.8s (成分效果)"）',
    negative_prompt: '强制包含避免旋转、变形、抖动、花式转场等',
  },
  SAFETY: '严禁虚假宣传与违禁词。绝对不可使用非法极限词（如：绝对、第一名、100%根除、震惊、必看、医用级）。',
  SELF_CRITIQUE: '生成前进行自我审查：检查格式合法性、产品契合度、语句流畅性及合规性。',
  FEW_SHOT: '请参考通用 Few-Shot 示例格式进行规范化输出。',
  PRODUCT_INJECT: '必须深度融合目标产品的特色定位、配方体系与SGS实测数据。',
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
    id: 'prod_default',
    name: bodyProductInfo?.name || '默认产品',
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
  if (data.platform_fit) {
    checkText(data.platform_fit.douyin, '抖音定制口播 (platform_fit.douyin)');
    checkText(data.platform_fit.xiaohongshu, '小红书定制文案 (platform_fit.xiaohongshu)');
  }

  return warnings;
}

function isVideoMedia(url: string): boolean {
  if (!url) return false;
  const lower = url.toLowerCase().split('?')[0];
  return (
    lower.endsWith('.mp4') ||
    lower.endsWith('.webm') ||
    lower.endsWith('.mov') ||
    lower.endsWith('.avi') ||
    lower.endsWith('.mkv') ||
    lower.includes('/video') ||
    lower.includes('video/')
  );
}

/**
 * 通用 Harness 自愈与结构校验 Loop
 */
async function executeWithSelfCorrection<T>(
  stepName: string,
  systemPrompt: string,
  userPrompt: string,
  imageUrl: string | undefined,
  modelId: string | undefined,
  schema: z.ZodSchema<T>,
  maxCorrectionAttempts = 2,
  imageUrls?: string[]
): Promise<{ success: boolean; data: T | null; source: string; modelUsed: string; error?: string }> {
  let currentSystem = systemPrompt;
  let currentUser = userPrompt;
  let lastSource = 'direct';
  let lastModelUsed = '';
  let lastError = '';

  for (let attempt = 0; attempt <= maxCorrectionAttempts; attempt++) {
    try {
      const res = await callLlmGateway({
        system: currentSystem,
        user: currentUser,
        imageUrl,
        imageUrls,
        modelId,
      });

      lastSource = res.source;
      lastModelUsed = res.modelUsed;

      if (res.success && res.data) {
        const validation = validateStepOutput(schema, res.data);
        if (validation.success) {
          return { success: true, data: validation.data, source: lastSource, modelUsed: lastModelUsed };
        }
        const errStr = 'error' in validation ? validation.error : 'Schema 校验未通过';
        console.warn(`[Harness ${stepName}] Zod 结构校验未通过 (尝试 ${attempt + 1}/${maxCorrectionAttempts + 1}): ${errStr}`);
        lastError = errStr;
        currentUser = `${userPrompt}\n\n【Harness 自动纠错反馈】上一次返回的 JSON 不完全符合结构规范：\n${errStr}\n请严格修正后只返回纯 JSON 对象。`;
      }
    } catch (err: any) {
      lastError = err.message || 'LLM 调用异常';
      console.warn(`[Harness ${stepName}] Gateway 请求异常 (尝试 ${attempt + 1}):`, lastError);
    }
  }

  return { success: false, data: null, source: lastSource, modelUsed: lastModelUsed, error: lastError };
}


// Ticket 11: 文生图 API / 质感静态图生成
pipelineRouter.post('/generate-image', async (req, res) => {
  const { prompt, productId, imageModel } = req.body;
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ success: false, error: 'prompt 参数必填且必须为字符串' });
  }

  const materialsDir = path.join(
    path.resolve(process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads')),
    'materials'
  );
  if (!fs.existsSync(materialsDir)) {
    fs.mkdirSync(materialsDir, { recursive: true });
  }

  try {
    const ownerId = req.authUser?.id || req.body?._ownerId || null;
    if (!ownerId) {
      return res.status(400).json({ success: false, error: '无法确定生成素材的所有者' });
    }
    const gatewayRes = await callImageGenerationGateway({
      prompt,
      modelId: imageModel,
    });

    let imageUrl = gatewayRes.imageUrl;
    let source = gatewayRes.source;

    if (!gatewayRes.success || !imageUrl) {
      return res.status(502).json({
        success: false,
        error: gatewayRes.error || '文生图失败：请检查画图模型 API Key / 云雾配置',
        source: gatewayRes.source || 'error',
      });
    } else if (imageUrl.startsWith('data:image/')) {
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
      try {
        const cachedPath = await cacheRemoteMedia(imageUrl, 'image', ownerId);
        imageUrl = `/uploads/renders/${path.basename(cachedPath)}`;
      } catch (error: any) {
        return res.status(error?.status || 502).json({
          success: false,
          error: `生成图片安全下载失败: ${error?.message || error}`,
          source,
        });
      }
    }

    const id = `mat_gen_${Date.now()}`;
    const name = `AI生成首帧_${Date.now().toString().slice(-4)}`;
    const filePath = imageUrl.startsWith('/uploads/')
      ? imageUrl.replace(/^\//, '')
      : imageUrl;
    try {
      const stmt = db.prepare(`
        INSERT INTO materials (
          id, name, file_path, url, media_type, size, duration, created_at, owner_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        id,
        name,
        filePath,
        imageUrl,
        'image',
        '0.3 MB',
        null,
        new Date().toISOString(),
        ownerId
      );
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
// Step 1: 多模态视觉拆解与静态图 Prompt 生成 / 视频结构化拆解
pipelineRouter.post('/step1', async (req, res) => {
  const inputs = req.body.inputs || req.body;
  const {
    mediaUrl = '',
    imageUrl = '',
    platform = 'douyin',
    bloggerType = 'daily_seeding',
    viralReason = '',
    textModel,
    productId,
    productInfo,
  } = inputs;

  const targetMediaUrl = mediaUrl || imageUrl || req.body.mediaUrl || req.body.imageUrl || '';
  if (!canAccessLocalPipelineMedia(req, targetMediaUrl, inputs._ownerId)) {
    return res.status(404).json({ success: false, error: '素材不存在或无权访问' });
  }
  const product = getProductContext(productId, productInfo);
  const visionModelId = textModel || 'Gemini 3.6 Flash';
  const isVideo = isVideoMedia(targetMediaUrl);

  if (isVideo) {
    // ------------------ 视频拆解分支 ------------------
    let keyframeUrls: string[] = [];
    try {
      let preprocessRes = await getVideoPreprocessCache(targetMediaUrl);
      if (!preprocessRes) {
        preprocessRes = await preprocessVideo(targetMediaUrl);
        await saveVideoPreprocessResult(targetMediaUrl, preprocessRes);
      }
      keyframeUrls = preprocessRes.keyframeUrls || [];
    } catch (err: any) {
      console.warn('[Step1 Video Preprocess Warning]:', err.message);
    }

    const videoSystemPrompt = `你是一个顶级美妆短视频结构化拆解与镜头分析专家。你将接收到由爆款视频中抽取的顺序关键帧序列。
严格遵守以下 Harness 约束：

${HARNESS_CONSTRAINTS.JSON_ONLY}
${HARNESS_CONSTRAINTS.STRUCTURED_OUTPUT}
${HARNESS_CONSTRAINTS.SAFETY}
${HARNESS_CONSTRAINTS.SELF_CRITIQUE}

【目标产品品牌上下文】
- 产品名称：${product.name}
- 品牌定位：${product.positioning}
- 核心卖点特色：${product.customSellingPoints}

【输出 JSON 规范 (VideoDeconstructionOutput)】
你必须输出符合以下 Zod Schema 的纯 JSON 对象：
{
  "scene": "15-30字主场景总体描述",
  "subject": "15-30字主体动作描述",
  "style": "爆款视频视觉风格（如：小红书治愈生活风/抖音硬核卡点测评）",
  "palette": ["HEX颜色+描述"],
  "lighting": "光线质感与照射分布",
  "composition": "画面构图法则",
  "mood": "视频整体情绪与调性",
  "camera": "主镜头与运镜语言概括",
  "static_image_prompt": "高质感英文文生图 Prompt (8k, commercial photography, cinematic lighting)",
  "rationale": "视频拆解分析总结与爆款转化归因",
  "shotList": [
    {
      "shotIndex": 1,
      "startTime": "00:00",
      "endTime": "00:03",
      "shotType": "特写",
      "cameraMovement": "平滑推进",
      "description": "镜头细节与动作描述",
      "keyframeUrl": "对应的关键帧URL",
      "mood": "情绪标签"
    }
  ],
  "videoStructure": {
    "totalShots": 3,
    "avgShotDuration": "3.0s",
    "pacing": "fast",
    "narrativeArc": "痛点引入 -> 质感特写 -> 效果对比",
    "hookTiming": "前0-3秒黄金Hook"
  },
  "originalScript": {
    "hasVoiceover": true,
    "estimatedScript": "推测或提取的原视频口播文案脚本",
    "sellingPoints": ["核心卖点1", "核心卖点2"]
  },
  "audioAnalysis": {
    "hasBgm": true,
    "estimatedBpm": "115",
    "musicStyle": "轻快卡点 Ambient"
  },
  "narrativeBeats": [
    { "beat": "hook", "startSec": 0, "endSec": 3, "intent": "黄金3秒抓注意力" },
    { "beat": "demo", "startSec": 3, "endSec": 12, "intent": "产品质感演示" },
    { "beat": "cta", "startSec": 12, "endSec": 20, "intent": "转化引导" }
  ],
  "migrationHints": {
    "mustKeep": ["前3秒Hook节奏", "分镜叙事弧"],
    "mustReplace": ["竞品包装", "竞品品牌名", "非我方产品主体"],
    "productInsertRules": "所有成片首帧必须使用我方产品包装与质感"
  }
}`;

    const videoUserPrompt = `【视频拆解任务】
- 目标产品：${product.name} (${product.positioning})
- 目标平台：${platform}
- 博主类型：${bloggerType}
- 爆款原因：${viralReason || '多镜头节奏紧凑，画面质感通透，卡点精准种草'}
- 关键帧图片总数：${keyframeUrls.length} 张
请根据所提供的视频顺序关键帧序列，进行深度镜头拆解并输出纯 JSON。
注意：shotList[].keyframeUrl 仅作结构参考，最终成片首帧将使用我方产品图，不得把竞品包装当最终主体。`;

    const hRes = await executeWithSelfCorrection<VideoDeconstructionOutput>(
      'Step1-VideoDeconstruction',
      videoSystemPrompt,
      videoUserPrompt,
      undefined,
      visionModelId,
      VideoDeconstructionOutputSchema,
      2,
      keyframeUrls
    );

    if (hRes.success && hRes.data) {
      if (Array.isArray(hRes.data.shotList)) {
        hRes.data.shotList = hRes.data.shotList.map((shot, idx) => ({
          ...shot,
          keyframeUrl: shot.keyframeUrl || keyframeUrls[idx % keyframeUrls.length] || '',
        }));
      }
      // Attach migration plan when product assets are available
      const productAssets: ProductAssetRef[] = resolveRunProductAssets({
        productId,
        productAssetIds: inputs.productAssetIds || req.body.productAssetIds,
      });
      let migrationPlan: ReturnType<typeof buildShotMigrationPlan> | undefined;
      if (productAssets.length > 0) {
        try {
          migrationPlan = buildShotMigrationPlan(hRes.data, productAssets, {
            productName: product.name,
          });
        } catch (err: any) {
          console.warn('[Step1] migration plan build skipped:', err.message);
        }
      }
      return res.json({
        success: true,
        data: {
          ...hRes.data,
          migrationPlan,
          productHeroFrameUrl: migrationPlan?.productHeroUrl,
          firstFrameSource: migrationPlan ? 'product_conditioned' : undefined,
        },
        source: hRes.source,
        modelUsed: hRes.modelUsed,
      });
    }

    if (!hRes.success || !hRes.data) {
      return res.status(502).json({
        success: false,
        error: `Step 1 视频拆解失败: ${hRes.error || '未能生成合规 JSON'}。请检查模型 API Key 配置。`,
        source: 'error',
      });
    }
  }

  // ------------------ 单图拆解分支 (向下兼容) ------------------
  const systemPrompt = `你是一个顶级美妆电商爆款视觉拆解专家。严格遵守以下 Harness 约束：

${HARNESS_CONSTRAINTS.JSON_ONLY}
${HARNESS_CONSTRAINTS.STRUCTURED_OUTPUT}
${HARNESS_CONSTRAINTS.SAFETY}
${HARNESS_CONSTRAINTS.SELF_CRITIQUE}
${HARNESS_CONSTRAINTS.FEW_SHOT}

【目标产品品牌上下文】
- 产品名称：${product.name}
- 品牌定位：${product.positioning}
- 核心卖点特色：${product.customSellingPoints}

【通用 Few-Shot 输出示例】
{
  "scene": "晨间阳光浴室镜前，自然柔光照射在瓶身上，光影通透富有生活氛围感",
  "subject": "女性纤手展示产品膏体质感，镜头微距特写高清细致",
  "style": "小红书治愈生活风",
  "palette": ["#A8D5BA 薄荷绿", "#FFFFFF 纯白", "#F5F5F0 柔光白"],
  "lighting": "自然柔光，高光润泽，透光感十足",
  "composition": "三分法构图，主体居中偏右下，层次感分明",
  "mood": "清爽高质感晨间仪式感",
  "camera": "45度俯拍特写 + 微距大光圈虚化",
  "static_image_prompt": "A high-end product photography shot of [Product] in a bright minimalist aesthetic setting, soft morning sunlight, 8k resolution, ultra-realistic texture, perfect commercial lighting",
  "rationale": "通过真实高光质感与纯净配色，强化点击转化率"
}`;

  const userPrompt = `【视觉拆解任务】
- 目标产品：${product.name} (${product.positioning})
- 目标平台：${platform}
- 博主类型：${bloggerType}
- 爆款原因：${viralReason || '膏体质感高清拉丝，光影透润极具治愈种草力'}
${targetMediaUrl ? '- 请结合所上传的画面素材进行深度视觉解析。' : '- 当前无画面素材，请基于文本上下文进行构想拆解。'}
请严格按照规范输出纯 JSON 对象。`;

  const hRes = await executeWithSelfCorrection<Step1Output>(
    'Step1',
    systemPrompt,
    userPrompt,
    targetMediaUrl || undefined,
    visionModelId,
    Step1OutputSchema
  );

  if (hRes.success && hRes.data) {
    return res.json({
      success: true,
      data: hRes.data,
      source: hRes.source,
      modelUsed: hRes.modelUsed,
    });
  }

  return res.status(502).json({
    success: false,
    error: `Step 1 拆解失败: ${hRes.error || '未能生成合规 JSON'}。请检查模型 API Key 配置。`,
    source: 'error',
  });
});

// Step 2: 静态图 → 视频生成运镜 Prompt & 星河 Seedance 图生视频接入 / 多镜头分段生成
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
    shotList: inputShotList,
    pipelineData,
    productAssets: inputProductAssets,
    productAssetIds: inputProductAssetIds,
    migrationPlan: inputMigrationPlan,
    productFirstFrameUrl: inputProductFirstFrame,
    firstFrameSource: inputFirstFrameSource,
    viralMediaUrl,
  } = inputs;

  const productAssets: ProductAssetRef[] =
    (Array.isArray(inputProductAssets) && inputProductAssets.length > 0
      ? inputProductAssets
      : resolveRunProductAssets({
          productId,
          productAssetIds:
            inputProductAssetIds ||
            pipelineData?.productAssetIds ||
            inputs.productAssetIds,
        })) as ProductAssetRef[];

  let migrationPlan = inputMigrationPlan || pipelineData?.step1?.output?.migrationPlan;
  if (!migrationPlan && productAssets.length > 0) {
    try {
      const structure = pipelineData?.step1?.output || {
        shotList: inputShotList,
        static_image_prompt,
      };
      migrationPlan = buildShotMigrationPlan(structure, productAssets, {
        productName: getProductContext(productId, productInfo).name,
      });
    } catch (err: any) {
      console.warn('[Step2] migration plan:', err.message);
    }
  }

  const planShots = migrationPlan?.shots;
  const targetShotList =
    (Array.isArray(planShots) && planShots.length > 0 ? planShots : null) ||
    inputShotList ||
    pipelineData?.step1?.output?.shotList ||
    req.body.pipelineData?.step1?.output?.shotList;
  if (Array.isArray(targetShotList) && targetShotList.length > 12) {
    return res.status(400).json({
      success: false,
      error: '单次多镜头生成最多支持 12 个镜头',
    });
  }

  // Product-conditioned first frame — never fall back to viral media as final frame
  const productHeroUrl =
    inputProductFirstFrame ||
    migrationPlan?.productHeroUrl ||
    productAssets[0]?.url ||
    '';
  const viralUrl = viralMediaUrl || pipelineData?.step1?.inputs?.mediaUrl || '';
  const rawTarget = imageUrl || mediaUrl || '';
  // If client still passed viral URL as imageUrl, replace with product hero when available
  const looksLikeViral =
    viralUrl &&
    rawTarget &&
    (rawTarget === viralUrl ||
      (String(rawTarget).includes('/keyframes/') && productHeroUrl));
  const targetImageUrl = productHeroUrl || (!looksLikeViral ? rawTarget : '') || productHeroUrl;
  const firstFrameSource =
    inputFirstFrameSource ||
    (productHeroUrl || (targetImageUrl && productAssets.some((a) => a.url === targetImageUrl))
      ? 'product_conditioned'
      : targetImageUrl
        ? 'legacy_image'
        : undefined);

  if (targetImageUrl && !canAccessLocalPipelineMedia(req, targetImageUrl, inputs._ownerId)) {
    // product assets under /uploads/product-assets should be readable for owner
    const isProductAssetPath =
      targetImageUrl.startsWith('/uploads/product-assets/') ||
      targetImageUrl.startsWith('uploads/product-assets/');
    if (!isProductAssetPath) {
      return res.status(404).json({ success: false, error: '首帧素材不存在或无权访问' });
    }
  }
  const product = getProductContext(productId, productInfo);
  const motionLlmId = textModel || 'Gemini 3.6 Flash';

  // ------------------ 多镜头分段生成分支 ------------------
  if (Array.isArray(targetShotList) && targetShotList.length > 0) {
    const sessionId = `shot_sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const seedanceConfigured = hasSeedanceConfig();
    const modelId = String(videoModel || '').includes('Fast')
      ? 'doubao-seedance-2-0-fast'
      : 'doubao-seedance-2-0';
    const reqHost = `${req.protocol}://${req.get('host')}`;

    const shotTasks: Array<{
      id: string;
      shotIndex: number;
      shotType: string;
      cameraMovement: string;
      description: string;
      keyframeUrl: string;
      referenceKeyframeUrl?: string;
      firstFrameSource: string;
      video_prompt: string;
      seedanceTaskId?: string;
      status: 'pending' | 'generating' | 'completed' | 'failed';
      video_url?: string;
      error_message?: string;
    }> = [];

    for (let idx = 0; idx < targetShotList.length; idx++) {
      const shot = targetShotList[idx];
      const shotIndex = shot.shotIndex || (idx + 1);
      // Product-conditioned final first frame (never viral keyframe as Seedance input)
      const productFrameUrl =
        shot.productFirstFrameUrl ||
        productHeroUrl ||
        productAssets[idx % Math.max(1, productAssets.length)]?.url ||
        targetImageUrl ||
        '';
      const structureRefUrl = shot.referenceKeyframeUrl || shot.keyframeUrl || '';
      const kfUrl = productFrameUrl;

      const shotSystemPrompt = `你是一个专业 AIGC 短视频镜头运镜专家。根据特定的单个镜头信息生成结构化视频运镜指令 Prompt。
${HARNESS_CONSTRAINTS.JSON_ONLY}

【输出 JSON 格式】
{
  "video_prompt": "英文结构化 Seedance 运镜指令 (60fps, smooth motion, high detail, product focus)",
  "camera_description": "中文运镜简述"
}`;

      const shotUserPrompt = `【镜头 ${shotIndex} 运镜生成】
- 目标产品：${product.name}
- 镜头类型：${shot.shotType || shot.structureBrief || '特写'}
- 运镜方式：${shot.cameraMovement || '推进'}
- 镜头描述：${shot.description || shot.structureBrief || '产品特写'}
- 调性：${videoTone}
- 要求：画面主体必须是我方产品包装，禁止竞品包装
请输出纯 JSON。`;

      let videoPrompt =
        shot.motionPrompt ||
        `A smooth cinematic video shot for ${product.name}, ${shot.shotType || 'close-up'}, ${shot.cameraMovement || 'zoom in'}, 60fps, high detail, our product packaging only`;
      try {
        const shotRes = await callLlmGateway({
          system: shotSystemPrompt,
          user: shotUserPrompt,
          imageUrl: productFrameUrl || undefined,
          modelId: motionLlmId,
        });
        if (shotRes.success && shotRes.data && shotRes.data.video_prompt) {
          videoPrompt = shotRes.data.video_prompt;
        }
      } catch (err: any) {
        console.warn(`[Step2 MultiShot] LLM prompt gen for shot ${shotIndex} failed:`, err.message);
      }

      const taskId = `shot_task_${sessionId}_${shotIndex}`;
      let shotSeedanceTaskId: string | undefined = undefined;
      let shotStatus: 'pending' | 'generating' | 'completed' | 'failed' = 'pending';
      let shotVideoUrl: string | undefined = undefined;
      let shotErrorMsg: string | undefined = undefined;

      try {
        db.prepare(`
          INSERT INTO shot_generation_tasks (
            id, session_id, owner_id, shot_index, status, video_prompt, first_frame_url
          ) VALUES (?, ?, ?, ?, 'pending', ?, ?)
        `).run(taskId, sessionId, req.authUser?.id || null, shotIndex, videoPrompt, kfUrl);
      } catch (err: any) {
        console.error(`[Step2 MultiShot] Could not persist shot ${shotIndex}:`, err.message);
        return res.status(500).json({
          success: false,
          error: '多镜头任务无法持久化，未提交视频生成',
        });
      }

      if (seedanceConfigured && kfUrl) {
        try {
          const prepared = buildSeedanceGenerationBody({
            prompt: videoPrompt,
            model: modelId,
            duration: 5,
            resolution: '720p',
            aspectRatio: '9:16',
            imageUrl: kfUrl,
          }, reqHost);

          if (prepared.materials.length > 0) {
            const seedanceRes = await createSeedanceVideo(prepared.body);
            const task = normalizeSeedanceTask(seedanceRes);
            shotSeedanceTaskId = task.id;
            if (task.id) {
              const ownerId = req.authUser?.id || inputs._ownerId;
              if (!ownerId) throw new Error('Seedance task owner is required');
              registerSeedanceTaskOwner(String(task.id), ownerId, 'pipeline-multi-shot');
            }
            shotStatus = (task.status === 'success' || task.status === 'completed') ? 'completed' : 'generating';
            shotVideoUrl = task.url || undefined;
          } else {
            shotStatus = 'pending';
            shotErrorMsg = prepared.warnings[0] || '等待首帧图可访问';
          }
        } catch (err: any) {
          console.warn(`[Step2 MultiShot] Seedance submission for shot ${shotIndex} failed:`, err.message);
          shotStatus = 'failed';
          shotErrorMsg = friendlySeedanceError(err);
        }
      } else {
        shotStatus = 'failed';
        shotErrorMsg = '未配置 Seedance 中转（SEEDANCE_BASE_URL / ACCOUNT / PASSWORD），无法生成视频镜头';
      }

      try {
        db.prepare(`
          UPDATE shot_generation_tasks
             SET status = ?,
                 seedance_task_id = ?,
                 video_url = ?,
                 error_message = ?,
                 updated_at = CURRENT_TIMESTAMP
           WHERE id = ?
        `).run(
          shotStatus,
          shotSeedanceTaskId || null,
          shotVideoUrl || null,
          shotErrorMsg || null,
          taskId
        );
      } catch (err: any) {
        console.error(`[Step2 MultiShot] DB update failed:`, err.message);
        return res.status(500).json({
          success: false,
          error: '多镜头任务状态无法持久化，请稍后从任务中心恢复',
        });
      }

      shotTasks.push({
        id: taskId,
        shotIndex,
        shotType: shot.shotType || '特写',
        cameraMovement: shot.cameraMovement || '平滑推进',
        description: shot.description || shot.structureBrief || '',
        keyframeUrl: kfUrl,
        referenceKeyframeUrl: structureRefUrl || undefined,
        firstFrameSource: 'product_conditioned',
        video_prompt: videoPrompt,
        seedanceTaskId: shotSeedanceTaskId,
        status: shotStatus,
        video_url: shotVideoUrl,
        error_message: shotErrorMsg,
      });
    }

    const multiShotResult = {
      sessionId,
      totalShots: targetShotList.length,
      estimatedCompletionTimeSec: targetShotList.length * 15,
      shots: shotTasks,
      concatStatus: 'pending' as const,
      firstFrameSource: 'product_conditioned' as const,
      productHeroUrl: productHeroUrl || undefined,
    };

    return res.json({
      success: true,
      data: {
        motion_type: 'zoom_in',
        motion_intensity: 'medium',
        motion_description: `分段多镜头生成：包含 ${targetShotList.length} 个产品条件首帧镜头，禁止使用原爆款帧作为最终首帧`,
        duration_sec: String(targetShotList.length * 4),
        video_prompt: shotTasks[0]?.video_prompt || `Multi-shot video prompt for ${product.name}`,
        audio_layer: '多镜头卡点音轨与沉浸过渡音效',
        negative_prompt: '避免镜头卡顿、跳帧或剧烈形变、竞品包装',
        isMultiShot: true,
        multiShotResult,
        migrationPlan,
        firstFrameSource: 'product_conditioned',
        productFirstFrameUrl: productHeroUrl || shotTasks[0]?.keyframeUrl,
        seedanceConfigured,
      },
      source: seedanceConfigured ? 'multi_shot_seedance' : 'multi_shot_pending',
    });
  }

  // ------------------ 单图普通生成分支 (向下兼容) ------------------
  const systemPrompt = `你是一个专业 AIGC 短视频运镜专家。严格遵守以下 Harness 约束：

${HARNESS_CONSTRAINTS.JSON_ONLY}
${HARNESS_CONSTRAINTS.STRUCTURED_OUTPUT}
${HARNESS_CONSTRAINTS.LENGTH_CONSTRAINTS.video_prompt}
${HARNESS_CONSTRAINTS.LENGTH_CONSTRAINTS.negative_prompt}
${HARNESS_CONSTRAINTS.SAFETY}
${HARNESS_CONSTRAINTS.SELF_CRITIQUE}
${HARNESS_CONSTRAINTS.FEW_SHOT}

【通用 Few-Shot 输出示例】
{
  "motion_type": "zoom_in",
  "motion_intensity": "strong",
  "motion_description": "镜头由中景平滑推进至产品瓶身特写，展示细腻膏体质感与光影透润",
  "duration_sec": "4",
  "video_prompt": "A smooth slow zoom-in camera motion focusing on [Product], 60fps cinematic quality, natural morning lighting, ultra-realistic texture, viral skincare motion",
  "audio_layer": "晨间水滴声与轻柔环境音",
  "negative_prompt": "avoid meaningless rotation, deformation, jitter, flashy transitions, blur",
  "camera_description": "45度俯拍转前切推镜头"
}`;

  const userPrompt = `【运镜生成任务】
- 目标产品：${product.name}
- 静态图首帧描述：${static_image_prompt || `A high-end commercial shot of ${product.name}`}
- 目标调性：${videoTone}
- 期望时长：${durationSec}秒
请严格按照示例 Schema 输出纯 JSON 对象。`;

  const hRes = await executeWithSelfCorrection<Step2Output>(
    'Step2',
    systemPrompt,
    userPrompt,
    targetImageUrl || undefined,
    motionLlmId,
    Step2OutputSchema
  );

  let data: any = hRes.data;
  let gatewaySource = hRes.source;

  if (!data) {
    return res.status(502).json({
      success: false,
      error: `Step 2 运镜生成失败: ${hRes.error || '未生成有效运镜描述'}。请检查模型配置。`,
      source: 'error',
    });
  }

  const seedanceConfigured = hasSeedanceConfig();
  data.seedanceConfigured = seedanceConfigured;
  data.firstFrameSource = firstFrameSource || (productHeroUrl ? 'product_conditioned' : 'legacy_image');
  data.productFirstFrameUrl = productHeroUrl || targetImageUrl;
  if (migrationPlan) data.migrationPlan = migrationPlan;

  if (seedanceConfigured && targetImageUrl) {
    try {
      const modelId = String(videoModel || '').includes('Fast')
        ? 'doubao-seedance-2-0-fast'
        : 'doubao-seedance-2-0';
      const duration = clampSeedanceDuration(Number(durationSec) || 5);
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
        if (task.id) {
          const ownerId = req.authUser?.id || inputs._ownerId;
          if (!ownerId) throw new Error('Seedance task owner is required');
          registerSeedanceTaskOwner(String(task.id), ownerId, 'pipeline-step2');
        }
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
      data.seedanceError = friendlySeedanceError(err);
      if (err.warnings) data.seedanceMaterialWarning = (err.warnings as string[]).join('; ');
    }
  } else {
    data.seedanceStatus = seedanceConfigured ? 'awaiting_image_input' : 'unconfigured';
    if (!targetImageUrl) {
      data.seedanceHint =
        '缺少首帧图：请先在产品知识库上传产品图（爆款直出必填），或提供公网图片链接后重跑 Step2';
    } else if (!seedanceConfigured) {
      data.seedanceHint = '请在 .env 配置 SEEDANCE_BASE_URL / SEEDANCE_ACCOUNT / SEEDANCE_PASSWORD';
    }
  }

  return res.json({ success: true, data, source: gatewaySource });
});

// GET /api/pipeline/shot-tasks/:sessionId — 多镜头分段生成任务轮询
pipelineRouter.get('/shot-tasks/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  try {
    const rows = req.authUser && req.authUser.role !== 'admin'
      ? db.prepare(
          `SELECT * FROM shot_generation_tasks
            WHERE session_id = ? AND owner_id = ?
            ORDER BY shot_index ASC`
        ).all(sessionId, req.authUser.id) as any[]
      : db.prepare(
          'SELECT * FROM shot_generation_tasks WHERE session_id = ? ORDER BY shot_index ASC'
        ).all(sessionId) as any[];

    if (!rows || rows.length === 0) {
      return res.status(404).json({ success: false, error: '未找到对应多镜头 session 记录' });
    }

    const shots: any[] = [];
    let completedCount = 0;
    const completedUrls: string[] = [];

    for (const r of rows) {
      let currentStatus = r.status;
      let currentVideoUrl = r.video_url;
      let currentError = r.error_message;

      if ((currentStatus === 'generating' || currentStatus === 'pending') && r.seedance_task_id && hasSeedanceConfig()) {
        try {
          const raw = await getSeedanceVideo(r.seedance_task_id).catch(() => null);
          if (raw) {
            const normalized = normalizeSeedanceTask(raw);
            if (normalized.url) {
              currentStatus = 'completed';
              currentVideoUrl = normalized.url;
              db.prepare('UPDATE shot_generation_tasks SET status = ?, video_url = ? WHERE id = ?')
                .run('completed', currentVideoUrl, r.id);
            } else if (normalized.status === 'failed' || normalized.status === 'error') {
              currentStatus = 'failed';
              currentError = normalized.error || 'Seedance 渲染失败';
              db.prepare('UPDATE shot_generation_tasks SET status = ?, error_message = ? WHERE id = ?')
                .run('failed', currentError, r.id);
            }
          }
        } catch (err: any) {
          console.warn(`[shot-tasks poll] shot ${r.shot_index} error:`, err.message);
        }
      }

      // ---- 镜头级 QA：完成的镜头做启发式质检，失败则重生 1 次 ----
      if (currentStatus === 'completed' && currentVideoUrl && r.qa_status !== 'passed') {
        let qaLocalUrl = currentVideoUrl;
        // 远端产物先缓存到本地再探测，否则无法质检
        if (!currentVideoUrl.startsWith('/uploads/')) {
          const cached = await cacheRemoteVideoToUploads(currentVideoUrl, undefined, req.authUser?.id || r.owner_id || 'system');
          if (cached?.localUrl) {
            qaLocalUrl = cached.localUrl;
            currentVideoUrl = cached.localUrl;
            db.prepare('UPDATE shot_generation_tasks SET video_url = ? WHERE id = ?').run(currentVideoUrl, r.id);
          }
        }
        const qa = await qaShotVideo(qaLocalUrl);
        if (qa.ok) {
          db.prepare("UPDATE shot_generation_tasks SET qa_status = 'passed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(r.id);
        } else if ((r.qa_attempt || 0) < 1 && r.first_frame_url) {
          // 重生 1 次：用持久化的运镜 prompt + 产品首帧重新提交
          try {
            const prepared = buildSeedanceGenerationBody(
              {
                prompt: r.video_prompt || 'product close-up, smooth cinematic motion, 60fps, high detail',
                model: 'doubao-seedance-2-0-fast',
                duration: 5,
                resolution: '720p',
                aspectRatio: '9:16',
                imageUrl: r.first_frame_url,
              },
              `${req.protocol}://${req.get('host')}`
            );
            if (prepared.materials.length > 0) {
              const seedanceRes = await createSeedanceVideo(prepared.body);
              const task = normalizeSeedanceTask(seedanceRes);
              if (task.id) {
                if (req.authUser?.id) registerSeedanceTaskOwner(String(task.id), req.authUser.id, 'pipeline-shot-qa-regenerate');
                db.prepare(
                  `UPDATE shot_generation_tasks
                      SET status = 'generating', seedance_task_id = ?, qa_attempt = qa_attempt + 1,
                          qa_status = 'pending', error_message = NULL, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?`
                ).run(String(task.id), r.id);
                currentStatus = 'generating';
                currentError = undefined;
              }
            }
          } catch (err: any) {
            console.warn(`[ShotQA] regenerate shot ${r.shot_index} failed:`, err.message);
          }
        } else {
          currentStatus = 'failed';
          currentError = `镜头 QA 未通过: ${qa.reason || '未知原因'}`;
          db.prepare(
            `UPDATE shot_generation_tasks
                SET status = 'failed', qa_status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP
              WHERE id = ?`
          ).run(currentError, r.id);
        }
      }

      if (currentStatus === 'completed') {
        completedCount++;
        if (currentVideoUrl) completedUrls.push(currentVideoUrl);
      }

      shots.push({
        id: r.id,
        shotIndex: r.shot_index,
        status: currentStatus,
        seedanceTaskId: r.seedance_task_id,
        video_url: currentVideoUrl,
        error_message: currentError,
        created_at: r.created_at,
      });
    }

    let concatenatedVideoUrl: string | undefined = rows[0]?.concatenated_video_url || undefined;
    let concatStatus: 'pending' | 'processing' | 'completed' | 'failed' =
      rows[0]?.concat_status || 'pending';

    if (
      !concatenatedVideoUrl &&
      concatStatus !== 'processing' &&
      completedCount === rows.length &&
      completedUrls.length === rows.length &&
      completedUrls.length > 0
    ) {
      const claim = db.prepare(
        `UPDATE shot_generation_tasks
            SET concat_status = 'processing', updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND COALESCE(concat_status, 'pending') = 'pending'`
      ).run(rows[0].id);
      if (claim.changes === 0) {
        concatStatus = 'processing';
      } else {
        concatStatus = 'processing';
      try {
        const renderRes = await runFfmpegRender({
          videoSourceUrls: completedUrls,
          outputFilename: `concat_${sessionId}.mp4`,
          durationSec: completedUrls.length * 4,
          ownerId: req.authUser?.id || rows[0]?.owner_id,
          isAdmin: req.authUser?.role === 'admin',
        });
        if (renderRes.success && renderRes.data?.videoUrl) {
          concatenatedVideoUrl = renderRes.data.videoUrl;
            concatStatus = 'completed';
            db.prepare(
              `UPDATE shot_generation_tasks
                  SET concat_status = 'completed', concatenated_video_url = ?,
                      updated_at = CURRENT_TIMESTAMP
                WHERE session_id = ?`
            ).run(concatenatedVideoUrl, sessionId);
          } else {
            throw new Error(renderRes.error || 'FFmpeg concatenation failed');
        }
      } catch (err: any) {
        console.warn(`[shot-tasks concat] Auto-concat error:`, err.message);
          concatStatus = 'failed';
          db.prepare(
            `UPDATE shot_generation_tasks
                SET concat_status = 'failed', updated_at = CURRENT_TIMESTAMP
              WHERE session_id = ?`
          ).run(sessionId);
        }
      }
    }

    return res.json({
      success: true,
      data: {
        sessionId,
        totalShots: rows.length,
        completedShots: completedCount,
        shots,
        concatenatedVideoUrl,
        concatStatus,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/pipeline/concat-shots — FFmpeg 多镜头片段拼接
pipelineRouter.post('/concat-shots', async (req, res) => {
  const { sessionId, videoUrls } = req.body;
  let targetUrls: string[] = videoUrls || [];

  if ((!targetUrls || targetUrls.length === 0) && sessionId) {
    const rows = req.authUser && req.authUser.role !== 'admin'
      ? db.prepare(
          `SELECT video_url FROM shot_generation_tasks
            WHERE session_id = ? AND owner_id = ? AND status = 'completed'
            ORDER BY shot_index ASC`
        ).all(sessionId, req.authUser.id) as any[]
      : db.prepare(
          `SELECT video_url FROM shot_generation_tasks
            WHERE session_id = ? AND status = 'completed'
            ORDER BY shot_index ASC`
        ).all(sessionId) as any[];
    targetUrls = rows.map((r) => r.video_url).filter(Boolean);
  }

  if (!targetUrls || targetUrls.length === 0) {
    return res.status(400).json({ success: false, error: '未找到已完成的视频片段 URL 列表' });
  }
  if (targetUrls.some((url) => !canAccessLocalPipelineMedia(req, url, req.body?._ownerId))) {
    return res.status(403).json({ success: false, error: 'One or more media files are not accessible to this user' });
  }

  try {
    const renderRes = await runFfmpegRender({
      videoSourceUrls: targetUrls,
      outputFilename: `concat_${sessionId || Date.now()}.mp4`,
      durationSec: targetUrls.length * 4,
      ownerId: req.authUser?.id || req.body?._ownerId,
      isAdmin: req.authUser?.role === 'admin',
    });

    if (!renderRes.success || !renderRes.data) {
      return res.status(500).json({ success: false, error: renderRes.error || '多片段 FFmpeg 拼接失败' });
    }

    return res.json({
      success: true,
      data: {
        concatenatedVideoUrl: renderRes.data.videoUrl,
        downloadUrl: renderRes.data.downloadUrl,
        renderEngine: renderRes.data.renderEngine,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Step 3: 爆款文案撰写 + 品牌知识库注入 + 原视频爆款话术参考 + 违禁词合规扫描与自纠错
pipelineRouter.post('/step3', async (req, res) => {
  const inputs = req.body.inputs || req.body;
  const {
    videoPrompt = '',
    targetPlatform = 'douyin',
    scriptPersona = '成分党',
    textModel,
    productId,
    productInfo,
    pipelineData,
    originalScript: directOriginalScript,
  } = inputs;

  const product = getProductContext(productId, productInfo);
  const originalScript = directOriginalScript || pipelineData?.step1?.output?.originalScript || req.body.pipelineData?.step1?.output?.originalScript;

  let originalScriptReferencePrompt = '';
  if (originalScript && (originalScript.estimatedScript || (Array.isArray(originalScript.sellingPoints) && originalScript.sellingPoints.length > 0))) {
    originalScriptReferencePrompt = `\n\n【原视频爆款话术与叙事风格参考】
- 原视频口播内容参考：${originalScript.estimatedScript || '未解析到具体口播内容'}
- 原视频爆款卖点/Hook拆解：${Array.isArray(originalScript.sellingPoints) ? originalScript.sellingPoints.join('、') : '无'}
【重要指令】：请深度借鉴原视频的 Hook 引入技巧、叙事切入点与情绪递进逻辑，生成针对目标产品【${product.name}】的同款风格爆款文案，切勿凭空编造事实或违背目标产品定位！`;
  }

  const systemPrompt = `你是一个顶级短视频带货文案主创与品牌广告合规官。严格遵守以下 Harness 约束：

${HARNESS_CONSTRAINTS.JSON_ONLY}
${HARNESS_CONSTRAINTS.STRUCTURED_OUTPUT}
${HARNESS_CONSTRAINTS.LENGTH_CONSTRAINTS.title} - ${HARNESS_CONSTRAINTS.LENGTH_CONSTRAINTS.hook} - ${HARNESS_CONSTRAINTS.LENGTH_CONSTRAINTS.body}
${HARNESS_CONSTRAINTS.SAFETY}
${HARNESS_CONSTRAINTS.SELF_CRITIQUE}
${HARNESS_CONSTRAINTS.FEW_SHOT}

【合规绝对红线 - 禁止使用以下违禁词】
${JSON.stringify(product.prohibitedWords)}

【品牌知识库权威依据】
- 目标产品：${product.name}
- 核心定位：${product.positioning}
- 3:4:3配方架构：${product.model343}
- SGS权威检测数据：${product.sgsData}
- 核心卖点：${product.customSellingPoints}${originalScriptReferencePrompt}

【通用 Few-Shot 输出示例】
{
  "title": "搞定油光黑头！[产品名] SGS实测强效修复",
  "hook": "还在为油光黑头烦恼？试试【[产品名]】的3:4:3配方，SGS权威实测见效！",
  "body": "来看 SGS 权威报告！[产品名] 凭什么口碑爆款？核心就在它的洗完一润二修三控油体系。膏体质感拉丝，自然清爽不紧绷！",
  "hashtags": ["#[产品名]", "#美妆爆款", "#SGS实测"],
  "cta": "点击下方链接，领专属限时体验福利！",
  "platform_fit": {
    "douyin": "宝藏好物！[产品名] SGS实测效果拉满！点击领优惠～",
    "xiaohongshu": "沉浸式种草！[产品名] 质地超级治愈，强烈推荐给所有宝子们～"
  }
}`;

  const userPrompt = `【文案生成任务】
- 目标产品：${product.name}
- 目标平台：${targetPlatform}
- 脚本人设：${scriptPersona}
- 镜头运镜描述：${videoPrompt || `镜头推进展示 ${product.name}`}
请严格按照示例 Schema 输出纯 JSON 对象。`;

  // 包含违禁词检测自纠错 Loop (最多 2 次)
  let hRes = await executeWithSelfCorrection<Step3Output>(
    'Step3',
    systemPrompt,
    userPrompt,
    undefined,
    textModel,
    Step3OutputSchema
  );

  let data: any = hRes.data;
  let source = hRes.source;
  let modelUsed = hRes.modelUsed;

  if (data) {
    if (originalScriptReferencePrompt) {
      data.refOriginalScriptUsed = true;
    }
    const warnings = scanProhibitedWords(data, product.prohibitedWords);
    if (warnings.length > 0) {
      console.warn('[Harness Step3] 触发违禁词自纠错重试，检测到的违规项:', warnings.map(w => w.word).join(', '));
      // 追加违规词自纠错 Prompt
      const retryUser = `${userPrompt}\n\n【合规拦截警示】你上一次生成的文案包含了违禁极限词：[${warnings.map(w => w.word).join(', ')}]！请务必替换为更加客观合规的描述重试！`;
      const retryRes = await executeWithSelfCorrection<Step3Output>(
        'Step3-ComplianceRetry',
        systemPrompt,
        retryUser,
        undefined,
        textModel,
        Step3OutputSchema,
        1
      );
      if (retryRes.data) {
        data = retryRes.data;
        source = retryRes.source;
        modelUsed = retryRes.modelUsed;
      }
      // 再次扫描并记录 warnings 标记
      const finalWarnings = scanProhibitedWords(data, product.prohibitedWords);
      if (finalWarnings.length > 0) {
        data.warnings = finalWarnings;
      }
    }
  }

  if (!data) {
    return res.status(502).json({
      success: false,
      error: `Step 3 文案生成失败: ${hRes.error || '未能生成符合合规要求的文案'}。请检查模型配置。`,
      source: 'error',
    });
  }

  return res.json({ success: true, data, source, modelUsed });
});

// Step 4: BGM 库检索与 LLM 语义卡点匹配 + 原视频 BPM 优先检索
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
    pipelineData,
    audioAnalysis: directAudioAnalysis,
  } = inputs;
  const bgmLlmId = textModel || musicModel || 'Gemini 3.6 Flash';

  const product = getProductContext(productId, productInfo);
  const audioAnalysis = directAudioAnalysis || pipelineData?.step1?.output?.audioAnalysis || req.body.pipelineData?.step1?.output?.audioAnalysis;

  let targetBpm: number | null = null;
  if (audioAnalysis?.estimatedBpm) {
    const parsed = parseInt(String(audioAnalysis.estimatedBpm).replace(/\D/g, ''), 10);
    if (!isNaN(parsed) && parsed >= 40 && parsed <= 220) {
      targetBpm = parsed;
    }
  }

  // 从 SQLite 按调性智能筛选候选 BGM + 原视频 BPM 范围过滤 (targetBpm ± 10)
  let bgmRows: any[] = [];
  try {
    if (targetBpm !== null) {
      const minBpm = Math.max(40, targetBpm - 10);
      const maxBpm = Math.min(220, targetBpm + 10);
      const stmt = db.prepare('SELECT * FROM bgm_library WHERE bpm BETWEEN ? AND ? ORDER BY created_at DESC LIMIT 15');
      bgmRows = stmt.all(minBpm, maxBpm) as any[];
    }

    if (!bgmRows || bgmRows.length === 0) {
      let bpmMin = 80, bpmMax = 140;
      if (tonePreference && tonePreference.trim().length > 0) {
        if (tonePreference.includes('卡点') || tonePreference.includes('Electronic') || tonePreference.includes('Trap')) {
          bpmMin = 110;
          bpmMax = 140;
        } else if (tonePreference.includes('治愈') || tonePreference.includes('Ambient') || tonePreference.includes('Lofi')) {
          bpmMin = 70;
          bpmMax = 100;
        } else if (tonePreference.includes('R&B') || tonePreference.includes('ASMR')) {
          bpmMin = 85;
          bpmMax = 120;
        }
        const stmt = db.prepare('SELECT * FROM bgm_library WHERE (mood LIKE ? OR style_tags LIKE ?) AND bpm BETWEEN ? AND ? ORDER BY created_at DESC LIMIT 15');
        bgmRows = stmt.all(`%${tonePreference}%`, `%${tonePreference}%`, bpmMin, bpmMax) as any[];
      }
    }

    if (!bgmRows || bgmRows.length === 0) {
      const stmt = db.prepare('SELECT * FROM bgm_library ORDER BY created_at DESC LIMIT 15');
      bgmRows = stmt.all() as any[];
    }
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

  const systemPrompt = `你是一个专业的电商短视频音乐总监与音画匹配算法专家。严格遵守以下 Harness 约束：

${HARNESS_CONSTRAINTS.JSON_ONLY}
${HARNESS_CONSTRAINTS.STRUCTURED_OUTPUT}
${HARNESS_CONSTRAINTS.SAFETY}
${HARNESS_CONSTRAINTS.SELF_CRITIQUE}
${HARNESS_CONSTRAINTS.FEW_SHOT}

【候选 BGM 音乐库（前15条筛选推荐）】
${JSON.stringify(bgmCandidates, null, 2)}

【通用 Few-Shot 输出示例】
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
    {"track_name": "自然光影", "artist": "Soft Ambient", "rationale": "备选，适合更明亮的早晨场景", "sync_point": "0.8s 快切"},
    {"track_name": "晨间水滴", "artist": "Chill Lab", "rationale": "备选，适合更柔和的种草氛围", "sync_point": "1.5s 推进"}
  ]
}`;

  let userPrompt = `【BGM匹配任务】
- 目标产品：${product.name}
- 视频文案标题：${copywritingTitle || product.name}
- 视频调性偏好：${tonePreference}
- 商业授权场景：${commercialScenario}`;
  if (targetBpm !== null) {
    userPrompt += `\n- 原视频分析 BPM：${targetBpm} (请优先推荐与原视频 BPM (${targetBpm}±10) 匹配度最高且符合 ${tonePreference} 调性的 BGM)`;
  }
  userPrompt += `\n请结合候选库进行语义最佳匹配，并输出规范 JSON。`;

  const hRes = await executeWithSelfCorrection<Step4Output>(
    'Step4',
    systemPrompt,
    userPrompt,
    undefined,
    bgmLlmId,
    Step4OutputSchema
  );

  let data: any = hRes.data;
  let source = hRes.source;

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
          artist: b.artist || '未知艺人',
          rationale: `备选曲目 · ${b.mood || b.artist || ''}`,
          sync_point: '1.0s 节奏点',
        })),
    };
    source = hRes.data ? 'library' : 'library-fallback';
  } else {
    const recName = data.bgm_recommendation.track_name;
    const inLib = bgmRows.find((b) => b.track_name === recName);
    if (inLib) {
      // 库内真实音频优先——LLM 可能编造 audioSampleUrl（如 example.com），必须用库内文件覆盖
      const libAudio =
        inLib.audio_url ||
        (inLib.audio_path ? `/${String(inLib.audio_path).replace(/\\/g, '/')}` : undefined);
      if (libAudio) {
        data.bgm_recommendation.audioSampleUrl = libAudio;
      } else {
        delete data.bgm_recommendation.audioSampleUrl;
      }
      data.bgm_recommendation.artist = data.bgm_recommendation.artist || inLib.artist;
      data.bgm_recommendation.bpm = String(data.bgm_recommendation.bpm || inLib.bpm || 90);
      data.bgm_recommendation.license_note = inLib.license_type || data.bgm_recommendation.license_note;
    }
    // 兜底：LLM 编造/空 URL（example.com 等示例地址）→ 用库内真实曲目音频覆盖
    const currentUrl = data.bgm_recommendation?.audioSampleUrl;
    if (!currentUrl || currentUrl.includes('example.com') || currentUrl.startsWith('http://example')) {
      const fallback = bgmRows[0];
      if (fallback) {
        data.bgm_recommendation.audioSampleUrl =
          fallback.audio_url ||
          (fallback.audio_path ? `/${String(fallback.audio_path).replace(/\\/g, '/')}` : undefined);
      }
    }
  }

  if (targetBpm !== null && data?.bgm_recommendation) {
    data.bgm_recommendation.originalVideoBpm = String(targetBpm);
    data.bgm_recommendation.bpmAlignmentNote = `已针对原视频 BPM (${targetBpm}) 匹配最契合的 BGM (${data.bgm_recommendation.bpm} BPM)`;
  }

  return res.json({ success: true, data, source });
});

// Step 5: 成品合成 Timeline 构建与 FFmpeg 渲染导出 (支持多镜头 Timeline 编排)
pipelineRouter.post('/step5', async (req, res) => {
  const inputs = req.body.inputs || req.body;
  const {
    aspectRatio = '9:16',
    subtitleStyle = '黄字黑边',
    productId,
    productInfo,
    title = '',
    hook = '',
    cta = '',
    videoSourceUrl = '',
    audioSourceUrl = '',
    previewVideoUrl = '',
  } = inputs;

  const product = getProductContext(productId, productInfo);
  const pipelineData = inputs.pipelineData || req.body.pipelineData;
  const shotList = inputs.shotList || pipelineData?.step1?.output?.shotList;
  if (Array.isArray(shotList) && shotList.length > 12) {
    return res.status(400).json({
      success: false,
      error: '单次成片最多支持 12 个镜头',
    });
  }
  const step2Output = inputs.step2Output || pipelineData?.step2?.output;
  const step3Output = inputs.step3Output || pipelineData?.step3?.output;
  const concatenatedVideoUrl = inputs.concatenatedVideoUrl || step2Output?.concatenatedVideoUrl || step2Output?.multiShotResult?.concatenatedVideoUrl;

  const rawVideoClips = inputs.videoSourceUrls || inputs.videoClips || (step2Output?.multiShotResult?.shots ? step2Output.multiShotResult.shots.map((s: any) => s.video_url).filter(Boolean) : []);

  const timestamp = Date.now();
  const filename = `v_${timestamp}.mp4`;

  const resolvedVideo = videoSourceUrl || concatenatedVideoUrl || previewVideoUrl || inputs.videoUrl || '';
  const resolvedAudio = audioSourceUrl || inputs.bgmUrl || '';
  const effectiveOwnerId = req.authUser?.id || inputs._ownerId;
  const isAdmin = req.authUser?.role === 'admin';
  const requestedMedia = [
    ...(Array.isArray(rawVideoClips) ? rawVideoClips : []),
    resolvedVideo,
    resolvedAudio,
  ].filter(Boolean);
  if (
    !effectiveOwnerId ||
    requestedMedia.some((value) =>
      !canUseMediaReference(String(value), effectiveOwnerId, isAdmin)
    )
  ) {
    return res.status(403).json({
      success: false,
      error: 'One or more media files are not accessible to this user',
    });
  }

  const brandStamp = `${product.name}`;
  const timeline: Array<{
    at: string;
    action: string;
    source?: string;
    text?: string;
    volume?: number;
    position?: string;
    startSec?: number;
    endSec?: number;
  }> = [
    { at: '0.0s', action: 'video_in', source: (rawVideoClips.length > 1 ? `Multi-clip (${rawVideoClips.length} clips)` : (resolvedVideo || 'video_step2.mp4')), text: 'Step2 视频轨' },
    {
      at: '0.0s',
      action: 'audio_in',
      source: resolvedAudio || 'bgm.mp3',
      volume: 0.3,
      text: 'BGM 音轨',
    },
  ];

  const renderSubtitles: Array<{ text: string; at?: string; startSec?: number; endSec?: number }> = [];

  if (Array.isArray(shotList) && shotList.length > 0) {
    let currentSec = 0;
    shotList.forEach((shot: any, idx: number) => {
      let startSec = currentSec;
      let endSec = currentSec + 3;
      if (shot.startTime && shot.endTime) {
        const parseTime = (tStr: string) => {
          const parts = String(tStr).split(':').map(Number);
          if (parts.length === 2) return parts[0] * 60 + parts[1];
          if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
          return Number(tStr) || 0;
        };
        const pStart = parseTime(shot.startTime);
        const pEnd = parseTime(shot.endTime);
        if (pEnd > pStart) {
          startSec = pStart;
          endSec = pEnd;
        }
      }
      currentSec = endSec;

      let subText = '';
      if (idx === 0) {
        subText = hook || title || step3Output?.hook || step3Output?.title || shot.description || `【${product.name}】`;
      } else if (idx === 1) {
        subText = (step3Output?.body || inputs.body || product.sgsData || shot.description || '').slice(0, 32);
      } else if (idx === 2) {
        subText = cta || step3Output?.cta || inputs.cta || `点击下方链接领限时福利`;
      } else {
        subText = shot.description || `镜头 ${idx + 1}`;
      }

      if (subText) {
        timeline.push({
          at: `${startSec.toFixed(1)}s-${endSec.toFixed(1)}s`,
          action: 'subtitle_in',
          text: subText,
          position: 'bottom_center',
          startSec,
          endSec,
        });

        renderSubtitles.push({
          text: subText,
          at: `${startSec.toFixed(1)}s`,
          startSec,
          endSec,
        });
      }
    });
  } else {
    const defaultLines = [
      title || hook || step3Output?.title || step3Output?.hook || `体验 ${product.name}！`,
      product.sgsData ? `SGS: ${String(product.sgsData).split(',')[0]}` : '',
    ].filter(Boolean);

    defaultLines.forEach((text, i) => {
      const startSec = i * 2;
      const endSec = (i + 1) * 2;
      timeline.push({
        at: `${startSec.toFixed(1)}s-${endSec.toFixed(1)}s`,
        action: 'subtitle_in',
        text,
        position: 'bottom_center',
        startSec,
        endSec,
      });
      renderSubtitles.push({ text, at: `${startSec.toFixed(1)}s`, startSec, endSec });
    });
  }

  timeline.push({ at: '2.8s', action: 'brand_stamp', text: brandStamp, position: 'top_right' });

  const videoForRender = resolvedVideo;

  if (!videoForRender && rawVideoClips.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'Step 5 缺少视频源：请先完成 Step2 并等待 Seedance 生成 previewVideoUrl 或多片段 concatenatedVideoUrl',
      source: 'error',
    });
  }

  const durationSec = renderSubtitles.length > 0
    ? Math.max(...renderSubtitles.map((s) => s.endSec || 4), 4)
    : 4;

  const renderResult = await runFfmpegRender({
    aspectRatio,
    videoSourceUrl: rawVideoClips.length > 1 ? undefined : videoForRender,
    videoSourceUrls: rawVideoClips.length > 1 ? rawVideoClips : undefined,
    audioSourceUrl: resolvedAudio,
    subtitles: renderSubtitles,
    brandStamp,
    outputFilename: filename,
    durationSec,
    ownerId: req.authUser?.id || inputs._ownerId,
    isAdmin: req.authUser?.role === 'admin',
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
  const responseSource = renderResult.source || 'ffmpeg';
  const firstFrameSource =
    inputs.firstFrameSource ||
    step2Output?.firstFrameSource ||
    pipelineData?.step2?.output?.firstFrameSource ||
    undefined;

  const publishReport = evaluatePublishGate({
    videoUrl: out.videoUrl,
    source: responseSource,
    durationSec: out.duration_sec,
    resolution: out.resolution,
    aspectRatio,
    hasSubtitles: renderSubtitles.length > 0,
    hasAudio: Boolean(resolvedAudio),
    isMockFallback: false,
    allowMockFallback: false,
    complianceWarnings: step3Output?.warnings,
    narrativeBeatsPresent: Boolean(
      pipelineData?.step1?.output?.narrativeBeats?.length ||
        (Array.isArray(shotList) && shotList.length >= 3)
    ),
    firstFrameSource,
    clipCount: rawVideoClips.length || (videoForRender ? 1 : 0),
  });

  // 成片未通过发布门禁：硬失败（缺视频源/mock）→ 422 failed；软失败（分数/警告）→ needs_review
  if (!publishReport.passed) {
    const hardFail =
      publishReport.blockers.includes('missing_video_url') ||
      publishReport.blockers.includes('mock_result_not_publishable') ||
      publishReport.blockers.includes('final_first_frame_is_viral_not_product');
    const report = {
      ...publishReport,
      status: hardFail ? ('failed' as const) : ('needs_review' as const),
    };
    if (hardFail) {
      return res.status(422).json({
        success: false,
        error: `成片未通过发布门禁: ${report.blockers.join(', ') || report.status}`,
        source: responseSource,
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
          publishReport: report,
          qa_checklist: [
            `✗ Publish Gate: ${report.status}`,
            ...report.blockers.map((b) => `✗ ${b}`),
            ...report.warnings.map((w) => `○ ${w}`),
          ],
          renderEngine: out.renderEngine,
        },
      });
    }
    // 软失败：成片已生成，标记 needs_review 交人工审核，不静默 completed
    return res.json({
      success: true,
      source: responseSource,
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
        publishReport: report,
        qa_checklist: [
          `○ Publish Gate: ${report.status}（需人工审核）`,
          ...report.blockers.map((b) => `✗ ${b}`),
          ...report.warnings.map((w) => `○ ${w}`),
        ],
        renderEngine: out.renderEngine,
      },
    });
  }

  return res.json({
    success: true,
    source: responseSource,
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
      publishReport,
      qa_checklist: [
        publishReport.passed ? '✓ Publish Gate 通过' : `○ Publish Gate: ${publishReport.status}`,
        `✓ 画面比例匹配 (${out.resolution} ${aspectRatio})`,
        `✓ 字幕样式 [${subtitleStyle}]`,
        rawVideoClips.length > 1 ? `✓ 多片段视频源 (${rawVideoClips.length} clips)` : `✓ 视频源: ${videoForRender}`,
        resolvedAudio ? `✓ BGM: ${resolvedAudio}` : '○ 未附带 BGM（仅视频轨）',
        `✓ 渲染引擎: ${out.renderEngine}`,
        ...publishReport.warnings.map((w) => `○ ${w}`),
      ],
      renderEngine: out.renderEngine,
    },
  });
});
