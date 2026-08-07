/**
 * ReferenceInputPolicy — 参考输入合规策略（纯领域模块，无 I/O）。
 *
 * 强制点：在任何 provider 请求构建之前执行（视频生成 provider 的 reference
 * input 只能包含本策略放行的资产）。
 *
 * 四种模式：
 * 1. semantic_recreation（默认）：
 *    - 爆款视频只用于语义/节奏/镜头语言分析；
 *    - 原视频关键帧、真人脸、竞品包装、字幕、水印不得进入 provider reference input；
 *    - provider 只能收到产品图、我方生成或自有授权的场景锚点、无人物或虚拟人物资产。
 * 2. authorized_likeness：
 *    - 只接受已验证、已授权的真人资产标识；
 *    - 必须带授权状态（verified + licenseRef），任意公网真人图一律拒绝。
 * 3. virtual_talent：
 *    - 只使用合规虚拟人物/品牌自有数字资产，与原视频人物身份无关。
 * 4. viral_recreation_v2（爆款复刻 v2）：
 *    - 参考视频为本 run 上传、可追溯且发布为公网可下载的资产；
 *    - 允许保留公司模特、动作、场景、构图和运镜（公司授权模特可入 provider）；
 *    - 源产品、源字幕、水印和文字层必须按镜头计划替换或移除——
 *      带字幕/水印/竞品标识的资产仍一律拒绝（同跨模式硬规则）；
 *    - 不建设授权收集/人像管理流程：外部真人照片（person_photo）仍拒绝。
 *
 * 不实现任何「裁脸、打码、模糊、伪装」式的绕过逻辑——策略只做允许/拒绝。
 */

export type ReferenceInputMode =
  | 'semantic_recreation'
  | 'authorized_likeness'
  | 'virtual_talent'
  | 'viral_recreation_v2';

export type ReferenceAssetKind =
  | 'source_keyframe' // 原视频关键帧（可能含人脸/字幕/水印/竞品）
  | 'person_photo' // 真人照片（任意公网来源）
  | 'product_shot' // 我方产品图
  | 'owned_scene_anchor' // 我方自有/授权场景锚点
  | 'generated_frame' // 我方生成的画面（产品条件化首帧等）
  | 'virtual_talent_asset' // 合规虚拟人物/品牌自有数字资产
  | 'competitor_packaging' // 竞品包装
  | 'watermarked_asset' // 带字幕/水印的资产
  | 'run_uploaded_reference_frame'; // 本 run 上传并发布为公网可下载的参考视频帧/子视频（viral_recreation_v2 专用）

export interface ReferenceAssetDeclaration {
  id: string;
  kind: ReferenceAssetKind;
  url: string;
  /** 声明该资产画面中是否含真人脸（semantic_recreation 下任一含人脸即拒绝） */
  containsFace?: boolean;
  /** 声明该资产是否含原视频字幕/水印/竞品标识 */
  containsSourceOverlay?: boolean;
  /**
   * 身份维度（virtual_talent 关键）：虚拟人物可以有脸，
   * 禁止的是「与原视频人物是同一身份」。
   * - identityRef：本资产的数字身份标识（虚拟人物 id / 真人授权 id）；
   * - sourceIdentityRef：原视频中人物的身份标识（可空 = 未知/无原视频人物）；
   * - matchesSourceIdentity：显式声明本资产与原视频人物为同一身份。
   */
  identityRef?: string | null;
  sourceIdentityRef?: string | null;
  matchesSourceIdentity?: boolean;
  /** authorized_likeness 模式的授权状态 */
  authorization?: {
    status: 'verified' | 'pending' | 'none';
    licenseRef?: string;
  };
}

/**
 * 是否与原视频人物为同一身份（virtual_talent 模式的身份红线）。
 * 判定顺序：显式 matchesSourceIdentity 优先；否则比较 identityRef 与 sourceIdentityRef。
 * 无法判定（两者都未声明）→ 视为同一身份（保守拒绝：身份不明的虚拟人脸资产
 * 不得进入 provider，宁可显式失败也不冒险）。
 */
export function declaresSourceIdentityMatch(asset: ReferenceAssetDeclaration): boolean {
  if (asset.matchesSourceIdentity === true) return true;
  if (asset.matchesSourceIdentity === false) return false;
  if (asset.identityRef && asset.sourceIdentityRef) {
    return asset.identityRef === asset.sourceIdentityRef;
  }
  // 无法判定：若资产含人脸且身份字段不完整 → 保守视为疑似同一身份
  return asset.containsFace === true;
}

