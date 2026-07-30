import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { db } from './db';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function classify(pathname: string): { entityType: string; entityId: string | null } {
  const parts = pathname.split('/').filter(Boolean);
  const apiIndex = parts.findIndex((part) => part === 'api');
  const versionOffset = parts[apiIndex + 1] === 'v1' ? 1 : 0;
  const resourceIndex = apiIndex + 1 + versionOffset;
  return {
    entityType: parts[resourceIndex] || 'unknown',
    entityId: parts[resourceIndex + 1] || null,
  };
}

export function auditMutations(req: Request, res: Response, next: NextFunction) {
  if (!MUTATING_METHODS.has(req.method)) return next();

  const startedAt = Date.now();
  const originalPath = req.originalUrl.split('?', 1)[0];
  res.on('finish', () => {
    if (!req.authUser || res.statusCode >= 500) return;
    const { entityType, entityId } = classify(originalPath);
    try {
      db.prepare(
        `INSERT INTO audit_logs
          (id, user_id, action, entity_type, entity_id, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        randomUUID(),
        req.authUser.id,
        `${req.method} ${originalPath}`,
        entityType,
        entityId,
        JSON.stringify({
          status: res.statusCode,
          durationMs: Date.now() - startedAt,
          ip: req.ip,
        })
      );
    } catch (error) {
      console.error('[audit] Failed to persist mutation audit log:', error);
    }
  });
  next();
}
