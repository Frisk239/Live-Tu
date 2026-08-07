/**
 * viral-control-image — P0 产品控制图（人物保留版）。
 *
 * 与现有 product-conditioned-frame 的差异：
 * - 现有链路是 semantic_recreation 无人物安全代理（禁止任何人脸/手/身体）；
 * - P0 素材为已授权公司素材（公司模特、动作、场景、运镜允许保留），
 *   只替换源产品、移除源字幕/水印/文字层；
 * - 因此使用 ReferenceInputPolicy 的 viral_recreation_v2 模式声明参考帧，
 *   锚点（参考子视频帧）经字幕预检后以 run_uploaded_reference_frame 声明进入
 *   /images/edits；产品图以 product_shot 声明。
 *
 * 失败语义：
 * - 参考输入违反策略 → ReferencePolicyViolationError（请求前硬性阻断）
 * - provider 不支持 → ImageConditioningUnavailableError（复用现有门禁）
 * - 结果无法转公网 → asset_publication_unavailable
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { callImageGenerationGateway } from './llm-gateway';
import { getImageConditioningCapability, ImageConditioningUnavailableError } from './image-conditioning-capability';
import { publishLocalAsset } from './asset-publisher';
import { db } from './db';
import { sha256OfLocalFile } from './visual-safety';
import { cacheConditionedFrameToLocal } from './product-conditioned-frame';
import {
  type DeclaredReferenceImage,
  assertReferenceImagesAllowed,
  productShotDeclaration,
  runUploadedReferenceFrameDeclaration,
} from '../adapters/reference-policy-guard';
import type { ReferenceInputMode } from '../domain/reference-policy/reference-input-policy';

export const VIRAL_CONTROL_IMAGE_PROMPT_VERSION = 'v1.0.0';
export const DE_TEXT_PROMPT_VERSION = 'v1';
export const VIRTUAL_PERSON_FRAME_VERSION = 'v1';

/**
 * 虚构人物控制图 prompt（pipeline viral_recreation_v2 首帧派生）：
 * - 人物必须是虚构数字形象（P0 实测：UGC 帧被中转风控拦截，纯生成虚构人物可过）；
 * - 只保留参考视频的镜头语义（景别/动作/构图），不引用任何 UGC 帧或真实人物形象；
 * - 产品包装参考产品图；画面无任何文字/字幕/水印。
 */
export function buildVirtualPersonFramePrompt(input: {
  productName: string;
  shotStructure: string;
  visualConstraints?: string[];
}): string {
  const constraints = [
    ...(input.visualConstraints ?? []),
    'All people in the image are fictional digital characters, not real persons, and not based on any real person or any source-video identity',
    'No other brands, no competitor logos, no other product packaging',
    'No text, letters, subtitles, captions, watermarks, QR codes, usernames, UI elements, or logos anywhere in the image',
    '9:16 vertical composition',
  ].filter(Boolean);
  return [
    `Create a fresh commercial shot for ${input.productName}: a fictional young woman presenter, clearly not any real person, in the shot structure below.`,
    'Preserve only the shot semantics (framing, action, camera language) — never reproduce any source-video person, subtitle, watermark, or scene identity.',
    'The product must match the supplied product asset: packaging geometry, color, material, logo and label layout.',
    `Scene and shot structure: ${input.shotStructure}`,
    `Constraints: ${constraints.join('; ')}`,
    'Commercial product photography, realistic lighting, vertical 9:16 composition.',
  ].join('\n');
}

/**
 * 生成虚构人物控制图（纯生成，无 UGC 帧参考）——pipeline viral_recreation_v2 首帧派生。
 * 产物登记 conditioned_first_frames（generated_frame 可信来源）+ viral_recreation_v2
 * 视觉安全评估（允许虚构人物，禁文字层）。返回公网 URL。
 */
