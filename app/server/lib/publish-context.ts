/**
 * 产品上下文守卫（S0：产品切换污染修复，第二轮回合）
 *
 * 可追溯来源有两条，守卫合并校验：
 *  - artifacts：编排器（后台 Run）落库的产物，run 归属限定 owner；
 *  - generated_media：手工五步链路（/api/pipeline/step2、/step5）生成的产物登记，
 *    否则「未登记的旧成片」可以绕过守卫跨产品发布。
 *
 * 守卫规则（命中可追溯来源的 URL）：
 *   1. stale → 禁止发布（产品切换后旧产物作废）；
 *   2. product_id 与请求不一致 → 禁止（旧产品产物不得冒充新产品结果）；
 *   3. 绑定产品但版本缺失或与当前 revision 不一致 → 禁止（同秒更新、legacy 产物都走这里）。
 * 未命中任何可追溯来源的 URL（上传素材等）无法证明归属，放行给发布门禁其余检查。
 */
import { db } from './db';

export type PublishContextVerdict =
  | { ok: true }
  | {
      ok: false;
      code: 'STALE_ARTIFACT' | 'PRODUCT_MISMATCH' | 'PRODUCT_VERSION_MISMATCH';
      reason: string;
      artifactId: string;
      artifactProductId: string | null;
    };

function checkRows(
  rows: Array<{
    id: string;
    product_id: string | null;
    product_version: string | null;
    stale: number;
  }>,
  productId: string | undefined,
  currentProductVersion: string | null
): PublishContextVerdict | null {
  for (const row of rows) {
    if (row.stale === 1) {
      return {
        ok: false,
        code: 'STALE_ARTIFACT',
        reason:
          '该视频源所属产品已切换上下文，产物已标记过期（stale）。请重新生成对应镜头/成片后再发布。',
        artifactId: row.id,
        artifactProductId: row.product_id,
      };
    }
    if (productId && row.product_id && row.product_id !== productId) {
      return {
        ok: false,
        code: 'PRODUCT_MISMATCH',
        reason: `视频源绑定产品（${row.product_id}）与当前产品（${productId}）不一致，禁止作为当前产品成片发布。`,
        artifactId: row.id,
        artifactProductId: row.product_id,
      };
    }
    // 有产品绑定的产物必须带当前版本：NULL/旧格式版本（legacy 升级前产物）
    // 或与当前 revision 不一致（产品被编辑，含同秒编辑）都一律阻断。
    if (row.product_id) {
      if (!row.product_version || !currentProductVersion) {
        return {
          ok: false,
          code: 'PRODUCT_VERSION_MISMATCH',
          reason:
            '该产物缺少可信产品版本记录（升级前遗留产物或未登记版本），禁止发布，请重新生成。',
          artifactId: row.id,
          artifactProductId: row.product_id,
        };
      }
      if (String(row.product_version) !== String(currentProductVersion)) {
        return {
          ok: false,
          code: 'PRODUCT_VERSION_MISMATCH',
          reason:
            '产品信息自该成片生成后已被修改（版本不一致），旧版本成片禁止发布，请重新生成。',
          artifactId: row.id,
          artifactProductId: row.product_id,
        };
      }
    }
  }
  return null;
}

/**
 * 校验待发布的视频源是否仍属于当前产品上下文。
 * 同时查 artifacts（编排器产物）与 generated_media（手工链路产物）。
 */
export function assertPublishableVideoContext(
  productId: string | undefined,
  urls: Array<string | null | undefined>,
  currentProductVersion: string | null | undefined,
  ownerId: string
): PublishContextVerdict {
  const real = [...new Set(urls.filter(Boolean).map((u) => String(u)))];
  if (real.length === 0) return { ok: true };

  const placeholders = real.map(() => '?').join(', ');
  const artifactRows = db
    .prepare(
      `SELECT a.id, a.product_id, a.product_version, a.stale
         FROM artifacts a
         JOIN pipeline_runs r ON r.id = a.run_id
        WHERE r.owner_id = ? AND a.uri IN (${placeholders})`
    )
    .all(ownerId, ...real) as Array<{
    id: string;
    product_id: string | null;
    product_version: string | null;
    stale: number;
  }>;
  const verdict = checkRows(artifactRows, productId, currentProductVersion ?? null);
  if (verdict) return verdict;

  const mediaRows = db
    .prepare(
      `SELECT id, product_id, product_version, stale
         FROM generated_media
        WHERE owner_id = ? AND uri IN (${placeholders})`
    )
    .all(ownerId, ...real) as Array<{
    id: string;
    product_id: string | null;
    product_version: string | null;
    stale: number;
  }>;
  const mediaVerdict = checkRows(mediaRows, productId, currentProductVersion ?? null);
  if (mediaVerdict) return mediaVerdict;

  return { ok: true };
}

