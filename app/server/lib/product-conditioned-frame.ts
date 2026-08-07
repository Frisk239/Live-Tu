/**
 * S3 产品条件化首帧深模块（product-conditioned first frame）
 *
 * 输入：条件化锚点（构图基座，须为策略放行资产——产品图/我方生成帧/自有场景锚点/
 *       品牌自有虚拟人物）+ 产品图（包装/颜色/Logo）+ 镜头结构描述
 * 输出：公网可下载的条件化首帧 + 完整 provenance（referenceVideoUrl / referenceKeyframeUrl /
 *       productAssetUrls / conditionedFirstFrameUrl / provider / model / prompt / version）
 *
 * 规则（不可违背）：
 * 1. 首帧必须同时利用参考锚点（构图、主体位置、景别、动作意图）与产品图
 *    （包装、颜色、Logo、形状）——通过云雾 /images/edits 多图编辑真实条件生成；
 * 2. 不允许把产品主图直接冒充条件化首帧；
 * 3. 不允许只在 prompt 里写产品名称（必须传真实产品图作为参考图）；
 * 4. provider 不支持时抛 product_conditioning_provider_unavailable（能力门禁），
 *    绝不静默退化为随机图 / 纯文本生图 / 直接产品主图；
 * 5. 生成结果缓存到本地后，必须转换成星河可下载的公网 URL（asset-publisher）；
 * 6. P5 强制出口 1：/images/edits 的参考图列表在构建时执行 ReferenceInputPolicy
 *    （默认 semantic_recreation）——原视频关键帧、含人脸/字幕/水印/竞品的资产
 *    不得进入本 provider 请求。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { callImageGenerationGateway } from './llm-gateway';
import {
  getImageConditioningCapability,
  ImageConditioningUnavailableError,
  type ImageConditioningCapability,
} from './image-conditioning-capability';
import { publishLocalAsset } from './asset-publisher';
import { db } from './db';
import { evaluateVisualSafety, recordVisualSafety, requireVisualSafetyPass, sha256OfLocalFile } from './visual-safety';
import {
  type DeclaredReferenceImage,
  type ReferencePolicyOptions,
  assertReferenceImagesAllowed,
  productShotDeclaration,
  sourceKeyframeDeclaration,
} from '../adapters/reference-policy-guard';
import type { ReferenceAssetKind, ReferenceInputMode } from '../domain/reference-policy/reference-input-policy';

export const CONDITIONED_FRAME_PROMPT_VERSION = 'v1.1.0';

export interface ProductConditionedFrameInput {
  /** 条件化锚点（构图基座）——/uploads 或公网 http(s) */
  referenceKeyframeUrl: string;
  /** 自有产品图列表（包装/颜色/Logo/形状参考） */
  productAssetUrls: string[];
  productName: string;
  /** 镜头结构描述：景别、主体位置、动作意图（如「极近特写面部，双手涂抹泡沫于双颊」） */
  shotStructure: string;
  visualConstraints?: string[];
  /** 图像模型 ID（默认取目录默认图像模型） */
  modelId?: string;
  size?: string;
  /**
   * P5 参考输入策略（强制出口 1）：构建 /images/edits payload 前强制执行
   * ReferenceInputPolicy。默认 semantic_recreation——原视频关键帧（source_keyframe）
   * 不得进入图像生成 provider 请求；传入的锚点必须是产品图/我方生成帧/自有场景锚点/
   * 品牌自有虚拟人物（身份与原视频无关）。
   */
  referencePolicy?: {
    mode?: ReferenceInputMode;
    /** 参考图声明（缺省时自动声明：referenceKeyframeUrl → source_keyframe，productAssetUrls → product_shot） */
    images?: DeclaredReferenceImage[];
  };
  /** provenance 持久化上下文（可选；提供时写入 conditioned_first_frames 表） */
  persist?: {
    runId?: string | null;
    sessionId?: string | null;
    shotId?: string | null;
    ownerId: string;
    referenceVideoUrl?: string | null;
  };
}

export interface ConditionedFrameProvenance {
  referenceVideoUrl: string | null;
  referenceKeyframeUrl: string;
  productAssetUrls: string[];
  conditionedFirstFrameUrl: string;
  provider: string;
  model: string;
  prompt: string;
  promptVersion: string;
  generatedAt: number;
}

