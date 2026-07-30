import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type StorageDirectoryReadiness = {
  ready: boolean;
  path: string;
  freeBytes: number | null;
  error?: string;
};

function probeDirectory(
  directory: string,
  minimumFreeBytes: number
): StorageDirectoryReadiness {
  const resolved = path.resolve(directory);
  const probePath = path.join(resolved, `.readiness-${process.pid}-${randomUUID()}`);
  let freeBytes: number | null = null;
  try {
    fs.mkdirSync(resolved, { recursive: true });
    fs.writeFileSync(probePath, 'ok', { flag: 'wx' });
    fs.unlinkSync(probePath);
    const stats = fs.statfsSync(resolved);
    freeBytes = Number(stats.bavail) * Number(stats.bsize);
    if (freeBytes < minimumFreeBytes) {
      return {
        ready: false,
        path: resolved,
        freeBytes,
        error: `free storage ${freeBytes} is below minimum ${minimumFreeBytes}`,
      };
    }
    return { ready: true, path: resolved, freeBytes };
  } catch (error: any) {
    try {
      if (fs.existsSync(probePath)) fs.unlinkSync(probePath);
    } catch {}
    return {
      ready: false,
      path: resolved,
      freeBytes,
      error: String(error?.message || error),
    };
  }
}

export function probeStorageReadiness(
  dataDir: string,
  uploadsDir: string,
  minimumFreeBytes: number
) {
  const data = probeDirectory(dataDir, minimumFreeBytes);
  const uploads = probeDirectory(uploadsDir, minimumFreeBytes);
  const freeValues = [data.freeBytes, uploads.freeBytes].filter(
    (value): value is number => value !== null
  );
  return {
    ready: data.ready && uploads.ready,
    freeBytes: freeValues.length > 0 ? Math.min(...freeValues) : null,
    minimumFreeBytes,
    data,
    uploads,
    ...(!data.ready || !uploads.ready
      ? {
          error: [
            !data.ready ? `DATA_DIR: ${data.error || 'probe failed'}` : '',
            !uploads.ready ? `UPLOADS_DIR: ${uploads.error || 'probe failed'}` : '',
          ].filter(Boolean).join('; '),
        }
      : {}),
  };
}
