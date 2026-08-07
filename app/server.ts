// Load env first (side-effect). ESM import order among these still matters for sibling imports —
// seedance now reads process.env at call-time, not import-time.
import './load-env';

import express from 'express';
import path from 'node:path';

import { db, initDatabase } from './server/lib/db';
import { seedanceRouter } from './server/routes/seedance';
import { pipelineRouter } from './server/routes/pipeline';
import { modelsRouter } from './server/routes/models';
import { materialsRouter } from './server/routes/materials';
import { tasksRouter } from './server/routes/tasks';
import { productsRouter, handleSellingPointsOptimize } from './server/routes/products';
import { bgmRouter } from './server/routes/bgm';
import { renderRouter } from './server/routes/render';
import { presetsRouter } from './server/routes/presets';
import { workbenchRouter } from './server/routes/workbench';
import { videoRouter } from './server/routes/video';
import { initializePipelineRuns, runsRouter } from './server/routes/runs';
import { recoverStaleShotClaims } from './server/lib/workflow-controller';
import {
  authRouter,
  initializeAuth,
  limitExpensiveOperations,
  optionalAuth,
  requireAuth,
  requireAuthOrInternal,
  requirePermission,
  sameOriginOnly,
} from './server/lib/auth';
import { migrateStoredModelSecrets } from './server/lib/secrets';
import { auditMutations } from './server/lib/audit';
import { metricsRouter, observeRequests } from './server/lib/observability';
import {
  initializeMediaSigning,
  signedMediaRouter,
} from './server/lib/signed-media';
import { requireOwnedUpload } from './server/lib/media-ownership';
import {
  probeStorageReadiness,
  type StorageDirectoryReadiness,
} from './server/lib/storage-readiness';
import { backupMaintenanceGuard } from './server/lib/backup-maintenance';

// Initialize SQLite Database & Directories
initDatabase();
migrateStoredModelSecrets();
initializeAuth();
initializeMediaSigning();

const app = express();
const PORT = Number(process.env.PORT || 3004);
let shuttingDown = false;
if (process.env.TRUST_PROXY) {
  const configuredTrust = process.env.TRUST_PROXY.trim();
  app.set('trust proxy', /^\d+$/.test(configuredTrust) ? Number(configuredTrust) : configuredTrust);
}

app.disable('x-powered-by');
app.use((_req, res, next) => {
  const isProduction = process.env.NODE_ENV === 'production';
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    isProduction
      ? "default-src 'self'; img-src 'self' data: https:; media-src 'self' blob: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' https:;"
      : "default-src 'self'; img-src 'self' data: https:; media-src 'self' blob: https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' https: ws: wss:;"
  );
  next();
});
app.use(backupMaintenanceGuard());
app.use(express.json({ limit: '10mb' }));
app.use(sameOriginOnly);
app.use(observeRequests);
app.use(auditMutations);

app.use(['/api/auth', '/api/v1/auth'], authRouter);
app.use(['/api/metrics', '/api/v1/metrics'], metricsRouter);
app.use('/provider-media', signedMediaRouter);

// Uploaded media is private and requires an authenticated session.
app.use(
  '/uploads',
  requireAuth,
  requireOwnedUpload,
  express.static(path.resolve(process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads')))
);

import dotenv from 'dotenv';

type ReadinessReport = {
  ready: boolean;
  database: { ready: boolean; error?: string };
  storage: {
    ready: boolean;
    freeBytes: number | null;
    minimumFreeBytes: number;
    data: StorageDirectoryReadiness;
    uploads: StorageDirectoryReadiness;
    error?: string;
  };
  yunwu: { configured: boolean; baseUrl: string };
  seedance: {
    configured: boolean;
    ready: boolean;
    baseUrl: string;
    envFlags: {
      hasBaseUrl: boolean;
      hasAccount: boolean;
      hasPassword: boolean;
    };
    tokenOk: boolean | null;
    error?: string;
  };
  ffmpeg: { installed: boolean };
  minio: {
    configured: boolean;
    ready: boolean;
    endpoint: string;
    bucketName: string;
    publicUrl: string;
    error?: string;
  };
  publicBaseUrl: string | null;
  hasPublicStorage: boolean;
  allowMockFallback: boolean;
  notes: string[];
};

/** 私有/本机主机名 — Seedance 与就绪门禁都拒绝这些地址 */
function isPrivateHostname(host: string): boolean {
  const h = host.toLowerCase();
  if (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '0.0.0.0' ||
    h === '::1' ||
    h === 'host.docker.internal' ||
    h.endsWith('.local') ||
    h.endsWith('.localhost')
  ) {
    return true;
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const parts = h.split('.').map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 127) return true;
  }
  return false;
}

function isPublicIpHostname(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function isProductionPublicUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (isPrivateHostname(host)) return false;
    // 域名必须 HTTPS；公网 IP 允许 HTTP（IP-only 演示模式，见 DEMO_RUNBOOK）
    return parsed.protocol === 'https:' || isPublicIpHostname(host);
  } catch {
    return false;
  }
}