export async function createVirtualPersonControlFrame(input: {
  ownerId: string;
  runId?: string | null;
  sessionId?: string | null;
  shotId?: string | null;
  shotIndex?: number;
  productAssetUrls: string[];
  productName: string;
  shotStructure: string;
  visualConstraints?: string[];
  modelId?: string;
  size?: string;
}): Promise<{
  imageUrl: string;
  localPath: string;
  provider: string;
  model: string;
  prompt: string;
  promptVersion: string;
}> {
  if (!Array.isArray(input.productAssetUrls) || input.productAssetUrls.length === 0) {
    const err = new Error('缺少 productAssetUrls：虚构人物控制图必须携带真实产品图（禁止纯文本生图）') as Error & { code?: string };
    err.code = 'product_conditioning_provider_unavailable';
    throw err;
  }
  const capability = getImageConditioningCapability({ modelId: input.modelId });
  if (!capability.supported) {
    throw new ImageConditioningUnavailableError(capability);
  }
  const prompt = buildVirtualPersonFramePrompt({
    productName: input.productName,
    shotStructure: input.shotStructure,
    visualConstraints: input.visualConstraints,
  });

  // E2E 确定性通道（FAKE_VIRAL_CONTROL_IMAGE=true 时复制产品图字节，不调用图像 provider）
  if (process.env.FAKE_VIRAL_CONTROL_IMAGE === 'true') {
    return deriveFakeViralControlImage(
      {
        referenceVideoUrl: '',
        referenceFrameUrl: '',
        productAssetUrls: input.productAssetUrls,
        productName: input.productName,
        shotStructure: input.shotStructure,
        visualConstraints: input.visualConstraints,
        subtitlePreflightPassed: true,
        persist: { runId: input.runId, ownerId: input.ownerId },
      },
      prompt,
      capability
    );
  }

  const gatewayRes = await callImageGenerationGateway({
    prompt,
    modelId: input.modelId,
    size: input.size || '1024x1536',
    referenceImages: input.productAssetUrls.map((url) => ({ url })),
  });
  if (!gatewayRes.success || !gatewayRes.imageUrl) {
    const err = new Error(
      gatewayRes.error?.includes('product_conditioning_provider_unavailable')
        ? gatewayRes.error
        : `虚构人物控制图生成失败：${gatewayRes.error || 'provider 未返回图片'}`
    ) as Error & { code?: string };
    err.code = gatewayRes.error?.includes('product_conditioning_provider_unavailable')
      ? 'product_conditioning_provider_unavailable'
      : 'virtual_person_frame_generation_failed';
    throw err;
  }
  const localPath = cacheConditionedFrameToLocal(gatewayRes.imageUrl);
  const published = await publishLocalAsset(localPath);

  // 登记 conditioned_first_frames（可信来源：generated_frame）
  try {
    db.prepare(
      `INSERT INTO conditioned_first_frames
         (id, run_id, session_id, shot_id, owner_id, reference_video_url, reference_keyframe_url,
          product_asset_urls_json, conditioned_first_frame_url, local_path, provider, model,
          prompt_version, prompt, confidence, preflight_status, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', CURRENT_TIMESTAMP)`
    ).run(
      `vpf-${Date.now()}-${randomUUID().slice(0, 8)}`,
      input.runId ?? null,
      input.sessionId ?? null,
      input.shotId ?? null,
      input.ownerId,
      JSON.stringify(input.productAssetUrls),
      published.publicUrl,
      localPath,
      gatewayRes.source === 'yunwu' ? '云雾(yunwu-relay)' : 'direct',
      gatewayRes.modelUsed,
      VIRTUAL_PERSON_FRAME_VERSION,
      prompt.slice(0, 3000)
    );
    // viral_recreation_v2 视觉安全评估：允许虚构人物，只查文字层
    const { evaluateVisualSafety, recordVisualSafety } = await import('./visual-safety');
    const assessment = await evaluateVisualSafety(published.publicUrl, {
      sha256: published.sha256 || sha256OfLocalFile(localPath) || undefined,
      mode: 'viral_recreation_v2',
    });
    try {
      recordVisualSafety(input.ownerId, published.publicUrl, assessment);
    } catch (e: any) {
      console.warn('[viral-control-image] 视觉安全记录失败:', e?.message || e);
    }
  } catch (e: any) {
    console.warn('[viral-control-image] provenance 持久化失败:', e?.message || e);
  }

  return {
    imageUrl: published.publicUrl,
    localPath,
    provider: gatewayRes.source === 'yunwu' ? '云雾(yunwu-relay)' : 'direct',
    model: gatewayRes.modelUsed,
    prompt,
    promptVersion: VIRTUAL_PERSON_FRAME_VERSION,
  };
}