export interface ProductConditionedFrameResult {
  /** 公网 URL（星河可下载） */
  imageUrl: string;
  /** 本地缓存路径 */
  localPath: string;
  provider: string;
  model: string;
  provenance: ConditionedFrameProvenance;
  /** 预检前为 null；预检通过后写入 0..1 */
  confidence: number | null;
  capability: ImageConditioningCapability;
}

/** 构造条件化 prompt：构图保真（参考帧）+ 包装保真（产品图） */
export function buildConditionedFramePrompt(input: {
  productName: string;
  shotStructure: string;
  visualConstraints?: string[];
  /** What the first allowed reference image actually represents. */
  referenceAnchorKind?: ReferenceAssetKind | null;
}): string {
  const constraints = [
    ...(input.visualConstraints ?? []),
    'No other brands, no competitor logos, no other product packaging',
    'Create a new commercial image; do not reproduce any source-video subtitle, watermark, QR code, username, UI element, tattoo, distinctive person, or face',
    'No human hands, fingers, arms, skin, face, torso, silhouette, or any other body part; do not render a hand-held product pose',
    'The product, nozzle, foam, ceramic surface, and simple props must carry the action without human interaction',
    '9:16 vertical composition',
  ].filter(Boolean);
  const anchorInstruction = input.referenceAnchorKind === 'product_shot'
    ? 'The allowed reference is a product identity image, not a scene reference. Build a completely new scene from the shot structure below; do not reuse the product-photo background, crop, or pose as the commercial composition.'
    : input.referenceAnchorKind === 'generated_frame' || input.referenceAnchorKind === 'owned_scene_anchor'
      ? 'Use the allowed scene anchor only for its safe composition, shot size, camera angle, lighting, and pacing. Do not copy any source identity, subtitle, watermark, or unrelated brand.'
      : 'Use only the allowed inputs as safe references. Build the commercial composition from the shot structure below, never from an untrusted source-video frame.';
  return [
    anchorInstruction,
    `Use the supplied product asset(s) as the only product identity source for ${input.productName}.`,
    'The product must retain the supplied packaging geometry, color, material, logo, and label layout; do not invent a different package.',
    `Scene and shot structure: ${input.shotStructure}`,
    `Constraints: ${constraints.join('; ')}`,
    'Commercial product photography, high detail, realistic lighting. Product-only tabletop/macros; zero visible human anatomy, even if the reference frame contains a hand.',
  ].join('\n');
}