/**
 * 切换产品上下文：把**当前用户**绑定到其他产品的产物标记为 stale。
 * 同时作废 artifacts（按 run 归属限定 owner）与 generated_media（手工链路，按 product 归属）。
 * 返回受影响数量。
 */
export function markStaleArtifactsExceptProduct(
  productId: string,
  ownerId: string
): { staleCount: number } {
  db.exec('BEGIN IMMEDIATE');
  try {
    const artifactResult = db
      .prepare(
        `UPDATE artifacts
            SET stale = 1
          WHERE product_id IS NOT NULL AND product_id != ? AND stale = 0
            AND run_id IN (
              SELECT id FROM pipeline_runs WHERE owner_id = ?
            )`
      )
      .run(productId, ownerId);
    const mediaResult = db
      .prepare(
        `UPDATE generated_media
            SET stale = 1
          WHERE owner_id = ? AND product_id IS NOT NULL AND product_id != ? AND stale = 0`
      )
      .run(ownerId, productId);
    db.exec('COMMIT');
    return {
      staleCount: Number(artifactResult.changes) + Number(mediaResult.changes),
    };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * 手工五步链路产物登记：/api/pipeline/step2、/step5 生成视频/成片时调用，
 * 使发布守卫能追溯这些 URL 的产品归属（跨产品发布 100% 阻断的前提）。
 * 同一 URI 只登记一次（保留最早归属）。
 */
export function registerGeneratedMedia(
  productId: string | undefined,
  productVersion: string | number | null,
  urls: Array<string | null | undefined>,
  ownerId: string
): { registered: number } {
  const real = [...new Set(urls.filter(Boolean).map((u) => String(u)))];
  if (real.length === 0 || !productId) return { registered: 0 };
  let registered = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    const insert = db.prepare(`
      INSERT INTO generated_media (id, product_id, product_version, uri, kind, owner_id)
      SELECT ?, ?, ?, ?, 'step_output', ?
      WHERE NOT EXISTS (
        SELECT 1 FROM generated_media WHERE owner_id = ? AND uri = ?
      )
    `);
    for (const uri of real) {
      const result = insert.run(
        `gm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        productId,
        productVersion == null ? null : String(productVersion),
        uri,
        ownerId,
        ownerId,
        uri
      );
      if (Number(result.changes) > 0) registered += 1;
    }
    db.exec('COMMIT');
    return { registered };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * S0 provenance：product_conditioned 声明必须由服务端可验证的证据支撑。
 * 证据只能是（a）该产品在 product_assets 登记的真实资产 URL，或
 * （b）可追溯来源（artifacts/generated_media）中绑定该产品的未过期产物 URL。
 * 绝不信任客户端提交的 firstFrameEvidenceUrl 字段。
 */
export function isTrustedFirstFrameEvidence(
  productId: string | undefined,
  evidenceUrl: string | null | undefined,
  ownerId: string
): boolean {
  if (!productId || !evidenceUrl || !String(evidenceUrl).trim()) return false;
  const url = String(evidenceUrl).trim();
  const inAssets = db
    .prepare('SELECT 1 FROM product_assets WHERE product_id = ? AND url = ?')
    .get(productId, url);
  if (inAssets) return true;
  const inArtifacts = db
    .prepare(
      `SELECT 1
         FROM artifacts a
         JOIN pipeline_runs r ON r.id = a.run_id
        WHERE r.owner_id = ? AND a.product_id = ? AND a.uri = ? AND a.stale = 0`
    )
    .get(ownerId, productId, url);
  if (inArtifacts) return true;
  const inMedia = db
    .prepare(
      `SELECT 1 FROM generated_media
        WHERE owner_id = ? AND product_id = ? AND uri = ? AND stale = 0`
    )
    .get(ownerId, productId, url);
  return Boolean(inMedia);
}
