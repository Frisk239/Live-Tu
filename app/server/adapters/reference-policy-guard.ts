/**
 * ReferencePolicyGuard — 在真实 provider 出口强制执行 ReferenceInputPolicy。
 *
 * 三个强制出口（服务端与 CLI 共用）：
 * 1. 条件化首帧生成（createProductConditionedFirstFrame 的 /images/edits payload）；
 * 2. Seedance 请求构建（SeedanceVideoPort.submitShot 的 reference materials）；
 * 3. 重试修复（fix/retry 共用 ensureShotFirstFrame 派生漏斗，与出口 1 同一守卫）。
 *
 * 规则：默认 semantic_recreation——原视频关键帧、含人脸/字幕/水印/竞品的资产
 * 不得进入任何 provider payload；virtual_talent 允许有脸的虚拟人物资产，
 * 但拒绝「与原视频人物同一身份」的资产。
 * 任何违规 → ReferencePolicyViolationError（统一 code），在请求构建前硬性阻断，
 * 绝不发起付费调用。
 */

import {
  type ReferenceAssetKind,
  type ReferenceAssetDeclaration,
  type ReferenceInputMode,
  ReferencePolicyViolationError,
  buildProviderReferencePayload,
} from '../domain/reference-policy/reference-input-policy';

/** 运行时声明（与领域声明同构，便于调用方以 URL 为单位声明） */
export interface DeclaredReferenceImage {
  id: string;
  url: string;
  kind: ReferenceAssetKind;
  containsFace?: boolean;
  containsSourceOverlay?: boolean;
  identityRef?: string | null;
  sourceIdentityRef?: string | null;
  matchesSourceIdentity?: boolean;
  authorization?: ReferenceAssetDeclaration['authorization'];
}

export interface ReferencePolicyOptions {
  mode?: ReferenceInputMode;
}

/** 断言一组参考图全部允许进入 provider payload；任一违规抛 ReferencePolicyViolationError */
export function assertReferenceImagesAllowed(
  images: DeclaredReferenceImage[],
  options: ReferencePolicyOptions = {}
): void {
  const declarations: ReferenceAssetDeclaration[] = images.map((image) => ({
    id: image.id,
    kind: image.kind,
    url: image.url,
    containsFace: image.containsFace,
    containsSourceOverlay: image.containsSourceOverlay,
    identityRef: image.identityRef,
    sourceIdentityRef: image.sourceIdentityRef,
    matchesSourceIdentity: image.matchesSourceIdentity,
    authorization: image.authorization,
  }));
  buildProviderReferencePayload(declarations, {
    mode: options.mode ?? 'semantic_recreation',
    strict: true,
  });
}

/** 返回经策略过滤后的 URL 列表（strict=false 语义；违规项被剔除） */
export function filterAllowedReferenceUrls(
  images: DeclaredReferenceImage[],
  options: ReferencePolicyOptions = {}
): string[] {
  const declarations: ReferenceAssetDeclaration[] = images.map((image) => ({
    id: image.id,
    kind: image.kind,
    url: image.url,
    containsFace: image.containsFace,
    containsSourceOverlay: image.containsSourceOverlay,
    identityRef: image.identityRef,
    sourceIdentityRef: image.sourceIdentityRef,
    matchesSourceIdentity: image.matchesSourceIdentity,
    authorization: image.authorization,
  }));
  const decision = buildProviderReferencePayload(declarations, {
    mode: options.mode ?? 'semantic_recreation',
    strict: false,
  });
  return decision;
}

/** 便捷声明工厂：原视频关键帧（只用于分析，禁止进入 provider payload） */
export function sourceKeyframeDeclaration(url: string): DeclaredReferenceImage {
  return {
    id: `source-keyframe-${url}`,
    url,
    kind: 'source_keyframe',
    // 不声明人脸：source_keyframe 在任何模式下都因 kind 被拒绝（拒绝依据与
    // 是否检测到人脸无关——原视频关键帧本就只用于语义分析）。
  };
}

/** 便捷声明工厂：我方产品图 */
export function productShotDeclaration(url: string, index = 0): DeclaredReferenceImage {
  return { id: `product-${index}-${url}`, url, kind: 'product_shot' };
}

/** 便捷声明工厂：我方生成帧/自有场景锚点 */
export function ownedAnchorDeclaration(url: string): DeclaredReferenceImage {
  return { id: `owned-anchor-${url}`, url, kind: 'owned_scene_anchor' };
}

/**
 * 便捷声明工厂：viral_recreation_v2 本 run 上传的参考视频帧/子视频。
 * 仅在本 run 内、发布为公网可下载资产、且已通过字幕/水印预检后使用；
 * 允许保留公司模特/动作/场景（P0 素材为已授权公司素材）。
 */
export function runUploadedReferenceFrameDeclaration(input: {
  url: string;
  /** 已通过字幕/水印预检（未预检的素材必须标注 true 以触发策略拒绝） */
  subtitlePreflightPassed?: boolean;
}): DeclaredReferenceImage {
  return {
    id: `run-uploaded-ref-${input.url}`,
    url: input.url,
    kind: 'run_uploaded_reference_frame',
    // 字幕/水印预检未通过时显式声明 containsSourceOverlay=true →
    // 跨模式硬规则拒绝，绝不进入 provider
    containsSourceOverlay: input.subtitlePreflightPassed ? false : true,
  };
}

/** 便捷声明工厂：品牌自有虚拟人物资产（带身份标识，可与原视频身份比对） */
export function virtualTalentDeclaration(input: {
  url: string;
  identityRef: string;
  sourceIdentityRef?: string | null;
  matchesSourceIdentity?: boolean;
}): DeclaredReferenceImage {
  return {
    id: `virtual-talent-${input.url}`,
    url: input.url,
    kind: 'virtual_talent_asset',
    containsFace: true, // 虚拟人物可以有脸；身份由 identityRef 维度判定
    identityRef: input.identityRef,
    sourceIdentityRef: input.sourceIdentityRef ?? null,
    matchesSourceIdentity: input.matchesSourceIdentity,
  };
}