/**
 * 启动时校验 PUBLIC_BASE_URL（生产环境 fail-fast）。
 * Seedance 图生视频要求首帧公网可达（seedance.ts resolvePublicMediaUrl）；
 * 若生产环境缺失或指向内网，服务照常启动只会让每个 Step2 静默失败——
 * 因此在监听端口前直接拒绝启动，并给出可读错误。
 */
function validatePublicBaseUrl(): void {
  const publicBase = (process.env.PUBLIC_BASE_URL || process.env.APP_PUBLIC_URL || '').trim();
  if (process.env.NODE_ENV !== 'production') {
    if (!publicBase) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'missing_public_base_url',
          message:
            '未配置 PUBLIC_BASE_URL：Step2 图生视频将无法使用（Seedance 需要公网可达的首帧 URL）。开发调试请用 https 外链图做首帧。',
        })
      );
    }
    return;
  }
  if (!publicBase) {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'invalid_public_base_url',
        message:
          '生产环境必须配置 PUBLIC_BASE_URL（或 APP_PUBLIC_URL）：Seedance 图生视频需要公网可达的首帧 URL。' +
          '示例：PUBLIC_BASE_URL=https://your-domain.com',
      })
    );
    process.exit(1);
  }
  if (!isProductionPublicUrl(publicBase)) {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'invalid_public_base_url',
        message:
          `PUBLIC_BASE_URL 必须是 HTTPS 域名或公网 IP 地址（当前值：${publicBase}）。` +
          '内网/本机地址（localhost、127.x、10.x、192.168.x 等）无法被 Seedance 中转下载首帧，服务拒绝启动。',
      })
    );
    process.exit(1);
  }
}