/** 把 data URL 缓存到 uploads/renders，返回本地路径 */
export function cacheConditionedFrameToLocal(dataUrl: string): string {
  const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
  if (!match) {
    const err = new Error('条件化首帧结果不是可解析的 data URL') as Error & { code?: string };
    err.code = 'conditioned_frame_cache_failed';
    throw err;
  }
  const uploadsRoot = path.resolve(process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads'));
  const rendersDir = path.join(uploadsRoot, 'renders');
  fs.mkdirSync(rendersDir, { recursive: true });
  const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
  const filename = `conditioned_first_frame_${Date.now()}_${randomUUID().slice(0, 8)}.${ext}`;
  const localPath = path.join(rendersDir, filename);
  fs.writeFileSync(localPath, Buffer.from(match[2], 'base64'));
  return localPath;
}

/**
 * 构建 /images/edits 的参考图列表（纯函数，出口 1 的 payload 构建 + 策略强制点）。
 * 顺序：锚点（构图基座）首图 + 产品图（包装参考）。
 * 违规（如把原视频关键帧当锚点）→ 抛 ReferencePolicyViolationError，不发起任何调用。
 */
export function resolveConditioningReferenceImages(input: {
  referenceKeyframeUrl: string;
  productAssetUrls: string[];
  referencePolicy?: ProductConditionedFrameInput['referencePolicy'];
}): string[] {
  const images = input.referencePolicy?.images ?? [
    sourceKeyframeDeclaration(input.referenceKeyframeUrl),
    ...input.productAssetUrls.map((url, index) => productShotDeclaration(url, index)),
  ];
  assertReferenceImagesAllowed(images, {
    mode: input.referencePolicy?.mode ?? 'semantic_recreation',
  });
  // A semantic-recreation plan often uses the product hero as both its safe
  // anchor and its product identity asset. Send it once: duplicate copies do
  // not add conditioning signal and make the image editor overfit to the
  // uploaded product-photo crop instead of the requested shot structure.
  return [...new Set(images.map((image) => image.url))];
}

/**
 * 生成产品条件化首帧（深模块主入口）。
 * 失败语义：
 * - 参考输入违反 ReferenceInputPolicy → ReferencePolicyViolationError（请求前硬性阻断）
 * - provider 不支持 → ImageConditioningUnavailableError（code=product_conditioning_provider_unavailable）
 * - 结果无法转公网 URL → 抛 asset_publication_unavailable
 * - provider 调用失败 → 抛带原因错误（由调用方决定重试/更换参考）
 */
export async function createProductConditionedFirstFrame(
  input: ProductConditionedFrameInput
): Promise<ProductConditionedFrameResult> {
  if (!input.referenceKeyframeUrl) {
    throw new Error('缺少 referenceKeyframeUrl：条件化首帧必须基于参考锚点生成');
  }
  if (!Array.isArray(input.productAssetUrls) || input.productAssetUrls.length === 0) {
    const err = new Error('缺少 productAssetUrls：条件化首帧必须携带真实产品图（禁止纯文本生图）') as Error & { code?: string };
    err.code = 'product_conditioning_provider_unavailable';
    throw err;
  }

  // 0) P5 强制出口 1：策略先于能力门禁与付费调用——参考输入违规直接拒绝，
  //    不发任何 provider 请求（含原视频关键帧/含人脸资产在 semantic_recreation
  //    下必然在此被拦截）。
  const referenceImages = resolveConditioningReferenceImages(input);

  // 1) 能力门禁（显式失败，禁止静默降级）
  const capability = getImageConditioningCapability({ modelId: input.modelId });
  if (!capability.supported) {
    throw new ImageConditioningUnavailableError(capability);
  }
  if (!input.persist?.ownerId) {
    const err = new Error('conditioned first frame requires persisted owner provenance before image generation') as Error & { code?: string };
    err.code = 'conditioned_frame_persistence_required';
    throw err;
  }
  for (const url of referenceImages) {
    requireVisualSafetyPass(input.persist.ownerId, url, 'conditioning-reference');
  }

  // E2E 确定性通道（与 FAKE_TECH_QA / FAKE_VISUAL_SAFETY_PASS 同纪律）：
  // FAKE_FIRST_FRAME_DERIVE=true 时，用产品图字节派生一张确定性条件化首帧——
  // 不调用任何图像 provider，但 provenance 登记、hash 绑定视觉安全评估与
  // 提交边界强制全部走真实链路（conditioned_first_frames 行 + safety pass +
  // 本地文件 hash 一致性校验）。生产/真实 demo 不设置该变量，不走此路径。
  if (process.env.FAKE_FIRST_FRAME_DERIVE === 'true') {
    return deriveFakeConditionedFirstFrame(input);
  }

  // 2) 条件化生成：锚点（构图基座，首图）+ 产品图（包装参考，后续图）
  const prompt = buildConditionedFramePrompt({
    productName: input.productName,
    shotStructure: input.shotStructure,
    visualConstraints: input.visualConstraints,
    referenceAnchorKind: input.referencePolicy?.images?.find((image) => image.id === 'conditioning-anchor')?.kind ?? null,
  });
  const gatewayRes = await callImageGenerationGateway({
    prompt,
    modelId: input.modelId,
    size: input.size || '1024x1536',
    referenceImages,
  });
  if (!gatewayRes.success || !gatewayRes.imageUrl) {
    const err = new Error(
      gatewayRes.error?.includes('product_conditioning_provider_unavailable')
        ? gatewayRes.error
        : `条件化首帧生成失败：${gatewayRes.error || 'provider 未返回图片'}`
    ) as Error & { code?: string };
    if (gatewayRes.error?.includes('product_conditioning_provider_unavailable')) {
      err.code = 'product_conditioning_provider_unavailable';
    } else {
      err.code = 'conditioned_frame_generation_failed';
    }
    throw err;
  }

  // 3) 本地缓存（星河需要公网 URL，但本地路径供 QA/审计/复用）
  let localPath: string;
  try {
    localPath = cacheConditionedFrameToLocal(gatewayRes.imageUrl);
  } catch (e: any) {
    throw e;
  }

  // 4) 转公网 URL（asset-publisher：PUBLIC_BASE_URL / DEMO_ASSET_PUBLISHER）
  let published: Awaited<ReturnType<typeof publishLocalAsset>>;
  try {
    published = await publishLocalAsset(localPath);
  } catch (e: any) {
    // 本地产物保留（供 QA 对比），但首帧不可被星河下载 → 预检必失败，明确抛错
    throw e;
  }

  const provenance: ConditionedFrameProvenance = {
    referenceVideoUrl: input.persist?.referenceVideoUrl ?? null,
    referenceKeyframeUrl: input.referenceKeyframeUrl,
    productAssetUrls: [...input.productAssetUrls],
    conditionedFirstFrameUrl: published.publicUrl,
    provider: gatewayRes.source === 'yunwu' ? '云雾(yunwu-relay)' : 'direct',
    model: gatewayRes.modelUsed,
    prompt,
    promptVersion: CONDITIONED_FRAME_PROMPT_VERSION,
    generatedAt: Date.now(),
  };

  // 5) provenance 持久化（可选；demo/工作台提供上下文时写入）+ 服务端视觉安全评估
  //    （P5 三轮：派生首帧同样必须通过视觉核验才能进入付费提交——评估结果写入
  //    conditioned_first_frames.safety_*；LLM 不可用 → unverified → 提交边界拒绝）
  if (input.persist) {
    try {
      db.prepare(
        `INSERT INTO conditioned_first_frames
           (id, run_id, session_id, shot_id, owner_id, reference_video_url, reference_keyframe_url,
            product_asset_urls_json, conditioned_first_frame_url, local_path, provider, model,
            prompt_version, prompt, confidence, preflight_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', CURRENT_TIMESTAMP)`
      ).run(
        `cff-${Date.now()}-${randomUUID().slice(0, 8)}`,
        input.persist.runId ?? null,
        input.persist.sessionId ?? null,
        input.persist.shotId ?? null,
        input.persist.ownerId,
        input.persist.referenceVideoUrl ?? null,
        input.referenceKeyframeUrl,
        JSON.stringify(input.productAssetUrls),
        published.publicUrl,
        localPath,
        provenance.provider,
        gatewayRes.modelUsed,
        CONDITIONED_FRAME_PROMPT_VERSION,
        prompt.slice(0, 3000)
      );
      // 视觉安全评估（同步：派生首帧必须拿到 pass 才能进入付费提交；
      // LLM 不可用 → unverified → 提交边界拒绝——严格语义，不假装安全）
      const assessment = await evaluateVisualSafety(published.publicUrl, { sha256: published.sha256 });
      try {
        recordVisualSafety(input.persist.ownerId, published.publicUrl, assessment);
      } catch (e: any) {
        console.warn('[product-conditioned-frame] 视觉安全记录失败:', e?.message || e);
      }
    } catch (e: any) {
      console.warn('[product-conditioned-frame] provenance 持久化失败:', e?.message || e);
    }
  }

  // The result cannot escape this boundary unless the just-persisted assessment
  // is both a pass and bound to the bytes that were published.
  requireVisualSafetyPass(input.persist.ownerId, published.publicUrl, 'conditioned-first-frame');

  return {
    imageUrl: published.publicUrl,
    localPath,
    provider: provenance.provider,
    model: gatewayRes.modelUsed,
    provenance,
    confidence: null,
    capability,
  };
}

/**
 * E2E 确定性派生（FAKE_FIRST_FRAME_DERIVE=true 专用）：
 * 从产品图字节复制出一张条件化首帧，走与真实派生完全相同的 provenance 登记 +
 * hash 绑定视觉安全评估 + 提交边界强制。唯一被替代的是「图像 provider 调用」。
 * 产品图必须已通过 requireVisualSafetyPass（hash 绑定），否则这里同样拒绝。
 */
async function deriveFakeConditionedFirstFrame(
  input: ProductConditionedFrameInput
): Promise<ProductConditionedFrameResult> {
  const ownerId = input.persist!.ownerId;
  const productUrl = input.productAssetUrls[0];
  const uploadsRoot = path.resolve(process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads'));

  // 解析产品图本地字节（product_assets.file_path 或 /uploads/ 相对路径）
  const assetRow = db
    .prepare('SELECT file_path FROM product_assets WHERE owner_id = ? AND url = ? LIMIT 1')
    .get(ownerId, productUrl) as { file_path?: string } | undefined;
  const srcLocal = assetRow?.file_path
    ? path.resolve(uploadsRoot, String(assetRow.file_path).replace(/^uploads[/\\]?/, ''))
    : productUrl.startsWith('/uploads/')
      ? path.resolve(uploadsRoot, productUrl.slice('/uploads/'.length))
      : null;
  if (!srcLocal || !fs.existsSync(srcLocal)) {
    const err = new Error(
      `FAKE_FIRST_FRAME_DERIVE：产品图（${productUrl.slice(0, 120)}）无本地文件，无法完成 hash 绑定的确定性派生`
    ) as Error & { code?: string };
    err.code = 'first_frame_derivation_context_missing';
    throw err;
  }

  // 复制字节 → 条件化首帧产物（与真实派生同目录）
  const rendersDir = path.join(uploadsRoot, 'renders');
  fs.mkdirSync(rendersDir, { recursive: true });
  const ext = path.extname(srcLocal) || '.png';
  const filename = `conditioned_first_frame_fake_${Date.now()}_${randomUUID().slice(0, 8)}${ext}`;
  const localPath = path.join(rendersDir, filename);
  fs.copyFileSync(srcLocal, localPath);
  const sha256 = sha256OfLocalFile(localPath);
  if (!sha256) {
    const err = new Error('FAKE_FIRST_FRAME_DERIVE：无法计算条件化首帧的 SHA-256，拒绝登记') as Error & { code?: string };
    err.code = 'conditioned_frame_cache_failed';
    throw err;
  }
  const publicUrl = `/uploads/renders/${filename}`;

  const prompt = buildConditionedFramePrompt({
    productName: input.productName,
    shotStructure: input.shotStructure,
    visualConstraints: input.visualConstraints,
    referenceAnchorKind: input.referencePolicy?.images?.find((image) => image.id === 'conditioning-anchor')?.kind ?? null,
  });
  const provenance: ConditionedFrameProvenance = {
    referenceVideoUrl: input.persist?.referenceVideoUrl ?? null,
    referenceKeyframeUrl: input.referenceKeyframeUrl,
    productAssetUrls: [...input.productAssetUrls],
    conditionedFirstFrameUrl: publicUrl,
    provider: 'fake-first-frame-derive',
    model: 'fake-image-conditioning',
    prompt,
    promptVersion: CONDITIONED_FRAME_PROMPT_VERSION,
    generatedAt: Date.now(),
  };

  // 真实 provenance 登记 + hash 绑定视觉安全评估（FAKE_VISUAL_SAFETY_PASS 只对
  // 携带 sha256 的资产给 pass；此处 sha256 来自真实文件字节）
  db.prepare(
    `INSERT INTO conditioned_first_frames
       (id, run_id, session_id, shot_id, owner_id, reference_video_url, reference_keyframe_url,
        product_asset_urls_json, conditioned_first_frame_url, local_path, provider, model,
        prompt_version, prompt, confidence, preflight_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', CURRENT_TIMESTAMP)`
  ).run(
    `cff-fake-${Date.now()}-${randomUUID().slice(0, 8)}`,
    input.persist?.runId ?? null,
    input.persist?.sessionId ?? null,
    input.persist?.shotId ?? null,
    ownerId,
    input.persist?.referenceVideoUrl ?? null,
    input.referenceKeyframeUrl,
    JSON.stringify(input.productAssetUrls),
    publicUrl,
    localPath,
    provenance.provider,
    provenance.model,
    CONDITIONED_FRAME_PROMPT_VERSION,
    prompt.slice(0, 3000)
  );
  const assessment = await evaluateVisualSafety(publicUrl, { sha256 });
  recordVisualSafety(ownerId, publicUrl, assessment);
  // 提交边界强制：pass + sha256 + 本地文件 hash 一致性全部真实校验
  requireVisualSafetyPass(ownerId, publicUrl, 'conditioned-first-frame');

  return {
    imageUrl: publicUrl,
    localPath,
    provider: provenance.provider,
    model: provenance.model,
    provenance,
    confidence: null,
    capability: {
      supported: true,
      mechanism: 'edits_multipart',
      modelId: null,
      modelCode: 'fake-image-conditioning',
      evidence: 'FAKE_FIRST_FRAME_DERIVE（E2E 确定性派生，非真实图像 provider）',
      probedAt: null,
    },
  };
}
