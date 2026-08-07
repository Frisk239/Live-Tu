/**
 * S3 生成前首帧预检（first-frame preflight）
 *
 * 在调用付费视频 provider（Seedance）之前检查条件化首帧：
 * 1. 图片公网可达（HEAD 探测——星河必须能从公网下载）；
 * 2. 产品是否真实出现（LLM vision）；
 * 3. 包装/颜色/Logo 是否与产品图一致（LLM vision）；
 * 4. 构图是否与参考关键帧基本一致（LLM vision）；
 * 5. 是否有竞品残留（LLM vision）。
 *
 * 预检失败时：
 * - 不调用 Seedance；
 * - 返回具体问题 + 可执行修复动作（重新生成首帧 / 更换参考输入 / 重新发布）；
 * - 支持重新生成首帧，最多两次（regenerateFirstFrameWithPreflight）。
 *
 * 可测试性：llmVisionFn / reachabilityFn 可注入确定性 fake（零真实调用）。
 */
import { preflightMediaUrl } from '../routes/seedance';
import { callLlmGateway } from './llm-gateway';

export type FirstFrameFixKind = 'regenerate_first_frame' | 'replace_reference' | 'republish';

export interface FirstFramePreflightIssue {
  /** 稳定问题码 */
  code:
    | 'not_publicly_reachable'
    | 'product_missing'
    | 'packaging_mismatch'
    | 'composition_deviation'
    | 'competitor_residue'
    | 'anatomy_artifact';
  /** 用户可读问题描述 */
  message: string;
  /** 可执行修复动作 */
  fixAction: string;
  fixKind: FirstFrameFixKind;
}

export interface FirstFramePreflightResult {
  ok: boolean;
  issues: FirstFramePreflightIssue[];
  /** 0..1（LLM 综合评分；无 LLM 时 null） */
  score: number | null;
  evidence: string;
  checkedAt: number;
}

export interface FirstFramePreflightInput {
  /** 条件化首帧公网 URL（待检查对象） */
  firstFrameUrl: string;
  /** 爆款参考关键帧（构图对比） */
  referenceKeyframeUrl: string;
  /** 产品图（包装对比） */
  productImageUrl: string;
  productName: string;
  prohibitedItems?: string[];
  /** 可注入 seam（测试用确定性 fake） */
  llmVisionFn?: typeof callLlmGateway;
  reachabilityFn?: (url: string) => Promise<{ ok: boolean; error?: string }>;
}

const PREFLIGHT_DIMENSIONS = [
  { id: 'product_present', label: '产品是否真实出现', fixKind: 'regenerate_first_frame' as const },
  { id: 'packaging_match', label: '包装/颜色/Logo 是否与产品图一致', fixKind: 'regenerate_first_frame' as const },
  { id: 'composition_match', label: '构图是否与参考关键帧基本一致', fixKind: 'regenerate_first_frame' as const },
  { id: 'competitor_free', label: '是否残留竞品标识/包装', fixKind: 'replace_reference' as const },
  { id: 'human_artifact_free', label: '是否完全没有手、手指、手臂、皮肤或其他人体伪影', fixKind: 'regenerate_first_frame' as const },
];

export async function runFirstFramePreflight(
  input: FirstFramePreflightInput
): Promise<FirstFramePreflightResult> {
  // E2E 确定性通道（与 FAKE_TECH_QA 同纪律）：FAKE_FIRST_FRAME_PREFLIGHT=true 时
  // 预检恒定通过，供零付费质量闭环 E2E 使用；生产/真实 demo 不设置该变量，不走此路径。
  if (process.env.FAKE_FIRST_FRAME_PREFLIGHT === 'true') {
    return {
      ok: true,
      issues: [],
      score: 1,
      evidence: 'FAKE_FIRST_FRAME_PREFLIGHT（E2E 确定性通过，非真实视觉预检）',
      checkedAt: Date.now(),
    };
  }
  const issues: FirstFramePreflightIssue[] = [];
  const reachability = input.reachabilityFn ?? preflightMediaUrl;

  // 1) 公网可达性（不依赖 LLM，确定性检查）
  const reach = await reachability(input.firstFrameUrl);
  if (!reach.ok) {
    issues.push({
      code: 'not_publicly_reachable',
      message: `首帧公网不可达（${reach.error || 'HEAD 失败'}）：星河中转无法下载该图片`,
      fixAction: '重新发布首帧为公网可下载 URL（PUBLIC_BASE_URL / 显式演示发布通道）',
      fixKind: 'republish',
    });
  }

  // 2) 视觉检查（LLM vision；可注入 fake）
  let score: number | null = null;
  let evidence = '';
  if (input.firstFrameUrl && input.referenceKeyframeUrl && input.productImageUrl) {
    const llmFn = input.llmVisionFn ?? callLlmGateway;
    try {
      const system = `你是广告素材质检员。检查生成的首帧图是否适合作为视频生成起点。
对以下 5 项逐一给出 verdict（pass/fail）与一句话 reason。任何可见的人体部位、手部形变、粘连、额外手指、皮肤残片都必须判 fail：
1. product_present：目标产品（${input.productName}）是否真实出现在首帧中
2. packaging_match：产品包装颜色/形状/品牌标识是否与产品参考图一致
3. composition_match：构图（景别、主体位置、机位、动作意图）是否与参考关键帧基本一致
4. competitor_free：画面是否残留竞品品牌标识/包装/文字
5. human_artifact_free：画面是否完全没有手、手指、手臂、皮肤、脸、身体或任何人体伪影（产品、喷嘴、泡沫和台面承担动作）
禁止出现元素：${(input.prohibitedItems ?? []).join('、') || '无'}
返回严格 JSON：{"checks":[{"id":"product_present","verdict":"pass|fail","reason":"..."}],"score":0.0-1.0}`;
      const user = '首帧图（第 1 张）、参考关键帧（第 2 张）、产品参考图（第 3 张）。请严格输出 JSON。';
      const res = await llmFn({
        system,
        user,
        imageUrls: [input.firstFrameUrl, input.referenceKeyframeUrl, input.productImageUrl],
        temperature: 0.1,
      });
      if (res.success && res.data?.checks) {
        evidence = JSON.stringify(res.data.checks).slice(0, 2000);
        score = typeof res.data.score === 'number' ? Math.max(0, Math.min(1, res.data.score)) : null;
        for (const check of res.data.checks as Array<{ id: string; verdict: string; reason?: string }>) {
          if (check.verdict !== 'pass') {
            const dim = PREFLIGHT_DIMENSIONS.find((d) => d.id === check.id);
            if (!dim) continue;
            const label = dim.label;
            issues.push({
              code: mapDimToCode(check.id),
              message: `${label}不达标：${check.reason || 'LLM 判定不合格'}`,
              fixAction:
                check.id === 'competitor_free'
                  ? '更换参考关键帧（避开含竞品标识的镜头段）后重新生成首帧'
                  : `重新生成产品条件化首帧（第 ${issues.length + 1} 次）`,
              fixKind: dim.fixKind,
            });
          }
        }
      } else {
        evidence = 'LLM 未返回结构化预检结果（按 unverified 处理，不阻断但记录）';
      }
    } catch (e: any) {
      evidence = `LLM 预检调用失败：${e?.message?.slice(0, 200) || e}`;
      console.warn('[first-frame-preflight] LLM vision failed:', e?.message || e);
    }
  } else {
    evidence = '缺少首帧/参考帧/产品图，跳过视觉检查';
  }

  return {
    ok: issues.length === 0,
    issues,
    score,
    evidence,
    checkedAt: Date.now(),
  };
}

