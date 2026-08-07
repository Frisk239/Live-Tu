import { Router } from 'express';
import { db } from '../lib/db';
import { callLlmGateway, callImageGenerationGateway } from '../lib/llm-gateway';
import {
  assertPublishableVideoContext,
  isTrustedFirstFrameEvidence,
  registerGeneratedMedia,
} from '../lib/publish-context';
import { resolveFirstFrameSource } from '../lib/publish-gate';
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
  preflightMediaUrl,
} from './seedance';
import { cacheRemoteMedia, runFfmpegRender, resolveMediaPath } from './render';
import { publishLocalAsset } from '../lib/asset-publisher';
import { internalWorkerHeaders } from '../lib/auth';
import { qaShotVideo } from '../lib/shot-qa';
import { buildShotMigrationPlan, type ProductAssetRef } from '../lib/migration-plan';
import { resolveRunProductAssets } from '../lib/product-assets';
import { evaluatePublishGate } from '../lib/publish-gate';
import { evaluateFinalCompositeGate } from '../lib/final-composite-gate';
import {
  ensureShotFirstFrame,
  persistShotFirstFrame,
  markShotFirstFrameBlocked,
  ShotFirstFrameError,
  resolveTrustedAssetKind,
} from '../lib/shot-first-frame';
import { resolvePublicMediaUrl } from './seedance';
import { getVideoSubmissionPort } from '../lib/video-submission-port';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { canUseMediaReference } from '../lib/media-ownership';
import { registerSeedanceTaskOwner } from '../lib/seedance-ownership';
import { recordCostEntry, updateShotCostOutcome } from '../lib/telemetry';
import { DEFAULT_PROMPT_VERSION, type CostEntry } from '../../shared/cost-ledger';
import { currentGitCommit } from '../lib/golden-eval';
import { type FullVideoPlan, validateFullVideoPlan } from '../lib/full-video-plan';

export const pipelineRouter = Router();

/**
 * The quality timeline is optional for legacy concat callers, but when it is
 * supplied it must be a complete, server-validated 6-8 shot plan.  Keep this
 * parsing at the route seam; the renderer only receives a trusted plan.
 */
function parseRequestedFullVideoPlan(value: unknown): { plan?: FullVideoPlan; error?: string } {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== 'object' || !Array.isArray((value as any).shots) || !Array.isArray((value as any).beats)) {
    return { error: 'fullVideoPlan 必须是包含 shots 与 beats 的完整计划对象' };
  }
  try {
    const plan = value as FullVideoPlan;
    const errors = validateFullVideoPlan(plan);
    return errors.length > 0
      ? { error: `fullVideoPlan 未通过质量契约: ${errors.join('; ')}` }
      : { plan };
  } catch (error: any) {
    return { error: `fullVideoPlan 解析失败: ${error?.message || String(error)}` };
  }
}

/** S1 生产成本账本：构造一条账目并落库（失败仅告警，不影响主流程） */
function recordPipelineCost(
  partial: Partial<CostEntry> & { id: string; scope: CostEntry['scope']; provider: string; model: string },
  ownerId: string
): void {
  try {
    const entry: CostEntry = {
      id: partial.id,
      scope: partial.scope,
      runId: partial.runId,
      sampleId: partial.sampleId,
      shotId: partial.shotId,
      provider: partial.provider,
      model: partial.model,
      modelVersion: partial.modelVersion ?? partial.model,
      seed: partial.seed ?? null,
      promptVersion: partial.promptVersion ?? DEFAULT_PROMPT_VERSION,
      queueMs: partial.queueMs ?? 'unknown',
      generationMs: partial.generationMs ?? 'unknown',
      retries: partial.retries ?? 0,
      failureReason: partial.failureReason ?? null,
      billing: partial.billing ?? [],
      estimatedUsd: partial.estimatedUsd ?? 'unknown',
      actualUsd: partial.actualUsd ?? 'unknown',
      currency: 'USD',
      source: partial.source ?? 'ledger',
      manualChoice: partial.manualChoice ?? null,
      scorecardVersion: partial.scorecardVersion ?? 'v1.0.0',
      pipelineVersion: partial.pipelineVersion ?? 'v1.0.0',
      gitCommit: partial.gitCommit ?? currentGitCommit(),
      recordedAt: partial.recordedAt ?? Date.now(),
    };
    recordCostEntry(entry, ownerId);
  } catch (error: any) {
    console.warn(`[cost-ledger] 记录失败（不影响主流程）: ${String(error?.message || error).slice(0, 100)}`);
  }
}

function elapsedSinceSqliteTimestamp(value: unknown): number {
  if (typeof value !== 'string' || !value) return 0;
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const startedAt = Date.parse(normalized);
  return Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : 0;
}

