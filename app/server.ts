import express from 'express';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';

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

dotenv.config();

// Initialize SQLite Database & Directories
initDatabase();

const app = express();
const PORT = Number(process.env.PORT || 3004);

app.use(express.json({ limit: '10mb' }));

// Serve Uploads Directory statically
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

// Health Check Endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    db: 'connected',
    brand: 'BUV 爆款视频与卖点库全链路流水线 (v0.2 生产化架构)',
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
