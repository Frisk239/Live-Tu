/**
 * 火山官方虚拟人像适配层（virtual_talent）
 *
 * 调研结论（2026-08-06，火山方舟官方文档 + 第三方中转文档）：
 * - 火山方舟 Seedance 2.0 预置 1 万+ 官方虚拟人像，可直接用于视频创作；
 * - 官方引用语法为 asset:// 资产标识（经方舟控制台肖像授权/虚拟人像库取得，
 *   如 asset://asset-2026...-xxxx）；真实人脸 URL 直传会被 moderation 拒绝（422）；
 * - 中继通道（relay，如 xmhaini 星河）无资产库管理端点（/v1/models 403），
 *   无法承载 asset:// 引用 → 必须显式失败，不得伪造 personaId、不得回退上传人脸图。
 *
 * 规则（不可违背）：
 * 1. virtual_talent 提交只允许官方可信虚拟人资产引用（asset:// 白名单）；
 * 2. 提交 payload 不得含 faceImageUrl / 源人脸图 / 派生人脸图 / 人脸 embedding；
 * 3. relay 不支持虚拟人原生资产引用 → VIRTUAL_TALENT_ADAPTER_UNSUPPORTED 显式失败。
 */

export class VirtualTalentAdapterUnsupportedError extends Error {
  readonly code = 'VIRTUAL_TALENT_ADAPTER_UNSUPPORTED' as const;
  constructor(message: string) {
    super(message);
    this.name = 'VirtualTalentAdapterUnsupportedError';
  }
}

export class VirtualTalentPayloadViolationError extends Error {
  readonly code = 'virtual_talent_payload_violation' as const;
  constructor(message: string) {
    super(message);
    this.name = 'VirtualTalentPayloadViolationError';
  }
}

export interface VirtualTalentReference {
  /** 官方虚拟人像资产标识（asset:// 前缀，火山方舟资产库） */
  assetRef: string;
  provider: 'ark' | 'relay';
}

const ASSET_REF_PATTERN = /^asset:\/\/[A-Za-z0-9._-]+$/;

/** 可信虚拟人资产引用是否合法（asset:// 白名单；不接受 URL/裸图/伪造 personaId） */
export function isValidVirtualTalentAssetRef(value: string | null | undefined): boolean {
  return typeof value === 'string' && ASSET_REF_PATTERN.test(value.trim());
}

/**
 * 解析 virtual_talent 模式的提交引用：
 * - SEEDANCE_PROVIDER=ark 且 ARK_VIRTUAL_TALENT_ASSET 为合法 asset:// 引用 → 返回；
 * - relay 通道 → VIRTUAL_TALENT_ADAPTER_UNSUPPORTED（不静默降级）；
 * - ark 但未配置/非法引用 → VIRTUAL_TALENT_ADAPTER_UNSUPPORTED（绝不伪造）。
 */
export function resolveVirtualTalentReference(): VirtualTalentReference {
  const provider = process.env.SEEDANCE_PROVIDER === 'ark' ? 'ark' : 'relay';
  if (provider !== 'ark') {
    throw new VirtualTalentAdapterUnsupportedError(
      '当前视频 provider 为中继通道（relay），不支持火山官方虚拟人像 asset:// 原生引用；' +
        '请配置 SEEDANCE_PROVIDER=ark 直连火山方舟，并在方舟控制台开通 Seedance 2.0 与虚拟人像资产'
    );
  }
  const assetRef = String(process.env.ARK_VIRTUAL_TALENT_ASSET || '').trim();
  if (!isValidVirtualTalentAssetRef(assetRef)) {
    throw new VirtualTalentAdapterUnsupportedError(
      'virtual_talent 模式需要火山方舟官方虚拟人像资产标识（ARK_VIRTUAL_TALENT_ASSET=asset://...，' +
        '在方舟控制台虚拟人像库/肖像授权后取得）；不得伪造 personaId 或回退为图片 URL'
    );
  }
  return { assetRef, provider: 'ark' };
}

/**
 * 提交 payload 断言（virtual_talent 模式）：
 * - 参考图列表必须为空（杜绝源人脸图/派生人脸图 URL 混入）；
 * - 允许的图片引用只有官方 asset:// 资产标识。
 */
export function assertVirtualTalentPayload(input: {
  providerReferenceImageUrls?: string[] | null;
  virtualTalentAssetRef?: string | null;
}): void {
  const refs = (input.providerReferenceImageUrls ?? []).filter(Boolean);
  if (refs.length > 0) {
    throw new VirtualTalentPayloadViolationError(
      `virtual_talent 提交不允许携带人脸/参考图 URL（收到 ${refs.length} 个）：${refs.join(', ').slice(0, 200)}`
    );
  }
  if (input.virtualTalentAssetRef && !isValidVirtualTalentAssetRef(input.virtualTalentAssetRef)) {
    throw new VirtualTalentPayloadViolationError(
      `虚拟人资产引用非法（必须是 asset:// 官方资产标识）：${String(input.virtualTalentAssetRef).slice(0, 120)}`
    );
  }
}
