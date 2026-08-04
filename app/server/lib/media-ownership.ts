import type { NextFunction, Request, Response } from 'express';
import { db } from './db';

/**
 * S2.1：先解码百分号编码再校验，杜绝 `%2e%2e` / `%5c` 编码绕过。
 * express.static 会解码 URL 后解析文件系统路径，因此这里必须用
 * 解码后的规范路径做 `..`/`\`/前缀检查，否则 `/uploads/bgm/%2e%2e/renders/x.mp4`
 * 会在 BGM 全放行分支放行后由 static 解码越权读取任意文件。
 */
function normalizedUploadPath(value: string): string | null {
  const withSlash = value.startsWith('/') ? value : `/${value}`;
  let decoded: string;
  try {
    decoded = decodeURIComponent(withSlash);
  } catch {
    return null; // 非法百分号编码直接拒绝
  }
  if (!decoded.startsWith('/uploads/') || decoded.includes('..') || decoded.includes('\\')) {
    return null;
  }
  return decoded;
}

export function registerOwnedMedia(path: string, ownerId: string, kind = 'render') {
  const normalized = normalizedUploadPath(path);
  if (!normalized || !ownerId) return;
  db.prepare(
    `INSERT INTO media_ownership (path, owner_id, kind)
     VALUES (?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET owner_id = excluded.owner_id, kind = excluded.kind`
  ).run(normalized, ownerId, kind);
}

export function canReadOwnedMedia(
  path: string,
  ownerId: string,
  isAdmin: boolean,
  permissions: string[] = []
): boolean {
  const normalized = normalizedUploadPath(path);
  if (!normalized) return false;
  if (isAdmin) return true;
  // 兼容两种存储语义：解码后路径（与 express.static 实际服务路径一致）与原始路径
  const candidates = [normalized, path.startsWith('/') ? path : `/${path}`];
  for (const candidate of candidates) {
    // S2.3：BGM 曲库媒体放行要求 module.bgm.read 权限（防御未来角色扩展，
    // 当前 admin/operator 均具备该权限，行为不变）
    if (candidate.startsWith('/uploads/bgm/')) {
      if (permissions.includes('module.bgm.read')) return true;
      continue;
    }

    const direct = db.prepare(
      'SELECT 1 FROM media_ownership WHERE path = ? AND owner_id = ?'
    ).get(candidate, ownerId);
    if (direct) return true;

    const material = db.prepare(
      `SELECT 1 FROM materials
        WHERE owner_id = ?
          AND (url = ? OR '/' || REPLACE(file_path, '\\', '/') = ?)
        LIMIT 1`
    ).get(ownerId, candidate, candidate);
    if (material) return true;

    // Product visual assets (shared knowledge-base identity pack for the product)
    try {
      const productAsset = db.prepare(
        `SELECT 1 FROM product_assets
          WHERE url = ? OR '/' || REPLACE(COALESCE(file_path, ''), '\\', '/') = ?
          LIMIT 1`
      ).get(candidate, candidate);
      if (productAsset) return true;
    } catch {
      /* table may not exist in legacy test DBs mid-migration */
    }

    const keyframe = db.prepare(
      `SELECT 1
         FROM video_preprocess_cache
         JOIN materials ON materials.id = video_preprocess_cache.id
        WHERE materials.owner_id = ?
          AND video_preprocess_cache.keyframe_urls LIKE ?
        LIMIT 1`
    ).get(ownerId, `%"${candidate}"%`);
    if (keyframe) return true;

    if (db.prepare(
      `SELECT 1
         FROM artifacts
         JOIN pipeline_runs ON pipeline_runs.id = artifacts.run_id
        WHERE pipeline_runs.owner_id = ? AND artifacts.uri = ?
        LIMIT 1`
    ).get(ownerId, candidate)) {
      return true;
    }
  }
  return false;
}

export function canUseMediaReference(
  value: string,
  ownerId: string,
  isAdmin: boolean
): boolean {
  if (!value) return true;
  if (value.startsWith('https://') || value.startsWith('http://')) return true;
  const normalized = normalizedUploadPath(value);
  return Boolean(normalized && canReadOwnedMedia(normalized, ownerId, isAdmin));
}

export function requireOwnedUpload(req: Request, res: Response, next: NextFunction) {
  const mediaPath = `/uploads${req.path}`;
  if (
    req.authUser &&
    canReadOwnedMedia(
      mediaPath,
      req.authUser.id,
      req.authUser.role === 'admin',
      req.authUser.permissions || []
    )
  ) {
    return next();
  }
  return res.status(404).json({ success: false, error: '媒体不存在或无权访问' });
}