export interface ViralControlImageInput {
  /** 参考子视频（本 run 已发布公网）或本地视频路径——用于抽锚点帧 */
  referenceVideoUrl: string;
  /** 已通过字幕预检的参考帧（优先；缺省时从参考视频抽取） */
  referenceFrameUrl?: string;
  productAssetUrls: string[];
  productName: string;
  /** 镜头结构：景别、主体位置、动作意图（如「中景，博主手持产品展示」） */
  shotStructure: string;
  visualConstraints?: string[];
  modelId?: string;
  size?: string;
  /** P0 字幕纪律：预检必须由调用方完成并通过（false/缺省 → 拒绝，绝不提交带字幕素材） */
  subtitlePreflightPassed: boolean;
  persist?: {
    runId?: string | null;
    ownerId?: string | null;
    referenceVideoUrl?: string | null;
  };
}

/** 文字清除 prompt：保留画面全部主体（含人物/动作/场景/产品），仅移除文字层 */
export function buildDeTextPrompt(input: {
  productName?: string;
  visualConstraints?: string[];
}): string {
  const constraints = [
    ...(input.visualConstraints ?? []),
    'No other brands, no competitor logos, no other product packaging',
    'No new text, no labels, no UI elements, no icons',
  ].filter(Boolean);
  return [
    'Remove ALL text, letters, numbers, subtitles, captions, watermarks, logos, stamps, and any readable characters from this image.',
    'Keep the person, their face, the action, the scene, the lighting, the camera framing, the composition, and the product exactly as they are.',
    `The product must keep its packaging geometry, color, material and shape — only its printed text is removed.${input.productName ? ` Target product: ${input.productName}.` : ''}`,
    `Constraints: ${constraints.join('; ')}`,
    'Commercial product photography, realistic lighting.',
  ].join('\n');
}

/**
 * 文字清除环节（P0 风控规避验证用）：
 * 用云雾 /images/edits 对一张图做「仅移除文字层、保留全部画面主体」的编辑，
 * 产物发布公网并记录 provenance（viral_probe_artifacts，kind=de_text）。
 * 失败语义：provider 不支持 → ImageConditioningUnavailableError；编辑失败 → 抛错。
 */