async function getReadiness(probeExternal: boolean): Promise<ReadinessReport> {
  dotenv.config({ path: path.join(process.cwd(), '.env') });
  dotenv.config({ path: path.join(process.cwd(), 'app', '.env') });

  const { hasSeedanceConfig, getSeedanceToken } = await import('./server/routes/seedance');
  const { isFFmpegInstalled } = await import('./server/routes/render');
  const { isMinioConfigured, probeMinio } = await import('./server/lib/minio');

  let databaseReady = false;
  let databaseError: string | undefined;
  try {
    const row = db.prepare('SELECT 1 AS ok').get() as { ok: number };
    databaseReady = row.ok === 1;
  } catch (error: any) {
    databaseError = String(error?.message || error);
  }

  const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
  const uploadsDir = path.resolve(
    process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads')
  );
  const minimumFreeBytes = Number(process.env.MIN_FREE_STORAGE_BYTES || 1024 * 1024 * 1024);
  const storage = probeStorageReadiness(dataDir, uploadsDir, minimumFreeBytes);

  const yunwuKey = process.env.YUNWU_API_KEY || process.env.GEMINI_API_KEY || '';
  const yunwuReady = Boolean(yunwuKey && yunwuKey !== 'MY_GEMINI_API_KEY' && !yunwuKey.startsWith('your_'));
  const seedanceConfigured = hasSeedanceConfig();
  // Default probe Seedance lightly so topbar matches reality (cache token if ok)
  let seedanceTokenOk: boolean | null = null;
  let seedanceError: string | undefined;
  if (seedanceConfigured && probeExternal) {
    try {
      await getSeedanceToken(false);
      seedanceTokenOk = true;
    } catch (err: any) {
      seedanceTokenOk = false;
      seedanceError = err.message;
    }
  }
  const ffmpegOk = await isFFmpegInstalled();
  const minioReady = isMinioConfigured();
  const minioPublicReadEnabled = process.env.MINIO_ENSURE_PUBLIC_READ === 'true';
  const minioProbe = probeExternal
    ? await probeMinio()
    : {
        configured: minioReady,
        ready: minioReady,
        bucketName: process.env.MINIO_BUCKET || 'buv-materials',
        publicUrl: process.env.MINIO_PUBLIC_URL || '',
      };
  const minioPublicUrlProductionReady = (() => {
    if (
      !minioProbe.configured ||
      !minioPublicReadEnabled ||
      process.env.NODE_ENV !== 'production'
    ) return true;
    return isProductionPublicUrl(minioProbe.publicUrl);
  })();
  const publicBase = process.env.PUBLIC_BASE_URL || process.env.APP_PUBLIC_URL || '';
  const publicBaseProductionReady = (() => {
    if (!publicBase || process.env.NODE_ENV !== 'production') return Boolean(publicBase);
    return isProductionPublicUrl(publicBase);
  })();
  const hasPublicStorage = Boolean(
    publicBaseProductionReady ||
      (minioProbe.configured && minioProbe.ready && minioPublicUrlProductionReady)
  );
  const allowMockFallback =
    process.env.ALLOW_MOCK_FALLBACK === 'true' || process.env.ALLOW_MOCK_FALLBACK === '1';
  const seedanceReady = Boolean(seedanceConfigured && seedanceTokenOk);
  const notes = [
    shuttingDown ? '服务正在优雅停机' : null,
    !databaseReady ? `SQLite 不可用：${databaseError || 'probe failed'}` : null,
    !storage.ready ? `数据或上传目录不可用：${storage.error || 'probe failed'}` : null,
    minioProbe.configured && !minioProbe.ready
      ? `MinIO 不可用：${minioProbe.error || 'probe failed'}`
      : null,
    minioProbe.configured && minioPublicReadEnabled && !minioPublicUrlProductionReady
      ? '生产环境 MINIO_PUBLIC_URL 必须是 HTTPS 域名或公网 IP 地址'
      : null,
    publicBase && !publicBaseProductionReady
      ? '生产环境 PUBLIC_BASE_URL 必须是 HTTPS 域名或公网 IP 地址（本机/内网地址不可用）'
      : null,
    !yunwuReady ? '未检测到有效 YUNWU_API_KEY（文本/多模态/画图将失败）' : null,
    !seedanceConfigured ? '未配置 Seedance 中转（SEEDANCE_BASE_URL / ACCOUNT / PASSWORD）' : null,
    seedanceConfigured && seedanceTokenOk === false
      ? `Seedance 已配置但鉴权失败：${seedanceError || 'token error'}`
      : null,
    !ffmpegOk ? '未安装 FFmpeg，Step5 成片不可用' : null,
    !hasPublicStorage ? '未配置 MinIO 对象存储或 PUBLIC_BASE_URL：本地素材无法自动转公网外链' : null,
    allowMockFallback ? 'Mock fallback 已启用，禁止用于生产环境' : null,
  ].filter((note): note is string => Boolean(note));

  return {
    ready:
      !shuttingDown &&
      databaseReady &&
      storage.ready &&
      yunwuReady &&
      seedanceReady &&
      ffmpegOk &&
      hasPublicStorage &&
      (!minioProbe.configured || minioProbe.ready) &&
      minioPublicUrlProductionReady &&
      !allowMockFallback,
    database: { ready: databaseReady, error: databaseError },
    storage,
    yunwu: { configured: yunwuReady, baseUrl: process.env.YUNWU_BASE_URL || 'https://api3.wlai.vip/v1' },
    seedance: {
      configured: seedanceConfigured,
      ready: seedanceReady,
      baseUrl: (process.env.SEEDANCE_BASE_URL || '').replace(/\/$/, ''),
      envFlags: {
        hasBaseUrl: Boolean((process.env.SEEDANCE_BASE_URL || '').trim()),
        hasAccount: Boolean((process.env.SEEDANCE_ACCOUNT || '').trim()),
        hasPassword: Boolean((process.env.SEEDANCE_PASSWORD || '').trim()),
      },
      tokenOk: seedanceTokenOk,
      error: seedanceError,
    },
    ffmpeg: { installed: ffmpegOk },
    minio: {
      configured: minioProbe.configured,
      ready: minioProbe.ready,
      endpoint: process.env.MINIO_ENDPOINT || 'localhost',
      bucketName: minioProbe.bucketName,
      publicUrl: minioProbe.publicUrl,
      error: minioProbe.error,
    },
    publicBaseUrl: publicBase || null,
    hasPublicStorage,
    allowMockFallback,
    notes,
  };
}

