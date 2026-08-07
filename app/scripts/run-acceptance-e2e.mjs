#!/usr/bin/env node
/**
 * S2 验收门禁 E2E 一键运行器（自包含）：
 * - 独立端口（默认 3006）启动开发服务器，设置 FAKE_VIDEO_PROVIDER=true +
 *   PIPELINE_WORKER_DISABLED=true（CI/E2E 绝不触发真实付费/外部调用）+ 独立临时
 *   DATA_DIR/UPLOADS_DIR（不污染仓库 data/，各运行间隔离）；
 * - 运行全部验收 E2E spec：smoke / step5-readiness / accessibility / permissions /
 *   bootstrap-failure / materials-ux / workbench（workbench 为 S2 专项）；
 * - 可指定 --only=<逗号分隔文件名> 跑子集；
 * - 结束回收服务器；退出码 = playwright 退出码。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const port = process.env.ACCEPT_E2E_PORT || '3006';
const baseUrl = `http://127.0.0.1:${port}`;

const DEFAULT_SPECS = [
  'e2e/smoke.spec.ts',
  'e2e/step5-readiness.spec.ts',
  'e2e/accessibility.spec.ts',
  'e2e/permissions.spec.ts',
  'e2e/bootstrap-failure.spec.ts',
  'e2e/materials-ux.spec.ts',
  'e2e/workbench.spec.ts',
  // P3 quality-loop 不并入 acceptance：它需要独立的确定性 env
  // （FAKE_VIDEO_FAIL_NEXT=0 + FAKE_SEMANTIC_QA_* 注入，且 QA 状态会污染共享 DB 的
  // workbench 默认态）——由独立 runner（run-quality-loop-e2e.mjs）+ CI 专属门禁覆盖。
];

const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const specs = onlyArg
  ? onlyArg
      .split('=')[1]
      .split(',')
      .map((s) => `e2e/${s.trim().replace(/^e2e[/\\]/, '')}`)
  : DEFAULT_SPECS;

const tempRoot = mkdtempSync(path.join(tmpdir(), 'live-tu-accept-e2e-'));
const dataDir = path.join(tempRoot, 'data');
const uploadsDir = path.join(tempRoot, 'uploads');

const server = spawn('npx', ['tsx', '--import', './load-env.ts', 'server.ts'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: process.platform === 'win32',
  env: {
    ...process.env,
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
    console.error(`[accept-e2e] 服务器异常退出（code=${code}）:\n` + serverLog.slice(-3000));
  }
});

async function waitForServer(timeoutMs = 90_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
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
  console.error('[accept-e2e] 服务器启动失败:\n' + serverLog.slice(-2000));
  server.kill('SIGKILL');
  process.exit(1);
}

// 预热：Vite 冷编译会让首个测试超时（Windows 上实测 >60s），先让浏览器加载一次页面
try {
  const warm = await fetch(`${baseUrl}/`);
  console.log(`[accept-e2e] 首页预热 status=${warm.status}`);
} catch {}

const child = spawn('npx', ['playwright', 'test', ...specs], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, E2E_BASE_URL: baseUrl },
});

child.on('close', (code) => {
  server.kill('SIGKILL');
  if (code !== 0) {
    // 失败保留诊断（日志/DB），便于复现
    try {
      const { mkdirSync, copyFileSync } = require('node:fs');
      const diagDir = path.join(root, 'test-results', `accept-e2e-${Date.now()}`);
      mkdirSync(diagDir, { recursive: true });
      copyFileSync(path.join(tempRoot, 'server.log'), path.join(diagDir, 'server.log'));
      try {
        copyFileSync(path.join(dataDir, 'pipeline.db'), path.join(diagDir, 'pipeline.db'));
      } catch {}
      console.log(`[accept-e2e] 失败诊断存档: ${diagDir}`);
    } catch {}
  } else {
    try {
      rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {}
  }
  process.exit(code ?? 1);
});
