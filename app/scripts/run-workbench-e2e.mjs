#!/usr/bin/env node
/**
 * S2 工作台 E2E 门禁运行器（自包含）：
 * - 独立端口（默认 3005）启动开发服务器，设置 FAKE_VIDEO_PROVIDER=true +
 *   FAKE_VIDEO_FAIL_NEXT=1（确定性局部重试演示）+ PIPELINE_WORKER_DISABLED=true
 *   （等效保护：CI/E2E 绝不触发真实付费/外部调用）；
 * - 运行 e2e/workbench.spec.ts（E2E_BASE_URL 指向该服务器）；
 * - 结束回收服务器进程；退出码 = playwright 退出码。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const port = process.env.WB_E2E_PORT || '3005';
const baseUrl = `http://127.0.0.1:${port}`;

// 隔离：独立临时 DATA_DIR/UPLOADS_DIR（复用 repo 内 data/ 会跨运行污染 workbench_state）
import fs, { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
const tempRoot = mkdtempSync(path.join(tmpdir(), 'live-tu-wb-e2e-'));
const dataDir = path.join(tempRoot, 'data');
const uploadsDir = path.join(tempRoot, 'uploads');

const spawnOpts = { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' };
// 隔离外部网络配置（与 run-server-tests.mjs 同一纪律）：.env 里的 MINIO_*/SEEDANCE_* 等
// 会经 load-env（override）注入测试服务器——本机 9000 常被 Docker 占用、MinIO 未就绪时，
// 上传会走 uploadFileToMinio 而 500。E2E 门禁必须零外部依赖、完全确定性。
const sanitized = {};
for (const key of [
  'YUNWU_API_KEY', 'GEMINI_API_KEY', 'YUNWU_BASE_URL',
  'MINIO_ENDPOINT', 'MINIO_PORT', 'MINIO_USE_SSL', 'MINIO_ACCESS_KEY',
  'MINIO_SECRET_KEY', 'MINIO_BUCKET', 'MINIO_PUBLIC_URL', 'MINIO_DOCKER_ENDPOINT',
  'SEEDANCE_API_KEY', 'SEEDANCE_BASE_URL', 'SEEDANCE_TOKEN',
  'SEEDANCE_ACCOUNT', 'SEEDANCE_PASSWORD', 'SEEDANCE_PROVIDER', 'SEEDANCE_MODEL',
  'YUNSHU_BASE_URL', 'YUNSHU_API_KEY', 'YUNSHU_MODEL', 'SEEDANCE_FALLBACK_PROVIDER',
]) {
  sanitized[key] = '';
}
const server = spawn('npx', ['tsx', '--import', './load-env.ts', 'server.ts'], {
  ...spawnOpts,
  env: {
    ...process.env,
    ...sanitized,
    PORT: port,
    DATA_DIR: dataDir,
    UPLOADS_DIR: uploadsDir,
    FAKE_VIDEO_PROVIDER: 'true',
    FAKE_VIDEO_FAIL_NEXT: process.env.FAKE_VIDEO_FAIL_NEXT || '1',
    PIPELINE_WORKER_DISABLED: 'true',
    ALLOW_MOCK_FALLBACK: 'false',
  },
});
import { writeFileSync } from 'node:fs';
let serverLog = '';
server.stdout.on('data', (chunk) => (serverLog += chunk));
server.stderr.on('data', (chunk) => (serverLog += chunk));
server.on('exit', (code) => {
  try {
    writeFileSync(path.join(tempRoot, 'server.log'), serverLog.slice(-8000));
  } catch {}
  if (code !== 0 && code !== null) {
    console.error(`[workbench-e2e] 服务器异常退出（code=${code}）:
` + serverLog.slice(-3000));
  }
});
server.on('error', (err) => {
  console.error('[workbench-e2e] 服务器启动错误:', err?.message);
});

async function waitForServer(timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    // 服务器进程已退出（如端口被占用 EADDRINUSE）→ 立即失败，不再等 /api/live
    if (server.exitCode !== null) {
      console.error(`[workbench-e2e] 服务器进程已退出（code=${server.exitCode}）:
` + serverLog.slice(-2000));
      return false;
    }
    try {
      const res = await fetch(`${baseUrl}/api/live`);
      if (res.ok) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

const up = await waitForServer();
if (!up) {
  console.error('[workbench-e2e] 服务器启动失败:\n' + serverLog.slice(-2000));
  server.kill('SIGKILL');
  process.exit(1);
}

// 预热：首次浏览器请求会触发 Vite 冷编译（Windows 上可能超过 60s 测试超时）。
// 用无头浏览器先加载一次应用并等到登录表单出现，再跑正式测试。
try {
  const { chromium } = await import('@playwright/test');
  const warm = await chromium.launch();
  const warmPage = await warm.newPage();
  await warmPage.goto(baseUrl, { timeout: 150_000 });
  await warmPage.getByPlaceholder('请输入账号').waitFor({ state: 'visible', timeout: 150_000 });
  await warm.close();
  console.log('[workbench-e2e] 应用预热完成（Vite 冷编译已触发）');
} catch (e) {
  console.warn('[workbench-e2e] 预热失败（继续尝试正式测试）:', String(e?.message || e).slice(0, 120));
}

const child = spawn(
  'npx',
  ['playwright', 'test', 'e2e/workbench.spec.ts'],
  {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, E2E_BASE_URL: baseUrl },
  }
);

child.on('close', (code) => {
  server.kill('SIGKILL');
  // 失败时保留 DB（含 WAL）与服务器日志供诊断（成功后清理）
  setTimeout(() => {
    if (code !== 0) {
      try {
        const { copyFileSync, mkdirSync } = fs;
        mkdirSync(path.join(root, 'test-results'), { recursive: true });
        for (const name of ['pipeline.db', 'pipeline.db-wal', 'pipeline.db-shm']) {
          try {
            copyFileSync(path.join(dataDir, name), path.join(root, 'test-results', 'workbench-e2e-' + name.replace('pipeline.db', 'db')));
          } catch {}
        }
        try {
          copyFileSync(path.join(tempRoot, 'server.log'), path.join(root, 'test-results', 'workbench-e2e-server.log'));
        } catch {}
        console.log('[workbench-e2e] 诊断存档: test-results/workbench-e2e-*');
      } catch (e) {
        console.warn('[workbench-e2e] 诊断存档失败:', e?.message);
      }
    }
    try {
      rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {}
    process.exit(code ?? 1);
  }, 1000);
});