export interface RejectedAsset {
  id: string;
  kind: ReferenceAssetKind;
  url: string;
  code: ReferencePolicyViolationCode;
  reason: string;
}

export type ReferencePolicyViolationCode =
  | 'source_keyframe_to_provider'
  | 'face_in_provider_input'
  | 'person_photo_without_authorization'
  | 'competitor_packaging'
  | 'source_overlay'
  | 'unauthorized_likeness'
  | 'mode_mismatch'
  | 'virtual_talent_identity_link';

export interface ReferencePolicyDecision {
  mode: ReferenceInputMode;
  /** 允许进入 provider payload 的资产（顺序保持声明顺序） */
  allowed: ReferenceAssetDeclaration[];
  rejected: RejectedAsset[];
  /** 最终 provider reference input URL 列表（只含 allowed） */
  providerPayloadUrls: string[];
}

export class ReferencePolicyViolationError extends Error {
  readonly code: ReferencePolicyViolationCode;
  constructor(code: ReferencePolicyViolationCode, message: string) {
    super(message);
    this.name = 'ReferencePolicyViolationError';
    this.code = code;
  }
}

export interface ReferencePolicyOptions {
  mode?: ReferenceInputMode;
  /** 模式冲突时是否抛出（构建 provider payload 时必须 true） */
  strict?: boolean;
}

/**
 * 纯策略求值：输入资产声明 → 允许/拒绝列表 + 可进入 provider 的 URL。
 * 不读写任何外部状态。
 */
export function evaluateReferenceInputs(
  declarations: ReferenceAssetDeclaration[],
  options: ReferencePolicyOptions = {}
): ReferencePolicyDecision {
  const mode = options.mode ?? 'semantic_recreation';
  const allowed: ReferenceAssetDeclaration[] = [];
  const rejected: RejectedAsset[] = [];

  for (const asset of declarations) {
    const verdict = judgeAsset(asset, mode);
    if (verdict) {
      rejected.push(verdict);
    } else {
      allowed.push(asset);
    }
  }

  return {
    mode,
    allowed,
    rejected,
    providerPayloadUrls: allowed.map((asset) => asset.url),
  };
}

