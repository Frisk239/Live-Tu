#!/usr/bin/env node
/**
 * P3 质量闭环 E2E 门禁运行器（自包含）：
 * - 独立端口（默认 3007）启动开发服务器；
 * - FAKE_VIDEO_PROVIDER=true（零真实付费）+ FAKE_TECH_QA=true（技术 QA 恒定 verified）
 *   + FAKE_SEMANTIC_QA_FAIL_ONCE=hook_quality（第 1 镜首次检查不合格，可恢复）
 *   + FAKE_SEMANTIC_QA_FAIL=product_consistency + FAKE_SEMANTIC_QA_FAIL_SHOT_INDEXES=2
 *   （第 2 镜始终不合格 → 修复上限 → 人工通过）+ PIPELINE_WORKER_DISABLED=true；
 * - 运行 e2e/quality-loop.spec.ts；结束回收服务器；退出码 = playwright 退出码。
 */
import { spawn } from 'node:child_process';
import fs, { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const port = process.env.QL_E2E_PORT || '3007';
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = mkdtempSync(path.join(tmpdir(), 'live-tu-ql-e2e-'));
const dataDir = path.join(tempRoot, 'data');
const uploadsDir = path.join(tempRoot, 'uploads');

const spawnOpts = { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' };
// 隔离外部网络配置（与 run-workbench-e2e.mjs 同一纪律）
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
    // 质量闭环 E2E 需要全部镜头生成成功（失败注入走语义 QA 维度，不走生成失败）
    FAKE_VIDEO_FAIL_NEXT: '0',
    FAKE_TECH_QA: 'true',
    // S3 首帧保障与 E2E 兼容：候选首帧（/uploads 相对 URL）在无外网环境无法做公网
    // 可达性/LLM vision 预检 → 确定性预检通道（真实 demo 不设置，不受影响）
    FAKE_FIRST_FRAME_PREFLIGHT: 'true',
    // P5 后 E2E 无图像 provider / 无 LLM key：首帧派生与视觉安全必须走确定性 seam。
    // 两个 seam 均不放开生产策略——FAKE_FIRST_FRAME_DERIVE 替代的是「图像 provider
    // 调用」，provenance 登记与 hash 绑定安全评估仍走真实链路；
    // FAKE_VISUAL_SAFETY_PASS 只对携带真实 SHA-256 的本地资产给 pass，无 hash 仍拒绝。
    FAKE_FIRST_FRAME_DERIVE: 'true',
    FAKE_VISUAL_SAFETY_PASS: 'true',
    FAKE_SEMANTIC_QA_FAIL_ONCE: 'hook_quality',
    FAKE_SEMANTIC_QA_FAIL: 'product_consistency',
    FAKE_SEMANTIC_QA_FAIL_SHOT_INDEXES: '2',
    PIPELINE_WORKER_DISABLED: 'true',
    ALLOW_MOCK_FALLBACK: 'false',
  },
});
let serverLog = '';
server.stdout.on('data', (chunk) => (serverLog += chunk));
server.stderr.on('data', (chunk) => (serverLog += chunk));
server.on('exit', (code) => {
  if (code !== 0 && code !== null) {
    console.error(`[quality-loop-e2e] 服务器异常退出（code=${code}）:\n` + serverLog.slice(-3000));
  }
});
server.on('error', (err) => {
  console.error('[quality-loop-e2e] 服务器启动错误:', err?.message);
});

async function waitForServer(timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (server.exitCode !== null) {
      console.error(`[quality-loop-e2e] 服务器进程已退出（code=${server.exitCode}）:\n` + serverLog.slice(-2000));
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
  console.error('[quality-loop-e2e] 服务器启动失败:\n' + serverLog.slice(-2000));
  killServerTree();
  process.exit(1);
}

// 预热：触发 Vite 冷编译（Windows 冷编译可能超过 60s）
try {
  const { chromium } = await import('@playwright/test');
  const warm = await chromium.launch();
  const warmPage = await warm.newPage();
  await warmPage.goto(baseUrl, { timeout: 150_000 });
  await warmPage.getByPlaceholder('请输入账号').waitFor({ state: 'visible', timeout: 150_000 });
  await warm.close();
  console.log('[quality-loop-e2e] 应用预热完成（Vite 冷编译已触发）');
} catch (e) {
  console.warn('[quality-loop-e2e] 预热失败（继续尝试正式测试）:', String(e?.message || e).slice(0, 120));
}

const child = spawn(
  'npx',
  ['playwright', 'test', 'e2e/quality-loop.spec.ts'],
  {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, E2E_BASE_URL: baseUrl },
  }
);

// Windows 下 npx 是 shell 包装进程：server.kill() 只杀外层，tsx/node 子进程会残留
// （残留进程会继续占用端口/持有临时目录，污染后续运行）。必须按进程树清理。
function killServerTree() {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      server.kill('SIGKILL');
    }
  } catch {}
}

child.on('close', (code) => {
  killServerTree();
  setTimeout(() => {
    if (code !== 0) {
      try {
        const { copyFileSync, mkdirSync } = fs;
        mkdirSync(path.join(root, 'test-results'), { recursive: true });
        for (const name of ['pipeline.db', 'pipeline.db-wal', 'pipeline.db-shm']) {
          try {
            copyFileSync(path.join(dataDir, name), path.join(root, 'test-results', 'quality-loop-e2e-' + name.replace('pipeline.db', 'db')));
          } catch {}
        }
        // 直接写内存累积的日志（taskkill 强杀进程树后 exit 事件可能不触发，
        // 不能依赖事件回调写日志）
        try {
          writeFileSync(path.join(root, 'test-results', 'quality-loop-e2e-server.log'), serverLog.slice(-12000));
        } catch {}
        console.log('[quality-loop-e2e] 诊断存档: test-results/quality-loop-e2e-*');
      } catch (e) {
        console.warn('[quality-loop-e2e] 诊断存档失败:', e?.message);
      }
    }
    try {
      rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {}
    process.exit(code ?? 1);
  }, 1000);
});
