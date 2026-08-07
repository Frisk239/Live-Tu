/**
 * S2 提交前预检（深模块）：能力 / 素材 / 成本 / 余额 / 等待
 *
 * 契约见 shared/workbench-contract.ts（PreflightResult 等）。
 * 设计原则：
 * - 每个 blocker/warning 都带 evidence（source + detail + artifact）与可执行 fix；
 * - 未知成本显示 unknown 绝不写 0；亚分成本走微美元整数运算；
 * - 无法探测的素材返回 unverified（不假装 ok）；
 * - provider 不支持的策略 must 禁用并解释，不展示假能力；
 * - 纯函数 + 可注入 deps（balance/wait/material probe），测试用确定性 fixture，不触发真实调用。
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  estimateShotUsdMicros,
  estimateVideoShotUsdMicros,
  microsToUsd,
  sumShotCostMicros,
  matchShotCapability,
  getModelCapability,
  type AutonomyMode,
  type BalancePreflight,
  type CostReductionStrategy,
  type MaterialCheck,
  type PreflightIssue,
  type PreflightResult,
  type ShotCapabilityMatch,
  type ShotCostEstimate,
  type ShotPlanShot,
  type WaitEstimate,
} from '../../shared/workbench-contract';

export interface ModelConfigRow {
  id: string;
  modelCode: string;
  category: 'text' | 'image' | 'video';
  enabled: 0 | 1;
}

export interface PreflightInput {
  ownerId: string;
  runId?: string | null;
  sessionId?: string | null;
  /** 分镜计划（含候选、prompt 覆盖、能力约束） */
  shots: ShotPlanShot[];
  /** 视频模型（catalog id，如 'Seedance 2.0 Fast'） */
  videoModelId: string;
  modelConfigs: ModelConfigRow[];
  /** 每个候选图生成数量（成本构成：视频 + 候选图） */
  candidateCountPerShot?: number;
  /** 参与生成的参考输入数量（首帧/产品图/参考视频） */
  referenceInputCount?: number;
  /**
   * S3 首帧派生计划（新输入模型）：用户不提供首帧——首帧由系统在提交时
   * 用 参考关键帧（构图基座）+ 产品图（包装参考）派生。非空时预检不要求
   * 镜头带候选首帧，改为探测派生上下文（参考关键帧可达性）。
   */
  derivedFirstFramePlan?: {
    referenceKeyframes: string[];
    productAssetUrls: string[];
  } | null;
  hasVideoProviderConfig: boolean;
  providerName: string;
  supportsPaidAcceleration: boolean;
  /** 目标成片参数（预检比例/分辨率/时长约束） */
  targetAspectRatio?: string;
  targetResolution?: string;
  targetDurationSec?: number;
}

export interface PreflightDeps {
  /** 余额查询；默认无法验证（不假装有余额） */
  balanceProvider?: () => Promise<BalancePreflight>;
  /** 等待区间估算；默认按模型确定性估算 */
  waitEstimator?: (videoModelId: string) => WaitEstimate;
  /** 素材探测；默认本地文件系统 + 远端 unverified（不产生网络调用） */
  materialProbe?: (url: string, kind: MaterialCheck['kind']) => Promise<MaterialCheck>;
  /** 素材元数据（比例/时长/分辨率）；默认从 materials 表按 URL 匹配 */
  getMaterialMeta?: (url: string) => {
    aspectRatio?: string;
    durationSec?: number;
    resolution?: string;
  } | null;
}

/** 默认余额：无法验证 —— 明确显示「无法验证余额」，不假装有余额 */
export const DEFAULT_BALANCE_PROVIDER = async (): Promise<BalancePreflight> => ({
  verified: false,
  balanceUsd: 'unknown',
  shortfallUsd: 'unknown',
  provider: '余额 API 未接入',
});

/** 确定性等待区间（秒）：来源 = model-catalog speedMs + 队列缓冲 */
export function defaultWaitEstimator(videoModelId: string): WaitEstimate {
  switch (videoModelId) {
    case 'Seedance 2.0 Fast':
      return {
        minSec: 90,
        maxSec: 240,
        evidenceSource:
          'model-catalog:Seedance 2.0 Fast speedMs=3.2s（渲染）+ 排队缓冲区间 [90s, 240s]（估算，非账单）',
      };
    case 'Seedance 2.0':
      return {
        minSec: 180,
        maxSec: 480,
        evidenceSource:
          'model-catalog:Seedance 2.0 speedMs=7.2s（渲染）+ 排队缓冲区间 [180s, 480s]（估算，非账单）',
      };
    default:
      return {
        minSec: 60,
        maxSec: 600,
        evidenceSource: '未知模型兜底区间 [60s, 600s]（估算，非账单）',
      };
  }
}

