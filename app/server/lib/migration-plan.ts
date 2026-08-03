/**
 * Shot migration plan builder — pure function, no I/O.
 * Converts Structure IR + product assets into per-shot product-bound first-frame intent.
 */

export type ProductAssetRole =
  | 'hero'
  | 'angle'
  | 'detail'
  | 'texture'
  | 'in_use'
  | 'packaging_text';

export interface ProductAssetRef {
  id: string;
  url: string;
  role?: ProductAssetRole | string;
  sortOrder?: number;
}

export interface StructureShotLike {
  shotIndex?: number;
  startTime?: string;
  endTime?: string;
  shotType?: string;
  cameraMovement?: string;
  description?: string;
  keyframeUrl?: string;
  mood?: string;
}

export interface StructureIRLike {
  scene?: string;
  subject?: string;
  style?: string;
  mood?: string;
  static_image_prompt?: string;
  shotList?: StructureShotLike[];
  videoStructure?: {
    narrativeArc?: string;
    hookTiming?: string;
    pacing?: string;
  };
  migrationHints?: {
    mustKeep?: string[];
    mustReplace?: string[];
    productInsertRules?: string;
  };
  narrativeBeats?: Array<{
    beat?: string;
    startSec?: number;
    endSec?: number;
    intent?: string;
  }>;
}

export interface MigrationShot {
  shotIndex: number;
  structureBrief: string;
  productFramePrompt: string;
  motionPrompt: string;
  durationSec: 5 | 10;
  /** Viral keyframe — structure reference only; never final Seedance first frame */
  referenceKeyframeUrl?: string;
  /** Final first-frame source for i2v — always product-derived */
  productFirstFrameUrl: string;
  productAssetIds: string[];
  firstFrameSource: 'product_conditioned';
  qaChecks: string[];
}

export interface ShotMigrationPlan {
  shots: MigrationShot[];
  targetTotalSec: number;
  aspectRatio: '9:16';
  resolution: '720p' | '1080p';
  productHeroUrl: string;
  firstFrameSource: 'product_conditioned';
}

export interface BuildMigrationPlanOptions {
  maxShots?: number;
  durationSecPerShot?: 5 | 10;
  resolution?: '720p' | '1080p';
  productName?: string;
}

function pickHeroAsset(assets: ProductAssetRef[]): ProductAssetRef | null {
  if (!assets.length) return null;
  const sorted = [...assets].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  return sorted.find((a) => a.role === 'hero') || sorted[0];
}

function clampShots<T>(shots: T[], max: number): T[] {
  if (shots.length <= max) return shots;
  if (max <= 2) return shots.slice(0, max);
  // Keep first (hook), last (cta), and evenly sample middle
  const first = shots[0];
  const last = shots[shots.length - 1];
  const middleBudget = max - 2;
  const middle = shots.slice(1, -1);
  const sampled: T[] = [];
  for (let i = 0; i < middleBudget && middle.length > 0; i++) {
    const idx = Math.floor((i * middle.length) / middleBudget);
    sampled.push(middle[Math.min(idx, middle.length - 1)]);
  }
  // de-dupe by reference
  const out = [first, ...sampled.filter((s) => s !== first && s !== last)];
  if (last !== first) out.push(last);
  return out.slice(0, max);
}

/**
 * Build a migration plan. Throws if no product assets (product identity required).
 */
export function buildShotMigrationPlan(
  structure: StructureIRLike | null | undefined,
  productAssets: ProductAssetRef[],
  options: BuildMigrationPlanOptions = {}
): ShotMigrationPlan {
  const hero = pickHeroAsset(productAssets);
  if (!hero?.url) {
    throw Object.assign(new Error('产品视觉资产缺失：爆款直出至少需要 1 张产品图'), {
      code: 'MISSING_PRODUCT_ASSETS',
      status: 400,
    });
  }

  const maxShots = Math.min(12, Math.max(1, options.maxShots ?? 6));
  const durationSec = options.durationSecPerShot === 10 ? 10 : 5;
  const productName = options.productName || 'Product';
  const assetIds = productAssets.map((a) => a.id).filter(Boolean);
  const heroUrl = hero.url;

  const rawShots =
    Array.isArray(structure?.shotList) && structure!.shotList!.length > 0
      ? structure!.shotList!
      : [
          {
            shotIndex: 1,
            shotType: 'Hook 特写',
            cameraMovement: '快速推进',
            description: structure?.subject || `${productName} 黄金 3 秒 Hook`,
            mood: structure?.mood || '吸睛',
          },
          {
            shotIndex: 2,
            shotType: '产品质感',
            cameraMovement: '微距慢推',
            description: `${productName} 包装与质感展示`,
            mood: '高级质感',
          },
          {
            shotIndex: 3,
            shotType: '转化 CTA',
            cameraMovement: '前推',
            description: `${productName} 行动号召收尾`,
            mood: '强转化',
          },
        ];

  const shotsIn = clampShots(rawShots, maxShots);
  const mustReplace = structure?.migrationHints?.mustReplace || [
    '竞品包装',
    '竞品品牌名',
    '非我方产品主体',
  ];
  const mustKeep = structure?.migrationHints?.mustKeep || [
    structure?.videoStructure?.hookTiming || '前3秒 Hook',
    structure?.style || '爆款节奏',
  ];

  const shots: MigrationShot[] = shotsIn.map((shot, idx) => {
    const shotIndex = Number(shot.shotIndex) || idx + 1;
    const shotType = shot.shotType || '特写';
    const movement = shot.cameraMovement || '平滑推进';
    const desc = shot.description || `镜头 ${shotIndex}`;
    const structureBrief = `${shotType} | ${movement} | ${desc}`;
    const productFramePrompt = [
      `Commercial product hero frame of ${productName}`,
      `shot type: ${shotType}`,
      `composition inspired by: ${desc}`,
      `must show OUR product packaging accurately`,
      `replace: ${mustReplace.join(', ')}`,
      `keep structure cues: ${mustKeep.join(', ')}`,
      '8k, commercial photography, 9:16 vertical',
    ].join(', ');

    const motionPrompt = [
      `Smooth ${movement} focusing on ${productName}`,
      shotType,
      desc,
      '60fps, natural lighting, ultra-realistic product texture, no competitor packaging',
    ].join(', ');

    // Rotate auxiliary product assets for variety while hero stays primary
    const aux = productAssets[idx % productAssets.length] || hero;
    const productFirstFrameUrl = aux.url || heroUrl;

    return {
      shotIndex,
      structureBrief,
      productFramePrompt,
      motionPrompt,
      durationSec,
      referenceKeyframeUrl: shot.keyframeUrl || undefined,
      productFirstFrameUrl,
      productAssetIds: assetIds.length ? assetIds : [hero.id],
      firstFrameSource: 'product_conditioned' as const,
      qaChecks: [
        'product_identity_visible',
        'no_competitor_packaging',
        'vertical_9_16',
        'non_black_frame',
      ],
    };
  });

  const targetTotalSec = Math.min(35, Math.max(12, shots.length * durationSec));

  return {
    shots,
    targetTotalSec,
    aspectRatio: '9:16',
    resolution: options.resolution || '720p',
    productHeroUrl: heroUrl,
    firstFrameSource: 'product_conditioned',
  };
}

/** Resolve product assets from DB rows */
export function mapDbRowsToProductAssets(
  rows: Array<{ id: string; url: string; role?: string; sort_order?: number }>
): ProductAssetRef[] {
  return rows.map((r) => ({
    id: r.id,
    url: r.url,
    role: r.role,
    sortOrder: r.sort_order,
  }));
}