export async function removeTextLayersFromImage(input: {
  imageUrl: string;
  productName?: string;
  modelId?: string;
  size?: string;
  visualConstraints?: string[];
  persist?: { runId?: string | null; ownerId?: string | null };
}): Promise<{
  imageUrl: string;
  localPath: string;
  provider: string;
  model: string;
  prompt: string;
  promptVersion: string;
}> {
  if (!input.imageUrl) {
    throw new Error('removeTextLayersFromImage: 缺少 imageUrl');
  }
  const capability = getImageConditioningCapability({ modelId: input.modelId });
  if (!capability.supported) {
    throw new ImageConditioningUnavailableError(capability);
  }
  const prompt = buildDeTextPrompt({
    productName: input.productName,
    visualConstraints: input.visualConstraints,
  });
  const gatewayRes = await callImageGenerationGateway({
    prompt,
    modelId: input.modelId,
    size: input.size || '1024x1536',
    referenceImages: [{ url: input.imageUrl }],
  });
  if (!gatewayRes.success || !gatewayRes.imageUrl) {
    const err = new Error(
      gatewayRes.error?.includes('product_conditioning_provider_unavailable')
        ? gatewayRes.error
        : `文字清除编辑失败：${gatewayRes.error || 'provider 未返回图片'}`
    ) as Error & { code?: string };
    err.code = gatewayRes.error?.includes('product_conditioning_provider_unavailable')
      ? 'product_conditioning_provider_unavailable'
      : 'de_text_edit_failed';
    throw err;
  }
  const localPath = cacheConditionedFrameToLocal(gatewayRes.imageUrl);
  const published = await publishLocalAsset(localPath);
  persistViralArtifact({
    runId: input.persist?.runId ?? null,
    ownerId: input.persist?.ownerId ?? null,
    kind: 'de_text',
    sourceVideoUrl: null,
    localPath,
    publicUrl: published.publicUrl,
    sha256: published.sha256 || sha256OfLocalFile(localPath) || null,
    metaJson: {
      prompt,
      promptVersion: DE_TEXT_PROMPT_VERSION,
      sourceImageUrl: input.imageUrl,
      provider: gatewayRes.source === 'yunwu' ? 'yunwu' : 'direct',
      model: gatewayRes.modelUsed,
    },
  });
  return {
    imageUrl: published.publicUrl,
    localPath,
    provider: gatewayRes.source === 'yunwu' ? '云雾(yunwu-relay)' : 'direct',
    model: gatewayRes.modelUsed,
    prompt,
    promptVersion: DE_TEXT_PROMPT_VERSION,
  };
}

export interface ViralControlImageInput {
  /** 参考子视频（本 run 已发布公网）或本地视频路径——用于抽锚点帧 */
  referenceVideoUrl: string;
  /** 已通过字幕预检的参考帧（优先；缺省时从参考视频抽取） */
  referenceFrameUrl?: string;
  productAssetUrls: string[];
  productName: string;
  /** 镜头结构：景别、主体位置、动作意图（如「中景，博主手持产品展示」） */
  shotStructure: string;
  visualConstraints?: string[];
  modelId?: string;
  size?: string;
  /** P0 字幕纪律：预检必须由调用方完成并通过（false/缺省 → 拒绝，绝不提交带字幕素材） */
  subtitlePreflightPassed: boolean;
  persist?: {
    runId?: string | null;
    ownerId?: string | null;
    referenceVideoUrl?: string | null;
  };
}

export interface ViralControlImageResult {
  imageUrl: string;
  localPath: string;
  provider: string;
  model: string;
  prompt: string;
  promptVersion: string;
  capability: ReturnType<typeof getImageConditioningCapability>;
}

/** 人物保留版控制图 prompt：保留公司模特/场景/运镜，替换源产品，移除文字层 */
export function buildViralControlImagePrompt(input: {
  productName: string;
  shotStructure: string;
  visualConstraints?: string[];
}): string {
  const constraints = [
    ...(input.visualConstraints ?? []),
    'No other brands, no competitor logos, no other product packaging',
    'Replace the source-video product with the supplied product asset: keep the person, the action, the scene, the camera framing, and the motion exactly as composed',
    'Remove all burned-in subtitles, captions, watermarks, QR codes, usernames, UI elements, and any source-video text from the image',
    'Do not reproduce any source-video subtitle text, slogan, or on-screen caption',
    '9:16 vertical composition',
  ].filter(Boolean);
  return [
    'The allowed reference video frame is an authorized company scene. Preserve the person, their action, the set, the lighting, and the camera composition.',
    `Use the supplied product asset(s) as the only product identity source for ${input.productName}.`,
    'The product must retain the supplied packaging geometry, color, material, logo, and label layout; do not invent a different package.',
    `Scene and shot structure: ${input.shotStructure}`,
    `Constraints: ${constraints.join('; ')}`,
    'Commercial product photography, realistic lighting, vertical 9:16 composition.',
  ].join('\n');
}

