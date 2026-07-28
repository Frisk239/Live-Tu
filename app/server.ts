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

// Health Check Endpoint
app.get('/api/health', async (req, res) => {
  const { hasSeedanceConfig, getSeedanceToken } = await import('./server/routes/seedance');
  const { isFFmpegInstalled } = await import('./server/routes/render');

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
  const publicBase = process.env.PUBLIC_BASE_URL || process.env.APP_PUBLIC_URL || '';

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
      publicBaseUrl: publicBase || null,
      allowMockFallback: process.env.ALLOW_MOCK_FALLBACK === 'true' || process.env.ALLOW_MOCK_FALLBACK === '1',
      notes: [
        !yunwuReady ? '未检测到有效 YUNWU_API_KEY（文本/多模态/画图将失败）' : null,
        !seedanceConfigured ? '未配置 Seedance 中转（SEEDANCE_BASE_URL / ACCOUNT / PASSWORD）' : null,
        seedanceConfigured && seedanceTokenOk === false
          ? `Seedance 已配置但鉴权失败：${seedanceError || 'token error'}`
          : null,
        !ffmpegOk ? '未安装 FFmpeg，Step5 成片不可用' : null,
        !publicBase ? '未配置 PUBLIC_BASE_URL：本地 /uploads 素材无法作为 Seedance 公网 materials' : null,
      ].filter(Boolean),
    },
  });
});

// Mount Split Sub-routers
app.use('/api/seedance', seedanceRouter);
app.use('/api/pipeline', pipelineRouter);
app.use('/api/models', modelsRouter);
app.use('/api/materials', materialsRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/products', productsRouter);
app.use('/api/selling-points/optimize', handleSellingPointsOptimize);
app.use('/api/bgm', bgmRouter);
app.use('/api/render', renderRouter);
app.use('/api/presets', presetsRouter);

// Vite Middleware for dev / Static serving for production
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
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
