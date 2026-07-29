// Load env first (side-effect). ESM import order among these still matters for sibling imports —
// seedance now reads process.env at call-time, not import-time.
import './load-env';

import express from 'express';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';

import { initDatabase } from './server/lib/db';
import { seedanceRouter } from './server/routes/seedance';
import { pipelineRouter } from './server/routes/pipeline';
import { modelsRouter } from './server/routes/models';
import { materialsRouter } from './server/routes/materials';
import { tasksRouter } from './server/routes/tasks';
import { productsRouter, handleSellingPointsOptimize } from './server/routes/products';
import { bgmRouter } from './server/routes/bgm';
import { renderRouter } from './server/routes/render';
import { presetsRouter } from './server/routes/presets';

// Initialize SQLite Database & Directories
initDatabase();

const app = express();
const PORT = Number(process.env.PORT || 3004);

app.use(express.json({ limit: '10mb' }));

// Serve Uploads Directory statically
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

import dotenv from 'dotenv';

// Health Check Endpoint
app.get('/api/health', async (req, res) => {
  dotenv.config({ path: path.join(process.cwd(), '.env') });
  dotenv.config({ path: path.join(process.cwd(), 'app', '.env') });

  const { hasSeedanceConfig, getSeedanceToken } = await import('./server/routes/seedance');
  const { isFFmpegInstalled } = await import('./server/routes/render');
  const { isMinioConfigured } = await import('./server/lib/minio');

  const yunwuKey = process.env.YUNWU_API_KEY || process.env.GEMINI_API_KEY || '';
  const yunwuReady = Boolean(yunwuKey && yunwuKey !== 'MY_GEMINI_API_KEY' && !yunwuKey.startsWith('your_'));
  const seedanceConfigured = hasSeedanceConfig();
  // Default probe Seedance lightly so topbar matches reality (cache token if ok)
  let seedanceTokenOk: boolean | null = null;
  let seedanceError: string | undefined;
  // probe=1: force token check (topbar / e2e). Default health stays lightweight.
  if (seedanceConfigured && String(req.query.probe) === '1') {
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
  const publicBase = process.env.PUBLIC_BASE_URL || process.env.APP_PUBLIC_URL || '';
  const hasPublicStorage = Boolean(publicBase || minioReady);

  res.json({
    status: 'ok',
    db: 'connected',
    brand: 'BUV 爆款视频与卖点库全链路流水线 (v0.2 生产化架构)',
    readiness: {
      yunwu: { configured: yunwuReady, baseUrl: process.env.YUNWU_BASE_URL || 'https://api3.wlai.vip/v1' },
      seedance: {
        configured: seedanceConfigured,
        ready: Boolean(seedanceConfigured && seedanceTokenOk),
        baseUrl: (process.env.SEEDANCE_BASE_URL || '').replace(/\/$/, ''),
        // Diagnostic flags only (no secrets)
        envFlags: {
          hasBaseUrl: Boolean((process.env.SEEDANCE_BASE_URL || '').trim()),
          hasAccount: Boolean((process.env.SEEDANCE_ACCOUNT || '').trim()),
          hasPassword: Boolean((process.env.SEEDANCE_PASSWORD || '').trim()),
          cwd: process.cwd(),
        },
        tokenOk: seedanceTokenOk,
        error: seedanceError,
      },
      ffmpeg: { installed: ffmpegOk },
      minio: { configured: minioReady, endpoint: process.env.MINIO_ENDPOINT || 'localhost' },
      publicBaseUrl: publicBase || null,
      hasPublicStorage,
      allowMockFallback: process.env.ALLOW_MOCK_FALLBACK === 'true' || process.env.ALLOW_MOCK_FALLBACK === '1',
      notes: [
        !yunwuReady ? '未检测到有效 YUNWU_API_KEY（文本/多模态/画图将失败）' : null,
        !seedanceConfigured ? '未配置 Seedance 中转（SEEDANCE_BASE_URL / ACCOUNT / PASSWORD）' : null,
        seedanceConfigured && seedanceTokenOk === false
          ? `Seedance 已配置但鉴权失败：${seedanceError || 'token error'}`
          : null,
        !ffmpegOk ? '未安装 FFmpeg，Step5 成片不可用' : null,
        !hasPublicStorage ? '未配置 MinIO 对象存储或 PUBLIC_BASE_URL：本地素材无法自动转公网外链' : null,
      ].filter(Boolean),
    },
  });
});

// Mount Split Sub-routers (supports both /api and /api/v1 prefixes)
app.use(['/api/seedance', '/api/v1/seedance'], seedanceRouter);
app.use(['/api/pipeline', '/api/v1/pipeline'], pipelineRouter);
app.use(['/api/models', '/api/v1/models'], modelsRouter);
app.use(['/api/materials', '/api/v1/materials'], materialsRouter);
app.use(['/api/tasks', '/api/v1/tasks'], tasksRouter);
app.use(['/api/products', '/api/v1/products'], productsRouter);
app.use(['/api/selling-points/optimize', '/api/v1/selling-points/optimize'], handleSellingPointsOptimize);
app.use(['/api/bgm', '/api/v1/bgm'], bgmRouter);
app.use(['/api/render', '/api/v1/render'], renderRouter);
app.use(['/api/presets', '/api/v1/presets'], presetsRouter);

// Global Error Handling Middleware
app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(`[server] Unhandled error on ${req.method} ${req.path}:`, err.message || err);
  res.status(err.status || 500).json({
    success: false,
    error: process.env.NODE_ENV === 'production' ? '服务器内部错误' : (err.message || 'Unknown error'),
  });
});

// Vite Middleware for dev / Static serving for production
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        watch: {
          ignored: ['**/data/**', '**/uploads/**', '**/dist/**', '**/test-results/**', '**/.system_generated/**', '**/*.db*'],
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

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`BUV Pipeline Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