function issue(
  code: string,
  level: PreflightIssue['level'],
  message: string,
  source: string,
  detail: string,
  fix: PreflightIssue['fix'],
  artifact?: string
): PreflightIssue {
  return { code, level, message, evidence: { source, detail, artifact }, fix };
}

/**
 * 本地素材探测：/uploads 相对路径按磁盘存在性判定；http(s) 远端无法探测 → unverified
 * （沿用 S1「无法探测不默认 ok」语义，不产生网络调用）。
 */
export function defaultMaterialProbe(
  url: string,
  kind: MaterialCheck['kind'],
  uploadsDir: string,
  getMeta: PreflightDeps['getMaterialMeta']
): Promise<MaterialCheck> {
  const normalized = url.startsWith('/') ? url : `/${url}`;
  const isLocal = normalized.startsWith('/uploads/');
  if (!isLocal) {
    const meta = getMeta?.(url) ?? null;
    return Promise.resolve({
      kind,
      url,
      ok: false,
      status: 'unverified',
      detail: '远端素材无法在本机探测，提交前由 provider 可达性预检判定',
      ...(meta || {}),
    });
  }
  const filePath = path.join(uploadsDir, normalized.replace(/^\/uploads\//, ''));
  const exists = fs.existsSync(filePath);
  const meta = getMeta?.(url) ?? null;
  return Promise.resolve({
    kind,
    url,
    ok: exists,
    status: exists ? 'verified' : 'missing',
    detail: exists ? '素材文件存在于本地' : '素材文件缺失',
    ...(meta || {}),
  });
}

/**
 * 运行提交前预检。
 * blockers 非空 → canSubmit=false（路由/控制器必须阻止任何 provider 提交）。
 */
export async function runSubmissionPreflight(
  input: PreflightInput,
  deps: PreflightDeps = {}
): Promise<PreflightResult> {
  const blockers: PreflightIssue[] = [];
  const warnings: PreflightIssue[] = [];
  const capability: ShotCapabilityMatch[] = [];
  const materials: MaterialCheck[] = [];

  const balanceProvider = deps.balanceProvider ?? DEFAULT_BALANCE_PROVIDER;
  const waitEstimator = deps.waitEstimator ?? defaultWaitEstimator;
  const materialProbe =
    deps.materialProbe ??
    ((url: string, kind: MaterialCheck['kind']) =>
      defaultMaterialProbe(url, kind, process.env.UPLOADS_DIR || './uploads', deps.getMaterialMeta ?? null));

  const videoModel = input.modelConfigs.find((m) => m.id === input.videoModelId);
  const modelCode = videoModel?.modelCode || '';
  const modelEnabled = Boolean(videoModel?.enabled);

  // ---- 1. 能力：每镜模型与能力匹配 ----
  for (const shot of input.shots) {
    const match = matchShotCapability(shot.modelId || input.videoModelId, shot.capabilityConstraints);
    capability.push({
      shotIndex: shot.shotIndex,
      modelId: shot.modelId || input.videoModelId,
      supported: match.supported,
      constraintsMet: match.met,
      constraintsFailed: match.failed,
    });
    if (!match.supported) {
      blockers.push(
        issue(
          'capability_unsupported',
          'blocker',
          `第 ${shot.shotIndex} 镜：模型 ${shot.modelId || input.videoModelId} 不满足该镜能力约束`,
          'model-catalog',
          match.failed.join('；'),
          {
            kind: 'switch_model',
            label: '在模型配置中心切换到支持该镜约束的视频模型',
          }
        )
      );
    }
  }

  // ---- 2. provider 配置 ----
  if (!input.hasVideoProviderConfig) {
    blockers.push(
      issue(
        'provider_unconfigured',
        'blocker',
        '视频生成服务未配置，无法执行付费提交',
        'provider',
        `provider=${input.providerName} 未配置（SEEDANCE_BASE_URL / ACCOUNT / PASSWORD 或 fake seam 未启用）`,
        { kind: 'configure', label: '配置视频生成服务（环境变量或模型配置中心）' }
      )
    );
  }
  if (input.videoModelId && !videoModel) {
    blockers.push(
      issue(
        'video_model_missing',
        'blocker',
        `视频模型「${input.videoModelId}」不在模型目录中`,
        'model-catalog',
        `modelConfigs 中不存在 id=${input.videoModelId}`,
        { kind: 'switch_model', label: '选择模型目录中存在的视频模型' }
      )
    );
  } else if (videoModel && !modelEnabled) {
    blockers.push(
      issue(
        'video_model_disabled',
        'blocker',
        `视频模型「${input.videoModelId}」已停用`,
        'model-catalog',
        `model id=${input.videoModelId} enabled=0`,
        { kind: 'switch_model', label: '启用该模型或选择其他视频模型' }
      )
    );
  }

  // ---- 3. 素材可达性 / 比例 / 时长 / 分辨率 / 参考输入数量 ----
  const candidateRefs: Array<{ url: string }> = [];
  // S3：镜头没有用户首帧时，若存在派生计划（参考关键帧 + 产品图），
  // 预检探测派生上下文并放行（首帧由提交时系统派生 + 独立预检把关），不再要求用户提供首帧。
  const canDeriveFirstFrames =
    Boolean(input.derivedFirstFramePlan) &&
    Array.isArray(input.derivedFirstFramePlan?.referenceKeyframes) &&
    input.derivedFirstFramePlan.referenceKeyframes.length > 0;
  for (const shot of input.shots) {
    if (shot.candidates.length === 0) {
      if (canDeriveFirstFrames) {
        warnings.push(
          issue(
            'first_frame_will_be_derived',
            'warning',
            `第 ${shot.shotIndex} 镜首帧将由系统派生（爆款参考关键帧 + 产品图 → 产品条件化首帧），提交前执行独立预检`,
            'materials',
            '新输入模型：用户不提供首帧，derivedFirstFrameUrl 为内部派生产物',
            { kind: 'wait', label: '无需操作：提交时自动派生并预检' }
          )
        );
      } else {
        blockers.push(
          issue(
            'first_frame_missing',
            'blocker',
            `第 ${shot.shotIndex} 镜缺少首帧素材，且无首帧派生上下文（参考关键帧/产品图）`,
            'materials',
            '该镜没有候选首帧图，也无法由 参考关键帧 + 产品图 派生，无法以图生视频',
            { kind: 'upload', label: '为该镜生成或上传首帧图（或先完成爆款视频拆解/上传产品图）' }
          )
        );
      }
    } else {
      candidateRefs.push(...shot.candidates);
    }
  }
  const uniqueRefs = [...new Map(candidateRefs.map((c) => [c.url, c])).values()];
  for (const ref of uniqueRefs) {
    const check = await materialProbe(ref.url, 'first_frame');
    materials.push(check);
  }
  // 派生计划下的参考关键帧可达性探测（best-effort：unverified 只告警不阻断，
  // 首帧提交前的独立预检会做最终公网可达性把关）
  if (canDeriveFirstFrames && input.derivedFirstFramePlan) {
    for (const kf of input.derivedFirstFramePlan.referenceKeyframes.slice(0, 4)) {
      const check = await materialProbe(kf, 'reference');
      materials.push(check);
      if (check.status === 'missing') {
        blockers.push(
          issue(
            'reference_keyframe_missing',
            'blocker',
            `参考关键帧不可达：${kf}`,
            'materials',
            check.detail || '参考关键帧文件缺失，无法派生首帧',
            { kind: 'upload', label: '重新提取/上传爆款视频参考关键帧' },
            kf
          )
        );
      } else if (check.status === 'unverified') {
        warnings.push(
          issue(
            'reference_keyframe_unverified',
            'warning',
            `参考关键帧可达性未验证：${kf}`,
            'materials',
            check.detail || '远端素材无法本机探测，提交前预检将最终把关',
            { kind: 'wait', label: '首帧提交前预检会校验公网可达性' },
            kf
          )
        );
      }
    }
  }

  const referenceInputCount = input.referenceInputCount ?? 1;
  if (referenceInputCount < 1) {
    blockers.push(
      issue(
        'missing_product_asset',
        'blocker',
        '缺少产品素材：至少需要 1 个产品参考输入',
        'product-assets',
        `referenceInputCount=${referenceInputCount}`,
        { kind: 'upload', label: '为当前产品上传产品图（品牌知识库 → 产品资产）' }
      )
    );
  }

  for (const m of materials) {
    if (m.status === 'missing') {
      blockers.push(
        issue(
          'material_missing',
          'blocker',
          `素材不可达：${m.url}`,
          'materials',
          m.detail || '素材文件缺失',
          { kind: 'upload', label: '重新上传该素材' },
          m.url
        )
      );
    } else if (m.status === 'unverified') {
      warnings.push(
        issue(
          'material_unverified',
          'warning',
          `素材 ${m.url} 为远端地址，提交前会由 provider 做可达性预检`,
          'materials',
          m.detail || '远端素材无法在本机探测',
          null,
          m.url
        )
      );
    }
  }

  // 目标参数约束（比例/分辨率/时长）由能力匹配校验；此处补素材元数据警告
  const withMeta = materials.filter((m) => m.aspectRatio || m.durationSec || m.resolution);
  for (const m of withMeta) {
    if (input.targetAspectRatio && m.aspectRatio && m.aspectRatio !== input.targetAspectRatio) {
      warnings.push(
        issue(
          'material_aspect_mismatch',
          'warning',
          `素材比例 ${m.aspectRatio} 与目标比例 ${input.targetAspectRatio} 不一致`,
          'materials',
          `url=${m.url} aspectRatio=${m.aspectRatio} target=${input.targetAspectRatio}`,
          { kind: 'select', label: '更换比例匹配的素材或调整目标比例' },
          m.url
        )
      );
    }
  }

  // ---- 4. 成本：逐镜汇总（unknown 不变成 0，亚分不丢精度） ----
  const candidateCount = Math.max(1, input.candidateCountPerShot ?? 1);
  const perShot: ShotCostEstimate[] = input.shots.map((shot) => {
    const totalMicros = estimateVideoShotUsdMicros(modelCode, candidateCount);
    return {
      shotIndex: shot.shotIndex,
      shotId: undefined,
      modelId: shot.modelId || input.videoModelId,
      estimatedUsd: microsToUsd(totalMicros),
      estimatedUsdMicros: totalMicros,
    };
  });
  const totalMicros = sumShotCostMicros(perShot.map((p) => p.estimatedUsdMicros));
  if (totalMicros === null) {
    warnings.push(
      issue(
        'cost_unpriced',
        'warning',
        `模型 ${input.videoModelId} 无定价，预估成本为 unknown（不会写成 0）`,
        'cost-estimator',
        `modelCode=${modelCode || '(未找到)'} 不在定价表`,
        { kind: 'switch_model', label: '切换到已定价模型以显示预估成本' }
      )
    );
  }

  // ---- 5. 余额 ----
  const balance = await balanceProvider();
  if (!balance.verified) {
    warnings.push(
      issue(
        'balance_unverifiable',
        'warning',
        '无法验证余额（余额 API 未接入），提交前请自行确认额度',
        'balance-api',
        `provider=${balance.provider} verified=false`,
        null
      )
    );
  } else if (balance.shortfallUsd !== 'unknown' && balance.shortfallUsd > 0) {
    blockers.push(
      issue(
        'insufficient_balance',
        'blocker',
        `余额不足，差额 $${balance.shortfallUsd.toFixed(6)}`,
        'balance-api',
        `balanceUsd=${balance.balanceUsd} shortfall=${balance.shortfallUsd}`,
        { kind: 'wait', label: '充值后重试' }
      )
    );
  }

  // ---- 6. 等待区间 ----
  const wait = waitEstimator(input.videoModelId);

  // ---- 7. 减成本策略（provider 不支持 → 禁用并解释） ----
  const videoCap = getModelCapability(input.videoModelId).video;
  const strategies: CostReductionStrategy[] = [
    {
      id: 'fewer_candidates',
      label: '减少候选数量',
      supported: candidateCount > 1,
      reason: candidateCount > 1 ? `当前每镜 ${candidateCount} 个候选，可减为 1` : '当前已是单候选，无减少空间',
    },
    {
      id: 'economy_model',
      label: '经济档模型',
      supported: Boolean(videoCap && videoCap.economyTier !== 'economy' && input.videoModelId !== 'Seedance 2.0 Fast'),
      reason:
        videoCap && videoCap.economyTier !== 'economy'
          ? '可切换到经济档模型（Seedance 2.0 Fast）降低单价'
          : '当前已是经济档，无更低档模型',
    },
    {
      id: 'free_queue',
      label: '免费排队',
      supported: false,
      reason: 'provider 不支持免费排队通道，提交后只能等待生成队列',
    },
    {
      id: 'paid_acceleration',
      label: '付费加速',
      supported: input.supportsPaidAcceleration,
      reason: input.supportsPaidAcceleration ? 'provider 支持付费加速' : 'provider 不支持付费加速（星河 Seedance 中转未提供加速通道）',
    },
  ];

  return {
    ok: blockers.length === 0,
    canSubmit: blockers.length === 0,
    blockers,
    warnings,
    cost: {
      perShot,
      totalEstimatedUsd: microsToUsd(totalMicros),
      actualUsd: 'unknown',
      unknownActual: true,
      currency: 'USD',
      evidenceSource: 'cost-estimator（微美元整数运算，账单接入后以 cost_ledger 为准）',
    },
    balance,
    wait,
    capability,
    materials,
    strategies,
    checkedAt: Date.now(),
  };
}