const readinessCache = new Map<
  string,
  { expiresAt: number; value?: ReadinessReport; promise?: Promise<ReadinessReport> }
>();

async function getCachedReadiness(probeExternal: boolean): Promise<ReadinessReport> {
  const key = probeExternal ? 'external' : 'local';
  const now = Date.now();
  const cached = readinessCache.get(key);
  if (cached?.value && cached.expiresAt > now) return cached.value;
  if (cached?.promise) return cached.promise;
  const promise = getReadiness(probeExternal)
    .then((value) => {
      readinessCache.set(key, { value, expiresAt: Date.now() + 10_000 });
      return value;
    })
    .catch((error) => {
      readinessCache.delete(key);
      throw error;
    });
  readinessCache.set(key, { expiresAt: 0, promise });
  return promise;
}

app.get('/api/live', (_req, res) => {
  res.json({ status: 'alive', shuttingDown });
});

// Lightweight application status for the UI. Use /api/ready for deployment readiness.
app.get('/api/health', optionalAuth, async (req, res) => {
  const exposeDetails = process.env.NODE_ENV !== 'production' || Boolean(req.authUser);
  const readiness = await getCachedReadiness(
    exposeDetails && String(req.query.probe) === '1'
  );

  res.json({
    status: 'ok',
    db: readiness.database.ready ? 'connected' : 'unavailable',
    brand: 'BUV 爆款视频与卖点库全链路流水线 (v0.2 生产化架构)',
    readiness: exposeDetails ? readiness : { ready: readiness.ready },
  });
});

app.get('/api/ready', optionalAuth, async (req, res) => {
  const readiness = await getCachedReadiness(true);
  const exposeDetails = process.env.NODE_ENV !== 'production' || Boolean(req.authUser);
  res.status(readiness.ready ? 200 : 503).json({
    status: readiness.ready ? 'ready' : 'not_ready',
    db: readiness.database.ready ? 'connected' : 'unavailable',
    readiness: exposeDetails ? readiness : { ready: readiness.ready },
  });
});

// Mount Split Sub-routers (supports both /api and /api/v1 prefixes)
app.use(
  ['/api/seedance', '/api/v1/seedance'],
  requireAuthOrInternal,
  limitExpensiveOperations,
  seedanceRouter
);
app.use(
  ['/api/pipeline', '/api/v1/pipeline'],
  requireAuthOrInternal,
  limitExpensiveOperations,
  pipelineRouter
);
app.use(['/api/models', '/api/v1/models'], requireAuth, modelsRouter);
app.use(
  ['/api/materials', '/api/v1/materials'],
  requireAuth,
  limitExpensiveOperations,
  materialsRouter
);
app.use(
  ['/api/video', '/api/v1/video'],
  requireAuth,
  limitExpensiveOperations,
  videoRouter
);
app.use(['/api/tasks', '/api/v1/tasks'], requireAuth, tasksRouter);
app.use(
  ['/api/runs', '/api/v1/runs'],
  requireAuth,
  limitExpensiveOperations,
  runsRouter
);
app.use(
  ['/api/products', '/api/v1/products', '/api/knowledge', '/api/v1/knowledge'],
  requireAuth,
  productsRouter
);
app.use(
  ['/api/selling-points/optimize', '/api/v1/selling-points/optimize'],
  requireAuth,
  requirePermission('module.knowledge.write'),
  handleSellingPointsOptimize
);
app.use(
  ['/api/bgm', '/api/v1/bgm'],
  requireAuth,
  limitExpensiveOperations,
  bgmRouter
);
app.use(
  ['/api/render', '/api/v1/render'],
  requireAuth,
  limitExpensiveOperations,
  renderRouter
);
app.use(['/api/presets', '/api/v1/presets'], requireAuth, presetsRouter);
// S2 工作台：轻量状态端点（付费提交在 workflow-controller 内部经视频端口门控），
// 不挂 limitExpensiveOperations —— 该限流按路由族 20 次/分钟，密集的草稿/预检/确认
// 会被误伤成 429（E2E 实测复现：journey 存草稿被限流 → 刷新后无分镜草稿可恢复）。
app.use(['/api/workbench', '/api/v1/workbench'], requireAuth, workbenchRouter);