/**
 * 生成产品控制图（人物保留版，viral_recreation_v2 策略出口）。
 * E2E 确定性通道：FAKE_VIRAL_CONTROL_IMAGE=true 时复制产品图字节作为产物
 * （不调用图像 provider；provenance 与约束仍真实执行）。
 */
export async function createViralControlImage(
  input: ViralControlImageInput
): Promise<ViralControlImageResult> {
  if (!input.productAssetUrls?.length) {
    const err = new Error('缺少 productAssetUrls：产品控制图必须携带真实产品图') as Error & { code?: string };
    err.code = 'product_conditioning_provider_unavailable';
    throw err;
  }
  if (!input.subtitlePreflightPassed) {
    const err = new Error(
      'viral control image 需要参考帧通过字幕/水印预检（subtitlePreflightPassed=true），未预检的素材不得进入 provider'
    ) as Error & { code?: string };
    err.code = 'subtitle_preflight_failed';
    throw err;
  }
  if (!input.referenceFrameUrl) {
    const err = new Error('缺少 referenceFrameUrl：产品控制图必须基于参考子视频的预检帧') as Error & { code?: string };
    err.code = 'control_frame_missing';
    throw err;
  }

  // P0 策略出口：参考帧以 run_uploaded_reference_frame 声明（含公司模特，字幕已预检），
  // 产品图以 product_shot 声明；模式 = viral_recreation_v2。
  const mode: ReferenceInputMode = 'viral_recreation_v2';
  const declarations: DeclaredReferenceImage[] = [
    runUploadedReferenceFrameDeclaration({
      url: input.referenceFrameUrl,
      subtitlePreflightPassed: true,
    }),
    ...input.productAssetUrls.map((url, index) => productShotDeclaration(url, index)),
  ];
  assertReferenceImagesAllowed(declarations, { mode });
  const referenceImages = [...new Set(declarations.map((d) => d.url))];

  const capability = getImageConditioningCapability({ modelId: input.modelId });
  if (!capability.supported) {
    throw new ImageConditioningUnavailableError(capability);
  }

  const prompt = buildViralControlImagePrompt({
    productName: input.productName,
    shotStructure: input.shotStructure,
    visualConstraints: input.visualConstraints,
  });

  // E2E 确定性通道（FAKE_FIRST_FRAME_DERIVE 语义对齐）：不调用图像 provider
  if (process.env.FAKE_VIRAL_CONTROL_IMAGE === 'true') {
    return deriveFakeViralControlImage(input, prompt, capability);
  }

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
        : `产品控制图生成失败：${gatewayRes.error || 'provider 未返回图片'}`
    ) as Error & { code?: string };
    err.code = gatewayRes.error?.includes('product_conditioning_provider_unavailable')
      ? 'product_conditioning_provider_unavailable'
      : 'viral_control_image_generation_failed';
    throw err;
  }

  const localPath = cacheConditionedFrameToLocal(gatewayRes.imageUrl);
  const published = await publishLocalAsset(localPath);

  // provenance 记录到 viral_probe_artifacts（migration v33）
  persistViralArtifact({
    runId: input.persist?.runId ?? null,
    ownerId: input.persist?.ownerId ?? null,
    kind: 'control_image',
    sourceVideoUrl: input.persist?.referenceVideoUrl ?? input.referenceVideoUrl,
    localPath,
    publicUrl: published.publicUrl,
    sha256: published.sha256 || sha256OfLocalFile(localPath) || null,
    metaJson: {
      prompt,
      promptVersion: VIRAL_CONTROL_IMAGE_PROMPT_VERSION,
      referenceFrameUrl: input.referenceFrameUrl,
      productAssetUrls: input.productAssetUrls,
      provider: gatewayRes.source === 'yunwu' ? 'yunwu' : 'direct',
      model: gatewayRes.modelUsed,
    },
  });

  return {
    imageUrl: published.publicUrl,
    localPath,
    provider: gatewayRes.source === 'yunwu' ? '云雾(yunwu-relay)' : 'direct',
    model: gatewayRes.modelUsed,
    prompt,
    promptVersion: VIRAL_CONTROL_IMAGE_PROMPT_VERSION,
    capability,
  };
}