function mapDimToCode(id: string): FirstFramePreflightIssue['code'] {
  switch (id) {
    case 'product_present':
      return 'product_missing';
    case 'packaging_match':
      return 'packaging_mismatch';
    case 'composition_match':
      return 'composition_deviation';
    case 'competitor_free':
      return 'competitor_residue';
    case 'human_artifact_free':
      return 'anatomy_artifact';
    default:
      return 'product_missing';
  }
}

// ==================== 预检 + 重生成循环（最多两次） ====================

export interface RegenerateWithPreflightOptions {
  /** 每次生成首帧的输入（referenceKeyframeUrl / productAssetUrls / shotStructure 等） */
  generate: (fixGuidance: string[]) => Promise<{ imageUrl: string; localPath: string; provenance?: unknown; attempts?: number }>;
  preflight: (imageUrl: string) => Promise<FirstFramePreflightResult>;
  /** 最多重新生成次数（默认 2） */
  maxRegenerations?: number;
}

export interface RegenerateWithPreflightResult {
  ok: boolean;
  finalImageUrl: string | null;
  finalLocalPath: string | null;
  preflight: FirstFramePreflightResult | null;
  attempts: number;
  /** 每次重生成追加的修复指导（对应 preflight issues） */
  fixGuidance: string[];
}

/**
 * 生成 → 预检 →（失败且未超限）重生成 → 再预检。
 * 每次重生成把上一次的预检问题转成可执行的视觉约束（不只是追加 prompt 文本，
 * 而是完整重新调用条件化首帧生成，可更换参考输入）。
 * 超限后返回最后一次预检结果（含可执行修复动作），不调用视频 provider。
 */
export async function generateFirstFrameWithPreflight(
  opts: RegenerateWithPreflightOptions
): Promise<RegenerateWithPreflightResult> {
  const maxRegenerations = opts.maxRegenerations ?? 2;
  let fixGuidance: string[] = [];
  let lastImageUrl: string | null = null;
  let lastLocalPath: string | null = null;
  let lastPreflight: FirstFramePreflightResult | null = null;

  for (let attempt = 0; attempt <= maxRegenerations; attempt++) {
    const generated = await opts.generate(fixGuidance);
    lastImageUrl = generated.imageUrl;
    lastLocalPath = generated.localPath ?? null;
    const preflight = await opts.preflight(generated.imageUrl);
    lastPreflight = preflight;
    if (preflight.ok) {
      return { ok: true, finalImageUrl: lastImageUrl, finalLocalPath: lastLocalPath, preflight, attempts: attempt + 1, fixGuidance };
    }
    if (attempt < maxRegenerations) {
      // 转成可执行修复指导：regenerate 类问题进入下一次生成的视觉约束
      const nextGuidance = preflight.issues
        .filter((i) => i.fixKind === 'regenerate_first_frame' || i.fixKind === 'replace_reference')
        .map((i) => `${i.message}（修复：${i.fixAction}）`);
      fixGuidance = [...fixGuidance, ...nextGuidance];
    }
  }
  return {
    ok: false,
    finalImageUrl: lastImageUrl,
    finalLocalPath: lastLocalPath,
    preflight: lastPreflight,
    attempts: maxRegenerations + 1,
    fixGuidance,
  };
}