function canAccessLocalPipelineMedia(req: any, mediaUrl: string, ownerId?: string): boolean {
  if (!mediaUrl.startsWith('/uploads/') && !mediaUrl.startsWith('uploads/')) return true;
  const normalized = mediaUrl.startsWith('/') ? mediaUrl : `/${mediaUrl}`;
  const effectiveOwnerId = req.authUser?.id || ownerId;
  if (!effectiveOwnerId && !req.authUser?.role) return false;
  // Generated/cached renders are registered in media_ownership instead of materials.
  // Use the shared ownership evaluator first so concat accepts a user's own
  // Seedance cache while keeping the same cross-user and path-safety checks as
  // every other media-consuming endpoint.
  if (effectiveOwnerId && canUseMediaReference(
    normalized,
    effectiveOwnerId,
    req.authUser?.role === 'admin'
  )) {
    return true;
  }
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
  if (/Yunshu .* failed/i.test(msg)) {
    return '主通道与 yunshu 备用通道均提交失败，请稍后重试或检查两个中转服务状态';
  }
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

    // S1.5：关键帧全空时显式失败（可读错误），不再静默用空帧做劣质拆解；
    // 后续 Step2 仍可退化到产品图首帧（productHeroUrl 逻辑），不受此影响。
    if (keyframeUrls.length === 0) {
      return res.status(422).json({
        success: false,
        error:
          '视频关键帧提取失败（ffmpeg 无法从该视频抽取帧，请检查服务器 ffmpeg 环境与视频文件完整性），' +
          '无法进行视频拆解。可改用产品图模式或重新上传视频。',
      });
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
          // S0 provenance：声明 product_conditioned 时携带实际首帧证据 URL
          firstFrameEvidenceUrl: migrationPlan?.productHeroUrl,
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
    // S3 一级输入：爆款参考视频 + 系统自动提取的参考关键帧（用户不提供首帧）
    referenceVideoUrl: inputReferenceVideoUrl,
    referenceKeyframes: inputReferenceKeyframes,
  } = inputs;
  const referenceVideoUrl =
    inputReferenceVideoUrl || viralMediaUrl || pipelineData?.step1?.inputs?.mediaUrl || '';
  const referenceKeyframes: string[] = Array.isArray(inputReferenceKeyframes)
    ? inputReferenceKeyframes
    : (pipelineData?.step1?.output?.shotList || [])
        .map((s: any) => s.keyframeUrl)
        .filter(Boolean);

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
  // 用户显式选择的首帧图（rawTarget/imageUrl）优先于产品资产表的旧图（productHeroUrl）
  const targetImageUrl = (!looksLikeViral && rawTarget) ? rawTarget : (productHeroUrl || '');
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
  // viral_recreation_v2 模式：step2 传入的 directOutMode 声明（与 orchestrator 同源）。
  // 该模式允许虚构人物（P0 实测中转风控拦截 UGC 帧素材，纯生成虚构人物可过），
  // 但文字层/竞品仍禁止——prompt 约束按模式分支，替代旧「无人物安全代理」约束。
  const step2ViralV2 =
    inputs.directOutMode === 'viral_recreation_v2' ||
    pipelineData?.directOutMode === 'viral_recreation_v2' ||
    pipelineData?.mode === 'viral_recreation_v2' ||
    req.body.directOutMode === 'viral_recreation_v2' ||
    req.body.pipelineData?.directOutMode === 'viral_recreation_v2';

  // ------------------ 多镜头分段生成分支 ------------------
  if (Array.isArray(targetShotList) && targetShotList.length > 0) {
    const sessionId = `shot_sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const seedanceConfigured = hasSeedanceConfig();
    const modelId = String(videoModel || '').includes('Fast')
      ? 'doubao-seedance-2-0-fast'
      : 'doubao-seedance-2-0';

    const shotTasks: Array<{
      id: string;
      shotIndex: number;
      shotType: string;
      cameraMovement: string;
      description: string;
      keyframeUrl: string;
      referenceKeyframeUrl?: string;
      referenceVideoUrl?: string;
      firstFrameSource: string;
      /** S0 provenance：实际用作 Seedance 首帧的产品图证据 URL */
      firstFrameEvidenceUrl?: string;
      derivedFirstFrameUrl?: string;
      video_prompt: string;
      seedanceTaskId?: string;
      status: 'pending' | 'generating' | 'completed' | 'failed';
      video_url?: string;
      error_message?: string;
    }> = [];

    for (let idx = 0; idx < targetShotList.length; idx++) {
      const shot = targetShotList[idx];
      const shotIndex = shot.shotIndex || (idx + 1);
      // S3 输入模型纠正：用户不再提供「首帧图」。
      // 首帧是内部派生资产（derivedFirstFrameUrl）：由 参考关键帧（构图基座）+ 产品图（包装参考）
      // 在提交前经产品条件化首帧模块生成。这里只记录参考上下文，first_frame_url 保持空（待派生）。
      const structureRefUrl = shot.referenceKeyframeUrl || shot.keyframeUrl || referenceKeyframes[idx % Math.max(1, referenceKeyframes.length)] || '';
      // 兼容旧调用方：显式传入的 keyframeUrl 仅作「参考关键帧」语义（绝不直接用作 Seedance 首帧）
      const kfUrl = structureRefUrl;

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
- 要求：${
        step2ViralV2
          ? '画面主体必须是我方产品包装与一名虚构女性博主（虚构数字人物，非任何真实人物），禁止竞品包装；画面不得出现任何文字、字幕、水印、logo、二维码'
          : '画面主体必须是我方产品包装，禁止竞品包装；不得出现脸、手、手指、手臂、皮肤、人体或任何解剖伪影；让产品、喷嘴、泡沫和台面承担动作'
      }
- 硬性视觉约束：${Array.isArray(shot.negativeConstraints) && shot.negativeConstraints.length > 0 ? shot.negativeConstraints.join('；') : '无'}
请输出纯 JSON。`;

      let videoPrompt =
        shot.motionPrompt ||
        `A smooth cinematic video shot for ${product.name}, ${shot.shotType || 'close-up'}, ${shot.cameraMovement || 'zoom in'}, 60fps, high detail, our product packaging only`;
      try {
        const shotRes = await callLlmGateway({
          system: shotSystemPrompt,
          user: shotUserPrompt,
          // 参考关键帧作为运镜 prompt 生成的视觉上下文（不是首帧）
          imageUrl: kfUrl || productHeroUrl || undefined,
          modelId: motionLlmId,
        });
        if (shotRes.success && shotRes.data && shotRes.data.video_prompt) {
          videoPrompt = shotRes.data.video_prompt;
        }
      } catch (err: any) {
        console.warn(`[Step2 MultiShot] LLM prompt gen for shot ${shotIndex} failed:`, err.message);
      }
      // Prompt rewriting is a convenience seam, not an authority to loosen the
      // visual safety contract. Keep the mode-appropriate constraints attached to
      // the final Seedance prompt even when the LLM returns its own wording.
      const hardVisualConstraints = step2ViralV2
        ? [
            'a fictional digital woman presenter only, never a real person and never based on any source-video identity',
            'no text, letters, subtitles, captions, watermarks, QR codes, usernames, UI elements, or logos anywhere in the frame',
            'no competitor packaging or copied brand marks',
            ...(Array.isArray(shot.negativeConstraints) ? shot.negativeConstraints : []),
          ]
        : [
            'no face, hands, fingers, arms, skin, torso, silhouette, or any human body part',
            'no anatomical deformation or hand-held product pose',
            'product, nozzle, foam, ceramic surface, and simple props carry the action',
            ...(Array.isArray(shot.negativeConstraints) ? shot.negativeConstraints : []),
          ];
      videoPrompt = `${videoPrompt}. Hard visual constraints: ${hardVisualConstraints.join('; ')}.`;

      const taskId = `shot_task_${sessionId}_${shotIndex}`;
      let shotSeedanceTaskId: string | undefined = undefined;
      let shotStatus: 'pending' | 'generating' | 'completed' | 'failed' = 'pending';
      let shotVideoUrl: string | undefined = undefined;
      let shotErrorMsg: string | undefined = undefined;

      try {
        // owner 优先级：会话用户 > 编排器透传的 run 所有者（内部轮询无 authUser，必须用 _ownerId）
        const shotOwnerId = req.authUser?.id || inputs._ownerId || null;
        // S3：first_frame_url 不再由用户/产品主图填入——首帧是内部派生产物，
        // 提交时（submit-shot / 工作台批量提交）经产品条件化首帧模块生成后写入。
        db.prepare(`
          INSERT INTO shot_generation_tasks (
            id, session_id, owner_id, shot_index, status, video_prompt,
            reference_keyframe_url, reference_video_url
          ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)
        `).run(taskId, sessionId, shotOwnerId, shotIndex, videoPrompt, kfUrl || null, referenceVideoUrl || null);
      } catch (err: any) {
        console.error(`[Step2 MultiShot] Could not persist shot ${shotIndex}:`, err.message);
        return res.status(500).json({
          success: false,
          error: '多镜头任务无法持久化，未提交视频生成',
        });
      }

      // S1.3：step2 只做「运镜 prompt 生成 + 任务持久化（pending）」。
      // Seedance 提交由编排器逐镜调用独立端点 POST /step2/submit-shot 完成，
      // 避免 12 镜（LLM + 提交）全部挤在单个 300s HTTP 请求内被超时掐断。
      shotTasks.push({
        id: taskId,
        shotIndex,
        shotType: shot.shotType || '特写',
        cameraMovement: shot.cameraMovement || '平滑推进',
        description: shot.description || shot.structureBrief || '',
        // 参考关键帧（构图基座；由系统从爆款视频提取，不是用户首帧）
        keyframeUrl: kfUrl || undefined,
        referenceKeyframeUrl: kfUrl || undefined,
        referenceVideoUrl: referenceVideoUrl || undefined,
        // S3：首帧 = 内部派生资产（derivedFirstFrameUrl），提交时生成
        firstFrameSource: 'derived' as const,
        derivedFirstFrameUrl: undefined,
        // S0 provenance：声明实际用作 Seedance 首帧的产品图证据 URL（派生后填充）
        firstFrameEvidenceUrl: undefined,
        video_prompt: videoPrompt,
        seedanceTaskId: undefined,
        status: 'pending',
        video_url: undefined,
        error_message: undefined,
      });
    }

    const multiShotResult = {
      sessionId,
      totalShots: targetShotList.length,
      estimatedCompletionTimeSec: targetShotList.length * 15,
      shots: shotTasks,
      concatStatus: 'pending' as const,
      // S3：首帧为内部派生资产（referenceKeyframe + productAssets → derivedFirstFrameUrl）
      firstFrameSource: 'derived' as const,
      referenceVideoUrl: referenceVideoUrl || undefined,
      productHeroUrl: productAssets[0]?.url || undefined,
    };

    // S1.3 修复：手动模式下（非编排器），step2 返回后立即异步触发逐镜提交，
    // 避免镜头永远停在 pending 状态。每镜独立提交，失败不影响其他镜头。
    const shotOwnerId = req.authUser?.id || inputs._ownerId || '';
    if (seedanceConfigured && shotOwnerId) {
      const modelId = String(videoModel || '').includes('Fast')
        ? 'doubao-seedance-2-0-fast'
        : 'doubao-seedance-2-0';
      // 异步提交（不阻塞 response），逐镜串行避免并发冲突
      (async () => {
        // 直接模式：用户已有 AI 生成的首帧图（targetImageUrl），需要发布到中继
        // 并写入每个 shot 的 first_frame_url，让 submit-shot 跳过派生直接使用。
        let publishedFirstFrameUrl: string | null = null;
        if (targetImageUrl) {
          try {
            const localAbsPath = resolveMediaPath(targetImageUrl);
            if (localAbsPath && fs.existsSync(localAbsPath)) {
              const published = await publishLocalAsset(localAbsPath);
              publishedFirstFrameUrl = published.publicUrl;
              // 写入所有 shot 的 first_frame_url
              db.prepare(
                `UPDATE shot_generation_tasks SET first_frame_url = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE session_id = ? AND owner_id = ?`
              ).run(publishedFirstFrameUrl, sessionId, shotOwnerId);
            }
          } catch (pubErr: any) {
            console.warn('[Step2 auto-submit] 首帧发布失败:', pubErr?.message);
          }
        }

        for (const shot of shotTasks) {
          try {
            const submitRes = await fetch(`http://127.0.0.1:${process.env.PORT || 3004}/api/pipeline/step2/submit-shot`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...internalWorkerHeaders() },
              body: JSON.stringify({
                sessionId,
                shotIndex: shot.shotIndex,
                model: modelId,
                _ownerId: shotOwnerId,
              }),
              signal: AbortSignal.timeout(180_000),
            });
            const result = await submitRes.json().catch(() => null);
            if (result?.success && result?.data?.seedanceTaskId) {
              shot.seedanceTaskId = result.data.seedanceTaskId;
              shot.status = 'generating';
            } else {
              shot.status = 'failed';
              shot.error_message = result?.error || 'submit-shot 调用失败';
            }
          } catch (err: any) {
            console.warn(`[Step2 auto-submit] shot ${shot.shotIndex} failed:`, err?.message);
            shot.status = 'failed';
            shot.error_message = err?.message || '提交超时';
          }
        }
      })();
    }

    return res.json({
      success: true,
      data: {
        motion_type: 'zoom_in',
        motion_intensity: 'medium',
        motion_description: `分段多镜头生成：每镜首帧将由「爆款参考关键帧 + 产品图」条件化派生（derivedFirstFrameUrl），绝不使用原爆款帧或产品主图直接充当首帧`,
        duration_sec: String(targetShotList.length * 4),
        video_prompt: shotTasks[0]?.video_prompt || `Multi-shot video prompt for ${product.name}`,
        audio_layer: '多镜头卡点音轨与沉浸过渡音效',
        negative_prompt: '避免镜头卡顿、跳帧或剧烈形变、竞品包装',
        isMultiShot: true,
        multiShotResult,
        migrationPlan,
        firstFrameSource: 'derived',
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

      // 首帧公网发布：本地 /uploads 路径通过 publishLocalAsset 上传到中继服务器，
      // 拿到 Seedance 可下载的公网 URL（优先中继 DEMO_PUBLIC_UPLOAD_URL，其次 PUBLIC_BASE_URL）。
      let publishedImageUrl = targetImageUrl;
      if (!targetImageUrl.startsWith('http://') && !targetImageUrl.startsWith('https://')) {
        const localAbsPath = resolveMediaPath(targetImageUrl);
        if (localAbsPath && fs.existsSync(localAbsPath)) {
          try {
            const published = await publishLocalAsset(localAbsPath);
            publishedImageUrl = published.publicUrl;
          } catch (pubErr: any) {
            data.seedanceStatus = 'submit_failed';
            data.seedanceError =
              `首帧图公网发布失败：${pubErr?.message || pubErr}。` +
              '请配置 DEMO_PUBLIC_UPLOAD_URL（中继服务器）或公网 PUBLIC_BASE_URL';
            data.seedanceHint = '配置中继服务器或公网域名后重新运行 Step2';
            return res.json({ success: true, data, source: `${gatewaySource}+seedance-relay` });
          }
        }
      } else if (targetImageUrl.startsWith('http://') || targetImageUrl.startsWith('https://')) {
        // 已是 http URL 但可能指向 localhost — 尝试解析本地文件并通过中继发布
        try {
          const u = new URL(targetImageUrl);
          if (
            u.hostname === 'localhost' || u.hostname === '127.0.0.1' ||
            u.hostname.startsWith('192.168.') || u.hostname.startsWith('10.')
          ) {
            const localAbsPath = resolveMediaPath(u.pathname);
            if (localAbsPath && fs.existsSync(localAbsPath)) {
              const published = await publishLocalAsset(localAbsPath);
              publishedImageUrl = published.publicUrl;
            }
          }
        } catch { /* 非本地 URL 或解析失败，保持原样 */ }
      }

      const prepared = buildSeedanceGenerationBody({
        prompt: data.video_prompt,
        model: modelId,
        duration: duration <= 5 ? 5 : 10,
        resolution: '720p',
        aspectRatio: '9:16',
        imageUrl: publishedImageUrl,
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
        // P5 二轮审查修复（P0-2）：旧 step2 路径不得再直接提交任意 targetImageUrl。
        // 首帧素材必须能在服务端核验为自有资产（product_assets / conditioned_first_frames /
        // shot 派生记录），否则拒绝提交（原视频帧/任意公网 URL 无法核验 → 拦截）。
        const ownerForCheck = (req.authUser?.id || inputs._ownerId || '') as string;
        const firstFrameKind = ownerForCheck ? resolveTrustedAssetKind(ownerForCheck, targetImageUrl) : null;
        if (!firstFrameKind) {
          data.seedanceStatus = 'submit_blocked_by_policy';
          data.seedanceError =
            '首帧素材无法在服务端核验为自有资产（必须来自产品资产表 / 系统派生的条件化首帧）。' +
            '原视频关键帧与任意公网 URL 不得直接提交视频生成 provider；请使用工作台流程提交';
          data.seedanceHint = '使用工作台（受信提交）或先录入产品资产';
          return res.json({ success: true, data, source: `${gatewaySource}+seedance-relay` });
        }
        // S1.4：提交前首帧可达性预检（对标 LibTV「自动校验素材」默认开关，SEEDANCE_PREFLIGHT=false 可关）
        if (process.env.SEEDANCE_PREFLIGHT !== 'false') {
          const preflight = await preflightMediaUrl(prepared.materials[0].url);
          if (!preflight.ok) {
            data.seedanceStatus = 'submit_failed';
            data.seedanceError =
              `首帧图预检失败（${preflight.error}）：Seedance 中转无法下载该素材。` +
              '请检查 PUBLIC_BASE_URL 是否公网可达、素材文件是否存在';
            data.seedanceHint = '配置 PUBLIC_BASE_URL 或改用公网素材后可重新运行 Step2 提交 Seedance';
            return res.json({ success: true, data, source: `${gatewaySource}+seedance-relay` });
          }
        }
        // P5 三轮收口：旧 step2 不再直接调用 Provider——创建受信 shot 行后统一走
        // claimAndSubmitCheckedShot（原子 claim + 来源/视觉安全复核 + 回写）。
        const ownerId = req.authUser?.id || inputs._ownerId;
        if (!ownerId) throw new Error('Seedance task owner is required');
        const step2ShotId = `step2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const step2SessionId = `step2-${Date.now()}`;
        db.prepare(
          `INSERT INTO shot_generation_tasks
             (id, session_id, owner_id, shot_index, status, video_prompt, first_frame_url)
           VALUES (?, ?, ?, 1, 'pending', ?, ?)`
        ).run(step2ShotId, step2SessionId, ownerId, data.video_prompt || 'product close-up', targetImageUrl);
        const { claimAndSubmitCheckedShot } = await import('../lib/submit-checked-shot');
        const checked = await claimAndSubmitCheckedShot(getVideoSubmissionPort(), {
          ownerId,
          sessionId: step2SessionId,
          shotId: step2ShotId,
          modelCode: modelId,
        });
        const task = checked.task;
        const submittedProvider = task.provider?.replace(/\+fallback$/, '') || 'seedance-relay';
        const fallbackUsed = Boolean(task.provider?.endsWith('+fallback'));
        data.seedanceTaskId = task.taskId;
        data.seedanceStatus = task.status;
        data.seedanceProvider = submittedProvider;
        data.seedanceFallbackUsed = fallbackUsed || undefined;
        data.previewVideoUrl = task.url || undefined;
        data.seedanceModel = prepared.modelId;

        // S1 成本账本：逐镜（shot）记录 provider/model/计费单位/估算成本。
        // 实际费用未知 → actualUsd 'unknown'（绝不写 0）；排队/生成时间为真实 provider
        // 语义，本端点只记录提交时刻，由轮询端点补充生成耗时。
        recordPipelineCost(
          {
            id: `cost-shot-${task.taskId || `no-task-${Date.now()}`}`,
            scope: 'shot',
            runId: typeof req.body?._runId === 'string' ? req.body._runId : undefined,
            shotId: task.taskId || undefined,
            provider: submittedProvider,
            model: prepared.modelId,
            modelVersion: prepared.modelId,
            queueMs: 'unknown',
            generationMs: 'unknown',
            retries: 0,
            billing: [{ unit: 'videos', amount: 1 }],
            estimatedUsd: 'unknown',
            actualUsd: 'unknown',
            source: 'estimate',
          },
          req.authUser?.id || 'system'
        );

        // S0 手工链路产物登记：生成的视频 URL 登记产品归属，
        // 切换产品后旧视频作为新产品的成片会被守卫 100% 阻断。
        try {
          const step2ProductId = inputs.productId || (productInfo as any)?.id;
          const step2Version = step2ProductId
            ? ((db.prepare('SELECT revision FROM products WHERE id = ?').get(step2ProductId) as
                | { revision: number | null }
                | undefined)?.revision ?? null)
            : null;
          registerGeneratedMedia(
            step2ProductId,
            step2Version,
            [data.previewVideoUrl],
            req.authUser?.id || 'system'
          );
        } catch (registerErr: any) {
          console.error('[Step2] generated media registration failed:', registerErr.message);
          return res.status(500).json({
            success: false,
            error: '视频已生成，但产品归属登记失败；为防止跨产品误发布，本次结果不可用，请重试',
            code: 'MEDIA_REGISTRATION_FAILED',
          });
        }

        return res.json({
          success: true,
          data,
          source: `${gatewaySource}+${fallbackUsed ? 'yunshu-fallback' : 'seedance-relay'}`,
          seedance: task,
        });
      }
    } catch (err: any) {
      console.warn('Seedance task submission warning:', err.message);
      data.seedanceStatus = 'submit_failed';
      data.seedanceError = friendlySeedanceError(err);
      if (err.warnings) data.seedanceMaterialWarning = (err.warnings as string[]).join('; ');
      // S1 成本账本：提交失败也记账（失败原因可追溯；provider/model 取当前配置）
      recordPipelineCost(
        {
          id: `cost-shot-failed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          scope: 'shot',
          runId: typeof req.body?._runId === 'string' ? req.body._runId : undefined,
          provider: hasSeedanceConfig() ? '星河中转/Seedance' : 'unknown',
          model: String(data.video_model || videoModel || 'seedance-2-0'),
          modelVersion: String(data.video_model || videoModel || 'seedance-2-0'),
          failureReason: 'provider_error',
          retries: 0,
          billing: [],
          estimatedUsd: 'unknown',
          actualUsd: 'unknown',
          source: 'estimate',
        },
        req.authUser?.id || 'system'
      );
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

// POST /api/pipeline/step2/submit-shot — 单镜 Seedance 提交（S1.3）
// step2 只持久化 pending 镜头；编排器逐镜调用本端点提交，每镜一个独立 HTTP 请求。
// 幂等：镜头已有有效 seedance_task_id（非 failed）时直接返回现状，避免重复扣费。
pipelineRouter.post('/step2/submit-shot', async (req, res) => {
  const { sessionId, shotIndex, model } = req.body || {};
  const ownerId = req.authUser?.id || req.body?._ownerId;
  const requestedRunId = typeof req.body?._runId === 'string' ? req.body._runId : undefined;
  const retryCount = Math.max(0, Number(req.body?._retryCount || 0));
  if (!sessionId || shotIndex === undefined) {
    return res.status(400).json({ success: false, error: '缺少 sessionId / shotIndex' });
  }
  if (!ownerId) {
    return res.status(401).json({ success: false, error: '缺少镜头所有者' });
  }
  const runId = requestedRunId
    ? (
        db.prepare('SELECT id FROM pipeline_runs WHERE id = ? AND owner_id = ?')
          .get(requestedRunId, ownerId) as { id: string } | undefined
      )?.id
    : undefined;
  if (requestedRunId && !runId) {
    return res.status(404).json({ success: false, error: '未找到归属于当前用户的流水线运行' });
  }
  // viral_recreation_v2 模式检测：run 的 directOutMode 声明（pipeline_runs.input_json）
  let viralRecreationV2 = false;
  if (runId) {
    try {
      const runRow = db
        .prepare('SELECT input_json FROM pipeline_runs WHERE id = ?')
        .get(runId) as { input_json?: string } | undefined;
      if (runRow?.input_json) {
        const parsed = JSON.parse(runRow.input_json);
        const mode =
          parsed?.directOutMode ||
          parsed?.pipelineData?.directOutMode ||
          parsed?.pipelineData?.mode ||
          '';
        viralRecreationV2 = mode === 'viral_recreation_v2';
      }
    } catch {
      viralRecreationV2 = false;
    }
  }
  try {
    const row = db.prepare(
      `SELECT * FROM shot_generation_tasks
        WHERE session_id = ? AND shot_index = ? AND owner_id = ?`
    ).get(sessionId, shotIndex, ownerId) as any;
    if (!row) {
      return res.status(404).json({ success: false, error: '未找到该镜头任务' });
    }
    if (runId && row.pipeline_run_id !== runId) {
      db.prepare(
        'UPDATE shot_generation_tasks SET pipeline_run_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
      ).run(runId, row.id);
      row.pipeline_run_id = runId;
    }

    const recordSubmissionFailure = (
      failureReason: CostEntry['failureReason'],
      provider = 'unknown'
    ) => {
      recordPipelineCost(
        {
          id: `cost-shot-failed-${row.id}-retry-${retryCount}`,
          scope: 'shot',
          runId: row.pipeline_run_id || runId,
          shotId: row.id,
          provider,
          model: String(model || 'doubao-seedance-2-0-fast'),
          modelVersion: String(model || 'doubao-seedance-2-0-fast'),
          retries: retryCount,
          failureReason,
          billing: [],
          estimatedUsd: 'unknown',
          actualUsd: 'unknown',
          source: 'estimate',
        },
        ownerId
      );
    };

    // 幂等：已提交且非失败状态直接返回现状
    if (row.seedance_task_id && row.status !== 'failed') {
      return res.json({
        success: true,
        data: {
          shotIndex,
          status: row.status,
          seedanceTaskId: row.seedance_task_id,
          video_url: row.video_url || undefined,
          error_message: row.error_message || undefined,
        },
      });
    }

    if (!hasSeedanceConfig()) {
      recordSubmissionFailure('provider_error');
      // 释放原子 claim（回到 failed，不产生 provider 调用）
      db.prepare(
        `UPDATE shot_generation_tasks SET status = 'failed', error_message = '未配置 Seedance 中转', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'submitting'`
      ).run(row.id);
      return res.status(503).json({
        success: false,
        error: '未配置 Seedance 中转（SEEDANCE_BASE_URL / ACCOUNT / PASSWORD），无法生成视频镜头',
      });
    }

    // ===== S3 首帧保障：派生（参考关键帧 + 产品图）+ 预检 =====
    // 用户不提供首帧；首帧是内部派生产物。预检不通过 → 不调用 Seedance。
    // 直接模式快捷路径：first_frame_url 已是公网 http URL（来自中继/材料发布），
    // 跳过派生+策略检查，直接提交 Seedance（demo 演示路径；AI 生图产物无风控风险）。
    let firstFrameUrl = row.first_frame_url || '';
    if (firstFrameUrl && (firstFrameUrl.startsWith('http://') || firstFrameUrl.startsWith('https://'))) {
      // 原子 claim：防止并发重复提交
      const claimed = db.prepare(
        `UPDATE shot_generation_tasks SET status = 'submitting', updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND (status = 'pending' OR status = 'failed')`
      ).run(row.id);
      if (claimed.changes === 0 && row.status !== 'submitting') {
        return res.json({ success: true, data: { shotIndex, status: row.status, seedanceTaskId: row.seedance_task_id } });
      }
      try {
        const port = getVideoSubmissionPort();
        const task = await port.submitShot({
          shotId: String(row.id),
          runId: sessionId,
          ownerId,
          sessionId,
          shotIndex: Number(row.shot_index),
          prompt: row.video_prompt || 'product close-up, smooth cinematic motion, high detail',
          modelCode: model || 'doubao-seedance-2-0-fast',
          modelCatalogId: model || 'Seedance 2.0 Fast',
          durationSec: 5,
          resolution: '720p',
          aspectRatio: '9:16',
          imageUrl: firstFrameUrl,
          firstFrameKind: 'generated_frame',
          referenceImageUrls: [],
          referencePolicy: { mode: 'semantic_recreation', images: [] },
          attempt: Number(retryCount || 0) + 1,
          failureReason: row.error_message || undefined,
        });
        if (!task.taskId) throw new Error('Seedance 未返回任务 ID');
        db.prepare(
          `UPDATE shot_generation_tasks
              SET status = 'generating', seedance_task_id = ?, first_frame_url = ?,
                  updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`
        ).run(String(task.taskId), firstFrameUrl, row.id);
        return res.json({
          success: true,
          data: { shotIndex, status: 'generating', seedanceTaskId: String(task.taskId) },
        });
      } catch (directErr: any) {
        db.prepare(
          `UPDATE shot_generation_tasks SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
        ).run(String(directErr?.message || directErr).slice(0, 500), row.id);
        throw directErr;
      }
    }
    const prepareFirstFrame = async () => {
      // 产品图：从 run 绑定的产品取真实 product assets（可公网或 /uploads）
      const runRow = row.pipeline_run_id
        ? (db.prepare('SELECT product_id FROM pipeline_runs WHERE id = ?').get(row.pipeline_run_id) as
            | { product_id: string | null }
            | undefined)
        : null;
      const productAssetsForShot: ProductAssetRef[] = runRow?.product_id
        ? resolveRunProductAssets({ productId: runRow.product_id })
        : [];
      const productContext = runRow?.product_id ? getProductContext(runRow.product_id) : null;
      if (viralRecreationV2) {
        // viral_recreation_v2：虚构人物控制图（纯生成，无 UGC 帧——P0 实测
        // 中转风控拦截 UGC 帧素材，纯生成虚构人物可过）
        const { ensureVirtualPersonShotFirstFrame } = await import('../lib/shot-first-frame');
        const outcome = await ensureVirtualPersonShotFirstFrame({
          ownerId,
          runId: row.pipeline_run_id || runId,
          sessionId,
          shotId: String(row.id),
          shotIndex: Number(row.shot_index),
          productAssetUrls: (productAssetsForShot.length > 0
            ? productAssetsForShot.map((a) => a.url)
            : []
          ).filter(Boolean) as string[],
          productName: productContext?.name || 'BUV 小绿泥洁面',
          shotStructure:
            row.video_prompt ||
            `shot ${row.shot_index} product close-up`,
          existingFirstFrameUrl: row.first_frame_url || null,
          persist: {
            ownerId,
            runId: row.pipeline_run_id || runId,
            sessionId,
            shotId: String(row.id),
            referenceVideoUrl: row.reference_video_url || null,
          },
        });
        firstFrameUrl = outcome.firstFrameUrl;
        persistShotFirstFrame(String(row.id), outcome);
        row.first_frame_url = firstFrameUrl;
        return;
      }
      const outcome = await ensureShotFirstFrame({
        ownerId,
        runId: row.pipeline_run_id || runId,
        sessionId,
        shotId: String(row.id),
        shotIndex: Number(row.shot_index),
        referenceKeyframeUrl: row.reference_keyframe_url || null,
        referenceVideoUrl: row.reference_video_url || null,
        productAssetUrls: (productAssetsForShot.length > 0
          ? productAssetsForShot.map((a) => a.url)
          : []
        ).filter(Boolean) as string[],
        productName: productContext?.name || 'BUV 小绿泥洁面',
        // 镜头结构：优先用运镜 prompt 的英文结构描述（含景别/运镜意图）
        shotStructure:
          row.video_prompt ||
          `shot ${row.shot_index} product close-up, ${row.reference_keyframe_url ? 'composition guided by reference keyframe' : ''}`,
        existingFirstFrameUrl: row.first_frame_url || null,
        persist: {
          ownerId,
          runId: row.pipeline_run_id || runId,
          sessionId,
          shotId: String(row.id),
          referenceVideoUrl: row.reference_video_url || null,
        },
      });
      firstFrameUrl = outcome.firstFrameUrl;
      persistShotFirstFrame(String(row.id), outcome);
      row.first_frame_url = firstFrameUrl;
    };

    // P5 二轮审查修复（P0-2）：不再把 row.reference_keyframe_url 直接追加为
    // reference_image——原视频关键帧只用于分析，绝不进入 Seedance body。
    // 提交统一走 submitCheckedShot（付费边界按 owner + URL 查库复核 provenance；
    // 首帧必须是可核验的本系统派生资产）。referenceMaterials 恒为空数组。
    const { submitCheckedShot } = await import('../lib/submit-checked-shot');
    const checked = await submitCheckedShot(getVideoSubmissionPort(), {
      ownerId,
      sessionId,
      shotId: String(row.id),
      modelCode: model || 'doubao-seedance-2-0-fast',
      attempt: Number(retryCount || 0) + 1,
      prepareFirstFrame,
    });
    const task = checked.task;
    if (checked.idempotent) {
      return res.json({
        success: true,
        data: {
          shotIndex,
          status: task.status === 'completed' ? 'completed' : 'generating',
          seedanceTaskId: String(task.taskId),
          video_url: task.url || undefined,
        },
      });
    }
    const submittedProvider = task.provider?.replace(/\+fallback$/, '') || 'seedance-relay';
    const fallbackUsed = Boolean(task.provider?.endsWith('+fallback'));

    const prepared = {
      modelId: 'doubao-seedance-2-0-fast',
      materials: [{ url: firstFrameUrl, kind: 'image', role: 'first_frame', label: 'derived_first_frame' }],
    };

    if (!task.taskId) {
      throw new Error('Seedance 未返回任务 ID');
    }
    registerSeedanceTaskOwner(String(task.taskId), ownerId, 'pipeline-multi-shot');

    const shotStatus = task.status === 'completed' ? 'completed' : 'generating';
    db.prepare(
      `UPDATE shot_generation_tasks
          SET status = ?, seedance_task_id = ?, video_url = ?, pipeline_run_id = ?, error_message = NULL,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`
    ).run(shotStatus, String(task.taskId), task.url || null, row.pipeline_run_id || runId || null, row.id);
    recordPipelineCost(
      {
        id: `cost-shot-${String(task.taskId)}`,
        scope: 'shot',
        runId: row.pipeline_run_id || runId,
        shotId: String(task.taskId),
        provider: submittedProvider,
        model: prepared.modelId,
        modelVersion: prepared.modelId,
        queueMs: 'unknown',
        generationMs: shotStatus === 'completed' ? 0 : 'unknown',
        retries: retryCount,
        billing: [{ unit: 'videos', amount: 1 }],
        estimatedUsd: 'unknown',
        actualUsd: 'unknown',
        source: 'estimate',
      },
      ownerId
    );
    if (fallbackUsed) {
      db.prepare(
        `UPDATE shot_generation_tasks SET error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
      ).run('已自动切换 yunshu 备用通道提交', row.id);
    }

    return res.json({
      success: true,
      data: {
        shotIndex,
        status: shotStatus,
        seedanceTaskId: String(task.taskId),
        video_url: task.url || undefined,
        error_message: undefined,
      },
    });
  } catch (err: any) {
    if (err?.name === 'SubmitConflictError' || err?.code === 'submit_conflict') {
      return res.status(409).json({ success: false, code: 'shot_busy', error: err.message });
    }
    if (
      err instanceof ShotFirstFrameError ||
      err?.name === 'ReferencePolicyViolationError' ||
      err?.name === 'VisualSafetyViolationError' ||
      err?.code === 'asset_safety_not_passed'
    ) {
      return res.status(422).json({ success: false, code: err.code, error: err.message });
    }
    console.warn(`[Step2 submit-shot] shot ${shotIndex} submission failed:`, err.message);
    const failedRow = db.prepare(
      `SELECT id, pipeline_run_id FROM shot_generation_tasks
        WHERE session_id = ? AND shot_index = ? AND owner_id = ?`
    ).get(sessionId, shotIndex, ownerId) as { id: string; pipeline_run_id: string | null } | undefined;
    if (failedRow) {
      recordPipelineCost(
        {
          id: `cost-shot-failed-${failedRow.id}-retry-${retryCount}`,
          scope: 'shot',
          runId: failedRow.pipeline_run_id || runId,
          shotId: failedRow.id,
          provider: hasSeedanceConfig() ? 'seedance' : 'unknown',
          model: String(model || 'doubao-seedance-2-0-fast'),
          modelVersion: String(model || 'doubao-seedance-2-0-fast'),
          retries: retryCount,
          failureReason: 'provider_error',
          billing: [],
          estimatedUsd: 'unknown',
          actualUsd: 'unknown',
          source: 'estimate',
        },
        ownerId
      );
      // 释放原子 claim（提交异常 → failed；已提交但任务号缺失属 AMBIGUOUS，
      // 由服务重启恢复逻辑兜底，不自动重提）
      db.prepare(
        `UPDATE shot_generation_tasks SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'submitting'`
      ).run(String(err?.message || 'provider_error').slice(0, 500), failedRow.id);
    }
    return res.status(502).json({
      success: false,
      error: friendlySeedanceError(err),
    });
  }
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
              updateShotCostOutcome({
                ownerId: req.authUser?.id || r.owner_id || 'system',
                shotId: r.seedance_task_id,
                generationMs: elapsedSinceSqliteTimestamp(r.updated_at),
                retries: r.qa_attempt || 0,
                failureReason: null,
              });
            } else if (normalized.status === 'failed' || normalized.status === 'error') {
              currentStatus = 'failed';
              currentError = normalized.error || 'Seedance 渲染失败';
              db.prepare('UPDATE shot_generation_tasks SET status = ?, error_message = ? WHERE id = ?')
                .run('failed', currentError, r.id);
              updateShotCostOutcome({
                ownerId: req.authUser?.id || r.owner_id || 'system',
                shotId: r.seedance_task_id,
                generationMs: elapsedSinceSqliteTimestamp(r.updated_at),
                retries: r.qa_attempt || 0,
                failureReason: 'provider_error',
              });
            }
          }
        } catch (err: any) {
          console.warn(`[shot-tasks poll] shot ${r.shot_index} error:`, err.message);
        }
      }

      // This polling endpoint must never trigger QA, retry a paid provider call,
      // or render a concat. Those state transitions belong to their explicit
      // POST endpoints so the user can see and authorize every operation.

      if (currentStatus === 'completed') {
        completedCount++;
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

    // GET is intentionally read-only. Rendering here used to let polling create
    // a concat artifact before semantic QA had completed, bypassing the final
    // quality gate. Only POST /concat-shots may create or update a final concat.

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
  const { sessionId, videoUrls, fullVideoPlan: requestedFullVideoPlan } = req.body || {};
  let targetUrls: string[] = videoUrls || [];
  const parsedFullVideoPlan = parseRequestedFullVideoPlan(requestedFullVideoPlan);
  if (parsedFullVideoPlan.error) {
    return res.status(400).json({
      success: false,
      code: 'full_video_plan_invalid',
      error: parsedFullVideoPlan.error,
    });
  }
  const fullVideoPlan = parsedFullVideoPlan.plan;

  // S3 最终质量门禁：合成前逐镜校验 QA 判决。
  // 只有全部镜头 QA pass 或对应镜头 manualPassed 才允许合成；
  // fail/unverified/warning/未QA 一律阻断并返回可读原因。
  if (!sessionId) {
    return res.status(409).json({
      success: false,
      error: '缺少 sessionId：最终合成必须归属镜头会话，无法校验镜头 QA 门禁',
      code: 'composite_gate_session_required',
    });
  }
  const gate = evaluateFinalCompositeGate({
    sessionId,
    ownerId: req.authUser?.id,
    isAdmin: req.authUser?.role === 'admin',
  });
  if (!gate.canCompose) {
    return res.status(409).json({
      success: false,
      error: `最终合成被质量门禁阻断：${gate.reasons.join('；')}`,
      code: 'composite_gate_blocked',
      data: { gate },
    });
  }

  if (fullVideoPlan) {
    // A complete visual plan owns the order.  Do not let a caller omit or
    // rearrange completed URLs and still claim a narrative-quality final video.
    const plannedRows = req.authUser && req.authUser.role !== 'admin'
      ? db.prepare(
          `SELECT shot_index, video_url FROM shot_generation_tasks
            WHERE session_id = ? AND owner_id = ? AND status = 'completed'
            ORDER BY shot_index ASC`
        ).all(sessionId, req.authUser.id) as Array<{ shot_index: number; video_url: string | null }>
      : db.prepare(
          `SELECT shot_index, video_url FROM shot_generation_tasks
            WHERE session_id = ? AND status = 'completed'
            ORDER BY shot_index ASC`
        ).all(sessionId) as Array<{ shot_index: number; video_url: string | null }>;
    if (plannedRows.length !== fullVideoPlan.shots.length) {
      return res.status(409).json({
        success: false,
        code: 'full_video_plan_artifacts_missing',
        error: `完整成片计划要求 ${fullVideoPlan.shots.length} 个镜头，但当前只有 ${plannedRows.length} 个已完成片段`,
      });
    }
    const expectedIndexes = fullVideoPlan.shots.map((shot) => shot.shotIndex);
    const actualIndexes = plannedRows.map((row) => Number(row.shot_index));
    if (expectedIndexes.join(',') !== actualIndexes.join(',')) {
      return res.status(409).json({
        success: false,
        code: 'full_video_plan_order_mismatch',
        error: `已完成片段顺序 ${actualIndexes.join(',')} 与计划顺序 ${expectedIndexes.join(',')} 不一致`,
      });
    }
    targetUrls = plannedRows.map((row) => String(row.video_url || '')).filter(Boolean);
  } else if ((!targetUrls || targetUrls.length === 0) && sessionId) {
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
      ...(fullVideoPlan ? { fullVideoPlan } : {}),
      ownerId: req.authUser?.id || req.body?._ownerId,
      isAdmin: req.authUser?.role === 'admin',
    });

    if (!renderRes.success || !renderRes.data) {
      return res.status(500).json({ success: false, error: renderRes.error || '多片段 FFmpeg 拼接失败' });
    }

    // A concat becomes the session's final artifact only after the QA-gated POST
    // succeeds. Keep its state durable so polling and Step5 never surface a
    // pre-QA preview as the final video.
    const concatOwnerId = req.authUser?.id || req.body?._ownerId;
    const concatUpdate = req.authUser?.role === 'admin'
      ? db.prepare(
          `UPDATE shot_generation_tasks
              SET concat_status = 'completed', concatenated_video_url = ?, updated_at = CURRENT_TIMESTAMP
            WHERE session_id = ?`
        )
      : db.prepare(
          `UPDATE shot_generation_tasks
              SET concat_status = 'completed', concatenated_video_url = ?, updated_at = CURRENT_TIMESTAMP
            WHERE session_id = ? AND owner_id = ?`
        );
    if (req.authUser?.role === 'admin') {
      concatUpdate.run(renderRes.data.videoUrl, sessionId);
    } else {
      concatUpdate.run(renderRes.data.videoUrl, sessionId, concatOwnerId);
    }

    return res.json({
      success: true,
      data: {
        concatenatedVideoUrl: renderRes.data.videoUrl,
        downloadUrl: renderRes.data.downloadUrl,
        renderEngine: renderRes.data.renderEngine,
        timeline: renderRes.data.timeline,
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
    durationSec: requestedDurationSec = null,
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

  // S3 最终质量门禁（Step5 侧）：多镜头会话必须在 concat 门禁通过后由 concat 产物进入成片。
  // 若请求仍携带镜头会话（sessionId 或 step2Output.multiShotResult.sessionId），
  // 在此再次校验 QA 判决——fail/unverified/未人工通过 的镜头禁止进入成片渲染。
  const sessionIdForGate =
    inputs.sessionId ||
    step2Output?.multiShotResult?.sessionId ||
    pipelineData?.step2?.output?.multiShotResult?.sessionId ||
    null;
  if (sessionIdForGate) {
    const gate = evaluateFinalCompositeGate({
      sessionId: String(sessionIdForGate),
      ownerId: req.authUser?.id,
      isAdmin: req.authUser?.role === 'admin',
    });
    if (!gate.canCompose) {
      return res.status(409).json({
        success: false,
        error: `成片渲染被质量门禁阻断：${gate.reasons.join('；')}`,
        code: 'composite_gate_blocked',
        data: { gate },
      });
    }
  }

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

  // S0 产品上下文守卫：旧产品/stale/旧版本产物禁止发布（切换产品或编辑产品后 100% 阻断）
  const requestedProductId = productId || (productInfo as any)?.id;
  const currentRevision = requestedProductId
    ? ((db.prepare('SELECT revision FROM products WHERE id = ?').get(requestedProductId) as
        | { revision: number | null }
        | undefined)?.revision ?? null)
    : null;
  const currentProductVersion = currentRevision == null ? null : String(currentRevision);
  const contextVerdict = assertPublishableVideoContext(
    requestedProductId,
    [...(Array.isArray(rawVideoClips) ? rawVideoClips : []), resolvedVideo],
    currentProductVersion,
    req.authUser?.id || 'system'
  );
  if (contextVerdict.ok === false) {
    return res.status(409).json({
      success: false,
      error: contextVerdict.reason,
      code: contextVerdict.code,
      source: 'context-guard',
      data: {
        artifactId: contextVerdict.artifactId,
        artifactProductId: contextVerdict.artifactProductId,
        productId: requestedProductId,
      },
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

  if (subtitleStyle !== 'none' && Array.isArray(shotList) && shotList.length > 0) {
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
  } else if (subtitleStyle !== 'none') {
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

  // A pre-composed multi-shot source already has its real timeline.  Callers
  // such as the full-video planner may provide that duration explicitly; do
  // not silently truncate the result to the legacy four-second subtitle
  // fallback when no narration track is present yet.
  const explicitDurationSec = Number(requestedDurationSec);
  const durationSec = Number.isFinite(explicitDurationSec) && explicitDurationSec > 0
    ? explicitDurationSec
    : renderSubtitles.length > 0
      ? Math.max(...renderSubtitles.map((s) => s.endSec || 4), 4)
      : 4;

  const renderStartedAt = Date.now();
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
    // S1 成本账本：渲染失败记账（失败原因可追溯）
    recordPipelineCost(
      {
        id: `cost-render-failed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        scope: 'run',
        runId: typeof (inputs as any)?._runId === 'string'
          ? String((inputs as any)._runId)
          : typeof (inputs as any)?.sessionId === 'string'
            ? String((inputs as any).sessionId)
            : undefined,
        provider: 'local-ffmpeg',
        model: 'ffmpeg',
        failureReason: 'render_failed',
        retries: 0,
        billing: [],
        estimatedUsd: 'unknown',
        actualUsd: 'unknown',
        source: 'ledger',
      },
      req.authUser?.id || 'system'
    );
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
  // S1 成本账本：成片合成（本地 ffmpeg，无 provider 计费 → 成本 unknown；耗时实测）
  recordPipelineCost(
    {
      id: `cost-render-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      scope: 'run',
      runId: typeof (inputs as any)?._runId === 'string'
        ? String((inputs as any)._runId)
        : typeof (inputs as any)?.sessionId === 'string'
          ? String((inputs as any).sessionId)
          : undefined,
      provider: 'local-ffmpeg',
      model: 'ffmpeg',
      generationMs: Date.now() - renderStartedAt,
      retries: 0,
      billing: [],
      estimatedUsd: 'unknown',
      actualUsd: 'unknown',
      source: 'ledger',
    },
    req.authUser?.id || 'system'
  );
  const responseSource = renderResult.source || 'ffmpeg';
  // S0 provenance：product_conditioned 声明必须由**服务端可验证的证据**支撑
  // （product_assets 登记的真实产品资产，或可追溯来源中绑定该产品的未过期产物）。
  // 客户端提交的 firstFrameEvidenceUrl 字段一律不信任 —— 任意非空字符串不得换取确定性评分。
  const claimedFirstFrameSource =
    inputs.firstFrameSource ||
    step2Output?.firstFrameSource ||
    pipelineData?.step2?.output?.firstFrameSource ||
    undefined;
  const claimedEvidenceUrls = [
    inputs.firstFrameEvidenceUrl,
    step2Output?.firstFrameEvidenceUrl,
    step2Output?.productHeroFrameUrl,
    pipelineData?.step2?.output?.productHeroFrameUrl,
  ];
  const trustedEvidence = claimedEvidenceUrls.find((url) =>
    isTrustedFirstFrameEvidence(requestedProductId, url, req.authUser?.id || 'system')
  );
  const firstFrameSource = resolveFirstFrameSource(
    claimedFirstFrameSource,
    trustedEvidence ? [trustedEvidence] : []
  );
  // S0 手工链路产物登记：本次渲染使用的视频源与成片统一登记，
  // 切换产品后这些 URL 会被守卫追溯并 100% 阻断。
  try {
    registerGeneratedMedia(
      requestedProductId,
      currentProductVersion,
      [
        resolvedVideo,
        ...(Array.isArray(rawVideoClips) ? rawVideoClips : []),
        out.videoUrl,
        out.downloadUrl,
      ],
      req.authUser?.id || 'system'
    );
  } catch (registerErr: any) {
    console.error('[Step5] generated media registration failed:', registerErr.message);
    return res.status(500).json({
      success: false,
      error: '成片已生成，但产品归属登记失败；为防止跨产品误发布，本次结果不可用，请重试',
      code: 'MEDIA_REGISTRATION_FAILED',
    });
  }

  const qa = await qaShotVideo(out.videoUrl || '');
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
    qaReport: qa,
    evidence: { qaShot: qa, firstFrameSource, firstFrameEvidenceUrl: trustedEvidence ?? undefined },
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
