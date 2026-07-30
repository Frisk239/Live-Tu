import type { NextFunction, Request, Response } from 'express';
import { db } from './db';

function normalizedUploadPath(value: string): string | null {
  const path = value.startsWith('/') ? value : `/${value}`;
  if (!path.startsWith('/uploads/') || path.includes('..') || path.includes('\\')) return null;
  return path;
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

export function canReadOwnedMedia(path: string, ownerId: string, isAdmin: boolean): boolean {
  const normalized = normalizedUploadPath(path);
  if (!normalized) return false;
  if (isAdmin) return true;
  if (normalized.startsWith('/uploads/bgm/')) return true;

  const direct = db.prepare(
    'SELECT 1 FROM media_ownership WHERE path = ? AND owner_id = ?'
  ).get(normalized, ownerId);
  if (direct) return true;

  const material = db.prepare(
    `SELECT 1 FROM materials
      WHERE owner_id = ?
        AND (url = ? OR '/' || REPLACE(file_path, '\\', '/') = ?)
      LIMIT 1`
  ).get(ownerId, normalized, normalized);
  if (material) return true;

  const keyframe = db.prepare(
    `SELECT 1
       FROM video_preprocess_cache
       JOIN materials ON materials.id = video_preprocess_cache.id
      WHERE materials.owner_id = ?
        AND video_preprocess_cache.keyframe_urls LIKE ?
      LIMIT 1`
  ).get(ownerId, `%"${normalized}"%`);
  if (keyframe) return true;

  return Boolean(db.prepare(
    `SELECT 1
       FROM artifacts
       JOIN pipeline_runs ON pipeline_runs.id = artifacts.run_id
      WHERE pipeline_runs.owner_id = ? AND artifacts.uri = ?
      LIMIT 1`
  ).get(ownerId, normalized));
}

export function requireOwnedUpload(req: Request, res: Response, next: NextFunction) {
  const mediaPath = `/uploads${req.path}`;
  if (
    req.authUser &&
    canReadOwnedMedia(mediaPath, req.authUser.id, req.authUser.role === 'admin')
  ) {
    return next();
  }
  return res.status(404).json({ success: false, error: '媒体不存在或无权访问' });
}