/** E2E 确定性派生：复制产品图字节作为控制图产物（FAKE_VIRAL_CONTROL_IMAGE=true） */
async function deriveFakeViralControlImage(
  input: ViralControlImageInput,
  prompt: string,
  capability: ReturnType<typeof getImageConditioningCapability>
): Promise<ViralControlImageResult> {
  const productUrl = input.productAssetUrls[0];
  const uploadsRoot = path.resolve(process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads'));
  // 支持 /uploads 相对路径与任意本地绝对路径（fake 派生只需真实文件字节）
  const srcLocal = productUrl.startsWith('/uploads/')
    ? path.resolve(uploadsRoot, productUrl.slice('/uploads/'.length))
    : fs.existsSync(productUrl)
      ? productUrl
      : null;
  if (!srcLocal || !fs.existsSync(srcLocal)) {
    throw new Error(`FAKE_VIRAL_CONTROL_IMAGE：产品图（${productUrl.slice(0, 120)}）无本地文件`);
  }
  const rendersDir = path.join(uploadsRoot, 'renders');
  fs.mkdirSync(rendersDir, { recursive: true });
  const ext = path.extname(srcLocal) || '.png';
  const filename = `viral_control_fake_${Date.now()}_${randomUUID().slice(0, 8)}${ext}`;
  const localPath = path.join(rendersDir, filename);
  fs.copyFileSync(srcLocal, localPath);
  const publicUrl = `/uploads/renders/${filename}`;
  persistViralArtifact({
    runId: input.persist?.runId ?? null,
    ownerId: input.persist?.ownerId ?? null,
    kind: 'control_image',
    sourceVideoUrl: input.persist?.referenceVideoUrl ?? input.referenceVideoUrl,
    localPath,
    publicUrl,
    sha256: sha256OfLocalFile(localPath) ?? null,
    metaJson: {
      prompt,
      promptVersion: VIRAL_CONTROL_IMAGE_PROMPT_VERSION,
      referenceFrameUrl: input.referenceFrameUrl,
      productAssetUrls: input.productAssetUrls,
      provider: 'fake-viral-control-image',
      model: 'fake-image-conditioning',
    },
  });
  return {
    imageUrl: publicUrl,
    localPath,
    provider: 'fake-viral-control-image',
    model: 'fake-image-conditioning',
    prompt,
    promptVersion: VIRAL_CONTROL_IMAGE_PROMPT_VERSION,
    capability,
  };
}

/** viral_probe_artifacts 记录（幂等容错：表不存在/写入失败只警告，不阻断 probe） */
export function persistViralArtifact(input: {
  runId: string | null;
  ownerId: string | null;
  kind: string;
  sourceVideoUrl: string | null;
  localPath: string;
  publicUrl: string;
  sha256: string | null;
  metaJson: Record<string, unknown>;
}): void {
  try {
    db.prepare(
      `INSERT INTO viral_probe_artifacts
         (id, run_id, owner_id, kind, source_video_url, local_path, public_url, sha256, meta_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
    ).run(
      `vpa-${Date.now()}-${randomUUID().slice(0, 8)}`,
      input.runId,
      input.ownerId,
      input.kind,
      input.sourceVideoUrl,
      input.localPath,
      input.publicUrl,
      input.sha256,
      JSON.stringify(input.metaJson)
    );
  } catch (err: any) {
    console.warn('[viral-control-image] viral_probe_artifacts 持久化失败:', err?.message || err);
  }
}