function judgeAsset(
  asset: ReferenceAssetDeclaration,
  mode: ReferenceInputMode
): RejectedAsset | null {
  const reject = (code: ReferencePolicyViolationCode, reason: string): RejectedAsset => ({
    id: asset.id,
    kind: asset.kind,
    url: asset.url,
    code,
    reason,
  });

  // 跨模式硬规则：竞品包装、带原视频字幕/水印的资产在任何模式下都不进入 provider
  if (asset.kind === 'competitor_packaging') {
    return reject('competitor_packaging', '竞品包装不得进入 provider reference input');
  }
  if (asset.kind === 'watermarked_asset' || asset.containsSourceOverlay) {
    return reject('source_overlay', '含原视频字幕/水印的资产不得进入 provider reference input');
  }

  switch (mode) {
    case 'semantic_recreation': {
      // 硬性红线：含人脸的资产（无论声明为什么 kind）绝不进入 provider payload
      if (asset.containsFace) {
        return reject('face_in_provider_input', '含真人脸的资产不得进入 provider reference input（semantic_recreation）');
      }
      // 原视频关键帧只用于语义分析，不得进入 provider reference input
      if (asset.kind === 'source_keyframe') {
        return reject('source_keyframe_to_provider', '原视频关键帧只用于语义分析，不得进入 provider reference input');
      }
      // viral_recreation_v2 专用 kind（允许保留公司模特）与 semantic_recreation
      // 的无人物纪律冲突——显式拒绝，防止新模式声明泄漏到默认模式
      if (asset.kind === 'run_uploaded_reference_frame') {
        return reject(
          'mode_mismatch',
          'run_uploaded_reference_frame 是 viral_recreation_v2 专用声明，semantic_recreation 下必须显式拒绝（含公司模特画面违反无人物纪律）'
        );
      }
      // 真人照片必须有授权（本模式默认拒绝；授权真人走 authorized_likeness）
      if (asset.kind === 'person_photo') {
        return reject('person_photo_without_authorization', 'semantic_recreation 不接受真人照片作为 provider 参考');
      }
      return null; // product_shot / owned_scene_anchor / generated_frame / virtual_talent_asset 放行
    }
    case 'viral_recreation_v2': {
      // 本模式只放行本 run 上传并发布为公网可下载资产的参考帧/子视频。
      // 旧 source_keyframe 语义不变（不简单改名绕过旧路径——新模式使用自己的
      // run_uploaded_reference_frame 声明），source_keyframe 仍被拒绝。
      if (asset.kind === 'source_keyframe') {
        return reject('source_keyframe_to_provider', 'source_keyframe 只用于语义分析；viral_recreation_v2 需使用 run_uploaded_reference_frame 声明');
      }
      if (asset.kind === 'run_uploaded_reference_frame') {
        // 允许保留公司模特/动作/场景/运镜（授权前提：本 run 上传、可追溯、公网可下载）
        return null;
      }
      // 其余规则与语义复刻一致：外部真人照片、竞品、字幕水印一律拒绝
      if (asset.kind === 'person_photo') {
        return reject('person_photo_without_authorization', 'viral_recreation_v2 不接受外部真人照片（不建设授权收集流程）');
      }
      if (asset.containsFace) {
        return reject('face_in_provider_input', 'viral_recreation_v2 只允许公司模特（run_uploaded_reference_frame），其他含脸资产不得进入 provider reference input');
      }
      return null; // product_shot / owned_scene_anchor / generated_frame / virtual_talent_asset 放行
    }
    case 'authorized_likeness': {
      if (asset.kind === 'source_keyframe') {
        return reject('source_keyframe_to_provider', '原视频关键帧不是授权素材，不得进入 provider reference input');
      }
      const authorization = asset.authorization;
      if (asset.kind === 'person_photo' || asset.containsFace) {
        if (authorization?.status === 'verified' && authorization.licenseRef) {
          return null; // 已验证授权
        }
        return reject(
          'unauthorized_likeness',
          `真人资产缺少已验证授权（status=${authorization?.status ?? 'none'}）`
        );
      }
      // 非人物资产（产品图/自有锚点/生成帧）在 authorized_likeness 下同样放行
      return null;
    }
    case 'virtual_talent': {
      if (asset.kind === 'source_keyframe') {
        return reject('source_keyframe_to_provider', '原视频关键帧不得进入 provider reference input（virtual_talent）');
      }
      if (asset.kind === 'virtual_talent_asset') {
        // 身份红线：虚拟人物可以有脸，但不得与原视频人物是同一身份。
        // （与原视频人物无关的品牌自有虚拟人物 = 放行；身份不明且含人脸 = 保守拒绝）
        if (declaresSourceIdentityMatch(asset)) {
          return reject(
            'virtual_talent_identity_link',
            '虚拟人物资产与原视频人物为同一身份（或身份无法排除），不得作为 provider 参考'
          );
        }
        return null;
      }
      if (asset.kind === 'person_photo') {
        if (authorizationVerified(asset)) return null;
        return reject('unauthorized_likeness', 'virtual_talent 模式不接受未授权真人照片');
      }
      if (asset.containsFace) {
        return reject('face_in_provider_input', 'virtual_talent 模式不接受含原视频人脸的资产');
      }
      return null;
    }
  }
}

function authorizationVerified(asset: ReferenceAssetDeclaration): boolean {
  return asset.authorization?.status === 'verified' && Boolean(asset.authorization.licenseRef);
}

/**
 * 构建 provider reference payload：只返回被策略放行的 URL。
 * strict=true（默认）时若存在任何拒绝项即抛错——确保在请求构建处硬性阻断，
 * 而不是带着被拒绝的素材继续组装请求。
 */
export function buildProviderReferencePayload(
  declarations: ReferenceAssetDeclaration[],
  options: ReferencePolicyOptions = {}
): string[] {
  const decision = evaluateReferenceInputs(declarations, options);
  if (options.strict !== false && decision.rejected.length > 0) {
    const first = decision.rejected[0];
    throw new ReferencePolicyViolationError(first.code, first.reason);
  }
  return decision.providerPayloadUrls;
}

/** 断言给定 URL 列表不包含任何被策略拒绝的资产（测试与请求构建前双重把关） */
export function assertProviderPayloadSafe(
  payloadUrls: string[],
  declarations: ReferenceAssetDeclaration[],
  options: ReferencePolicyOptions = {}
): void {
  const decision = evaluateReferenceInputs(declarations, options);
  const rejectedUrls = new Set(decision.rejected.map((asset) => asset.url));
  for (const url of payloadUrls) {
    if (rejectedUrls.has(url)) {
      const asset = decision.rejected.find((a) => a.url === url);
      throw new ReferencePolicyViolationError(
        asset?.code ?? 'source_keyframe_to_provider',
        `provider payload 包含被策略拒绝的资产 ${url}（${asset?.reason ?? 'policy violation'}）`
      );
    }
  }
}