// Global Error Handling Middleware
app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(JSON.stringify({
    level: 'error',
    event: 'unhandled_error',
    requestId: req.requestId,
    method: req.method,
    path: req.path,
    message: String(err?.message || err),
  }));
  res.status(err.status || 500).json({
    success: false,
    error: process.env.NODE_ENV === 'production' ? '服务器内部错误' : (err.message || 'Unknown error'),
  });
});

// Vite Middleware for dev / Static serving for production
async function startServer() {
  validatePublicBaseUrl();

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        // 内网穿透访问开发服务器时，仅允许明确配置的 Host。
        allowedHosts: (process.env.VITE_ALLOWED_HOSTS || 'frp-ski.com')
          .split(',')
          .map((host) => host.trim())
          .filter(Boolean),
        middlewareMode: true,
        watch: {
          ignored: ['**/data/**', '**/uploads/**', '**/dist/**', '**/test-results/**', '**/.system_generated/**', '**/*.db*'],
        },
        hmr: {
          port: Number(process.env.VITE_HMR_PORT || 24679),
        },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // P3 真实 Demo 闭环：HTTPS 测试环境（HTTPS_CERT/HTTPS_KEY 指向 PEM 文件）。
  // 生产环境 TLS 由 Caddy 终止；此模式仅用于 HTTPS 测试环境（自签名证书由
  // scripts/run-p3-demo.mjs 用 openssl 生成）。
  let server: ReturnType<typeof app.listen> | import('node:https').Server;
  if (process.env.HTTPS_CERT && process.env.HTTPS_KEY) {
    const https = await import('node:https');
    const { readFileSync } = await import('node:fs');
    server = https.createServer(
      {
        cert: readFileSync(process.env.HTTPS_CERT),
        key: readFileSync(process.env.HTTPS_KEY),
      },
      app
    );
    server.listen(PORT, '0.0.0.0', () => {
      initializePipelineRuns(`https://127.0.0.1:${PORT}`);
      try {
        recoverStaleShotClaims();
      } catch (error) {
        console.warn('[server] recoverStaleShotClaims 失败:', error);
      }
      console.log(`BUV Pipeline Server (HTTPS) running on https://0.0.0.0:${PORT}`);
    });
  } else {
    server = app.listen(PORT, '0.0.0.0', () => {
      initializePipelineRuns(`http://127.0.0.1:${PORT}`);
      // P0 加固：启动时把上次进程遗留的「submitting 占位」标为失败（付费结果不确定，
      // 绝不假装成功；用户重试会走原子 claim 重新占位，不会重复扣费）。
      try {
        recoverStaleShotClaims();
      } catch (error) {
        console.warn('[server] recoverStaleShotClaims 失败:', error);
      }
      console.log(`BUV Pipeline Server running on http://0.0.0.0:${PORT}`);
    });
  }

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ level: 'info', event: 'shutdown_started', signal }));
    const forceTimer = setTimeout(() => {
      console.error(JSON.stringify({ level: 'error', event: 'shutdown_forced', signal }));
      try {
        db.close();
      } catch {}
      process.exit(1);
    }, Number(process.env.SHUTDOWN_GRACE_MS || 30_000));
    forceTimer.unref();

    server.close(() => {
      clearTimeout(forceTimer);
      try {
        db.close();
      } catch {}
      console.log(JSON.stringify({ level: 'info', event: 'shutdown_completed', signal }));
      process.exit(0);
    });
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

startServer();
