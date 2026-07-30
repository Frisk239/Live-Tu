import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function backupMaintenanceGuard(options?: { dataDir?: string }) {
  const dataDir = path.resolve(
    options?.dataDir || process.env.DATA_DIR || path.join(process.cwd(), 'data')
  );
  const lockPath = path.join(dataDir, '.backup.lock');
  const leasesDir = path.join(dataDir, '.mutation-leases');

  return (req: Request, res: Response, next: NextFunction) => {
    if (!MUTATION_METHODS.has(req.method)) return next();
    if (fs.existsSync(lockPath)) {
      res.setHeader('Retry-After', '30');
      return res.status(503).json({
        success: false,
        error: 'Backup maintenance is in progress; retry this mutation later',
      });
    }

    fs.mkdirSync(leasesDir, { recursive: true });
    const leasePath = path.join(
      leasesDir,
      `${process.pid}-${Date.now()}-${randomUUID()}.lease`
    );
    try {
      fs.writeFileSync(
        leasePath,
        JSON.stringify({ pid: process.pid, method: req.method, path: req.path }),
        { flag: 'wx' }
      );
    } catch (error) {
      return next(error);
    }

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      try {
        fs.unlinkSync(leasePath);
      } catch {}
    };

    if (fs.existsSync(lockPath)) {
      cleanup();
      res.setHeader('Retry-After', '30');
      return res.status(503).json({
        success: false,
        error: 'Backup maintenance is in progress; retry this mutation later',
      });
    }

    res.once('finish', cleanup);
    res.once('close', cleanup);
    return next();
  };
}
