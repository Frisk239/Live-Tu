#!/usr/bin/env node
/**
 * S0 可信 CI：自动发现并运行全部 server 单元/集成测试
 * （server/test 目录下所有 .test.ts 文件）。
 *
 * 隔离策略：每个测试文件在独立子进程 + 独立临时 DATA_DIR/UPLOADS_DIR 中运行，
 * 绝不读写仓库内 data/ 目录，支持并行（默认并发 4，可通过 --concurrency=N 调整）。
 *
 * 双门禁：
 *  - fresh gate（默认）：每个文件从空目录初始化全新数据库，覆盖 fresh DB 路径；
 *  - legacy gate：--legacy 仅跑 migrations.test.ts（旧库升级路径，legacy DB → v20）。
 *
 * 退出码：0 全部通过；1 任一失败。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const testDir = path.join(root, 'server', 'test');

const legacyOnly = process.argv.includes('--legacy');
const concurrencyArg = process.argv.find((a) => a.startsWith('--concurrency='));
// 钳制并发：<1 或 NaN 一律回落 4（负数曾导致 pump 一个测试都不启动却以 0 退出）
const parsedConcurrency = concurrencyArg ? Number(concurrencyArg.split('=')[1]) : 4;
const concurrency = Number.isFinite(parsedConcurrency)
  ? Math.min(8, Math.max(1, Math.floor(parsedConcurrency)))
  : 4;

const allTests = readdirSync(testDir)
  .filter((f) => f.endsWith('.test.ts'))
  .sort();
const files = legacyOnly ? allTests.filter((f) => f === 'migrations.test.ts') : allTests;

if (files.length === 0) {
  console.error(`[test:server] no test files found in ${testDir}`);
  process.exit(1);
}

const results = new Map();
const activeChildren = new Set();
let active = 0;
let next = 0;
let failed = false;
/** 最近一次子进程完成时间；watchdog 据此识别「部分子进程挂死」 */
let lastCompletion = Date.now();
/** 空闲判定阈值：超过该时长没有任何测试文件完成，即认为剩余子进程挂死 */
const IDLE_TIMEOUT_MS = Number(process.env.TEST_SERVER_IDLE_TIMEOUT_MS || 180_000);

const started = Date.now();
console.log(
  `[test:server] ${legacyOnly ? 'legacy gate' : 'fresh gate'} · ${files.length} files · concurrency ${concurrency}`
);

function runOne(file) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'live-tu-test-data-'));
  const uploadsDir = mkdtempSync(path.join(tmpdir(), 'live-tu-test-uploads-'));
  // 隔离：dotenv 不会覆盖已存在的键，故把外部网络/密钥配置清空，
  // 防止开发机 .env（minio.ts 会在 import 时加载）泄漏进测试进程。
  // 依赖真实 Key 的测试会据此干净跳过（见 server/test/_helpers.ts）。
  const sanitized = {};
  for (const key of [
    'YUNWU_API_KEY',
    'GEMINI_API_KEY',
    'YUNWU_BASE_URL',
    'MINIO_ENDPOINT',
    'MINIO_ACCESS_KEY',
    'MINIO_SECRET_KEY',
    'MINIO_PUBLIC_URL',
    'SEEDANCE_API_KEY',
    'SEEDANCE_BASE_URL',
    'SEEDANCE_TOKEN',
  ]) {
    sanitized[key] = '';
  }
  const env = {
    ...process.env,
    ...sanitized,
    DATA_DIR: dataDir,
    UPLOADS_DIR: uploadsDir,
    NODE_ENV: 'test',
    PIPELINE_WORKER_DISABLED: 'false',
  };
  const child = spawn(
    process.execPath,
    ['--no-warnings', '--import', 'tsx', '--test', path.join(testDir, file)],
    { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  activeChildren.add(child);
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  child.on('close', (code) => {
    activeChildren.delete(child);
    lastCompletion = Date.now();
    try {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      rmSync(uploadsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {}
    const ok = code === 0;
    results.set(file, { ok, code, output });
    if (!ok) failed = true;
    active -= 1;
    pump();
    if (active === 0 && next >= files.length) finish();
  });
}

function pump() {
  while (active < concurrency && next < files.length) {
    const file = files[next];
    next += 1;
    active += 1;
    runOne(file);
  }
}

function finish() {
  const durationMs = Date.now() - started;
  // 防「零测试绿灯」：一个测试都没跑过（子进程都没启动/全部异常）必须判失败
  if (results.size === 0) failed = true;
  console.log('');
  for (const [file, r] of [...results.entries()].sort()) {
    console.log(`${r.ok ? '✔' : '✖'} ${file}${r.ok ? '' : ` (exit ${r.code})`}`);
    if (!r.ok) {
      // 只打印失败文件的最后 40 行，保留可读性
      const lines = r.output.split('\n').filter(Boolean);
      console.log(lines.slice(-40).map((l) => `    ${l}`).join('\n'));
      console.log('');
    }
  }
  console.log(
    `[test:server] ${failed ? 'FAILED' : 'ALL PASSED'} · ${results.size}/${files.length} files · ${durationMs}ms`
  );
  process.exit(failed ? 1 : 0);
}

pump();

// Watchdog：每秒检查。
//  - 一个测试都没跑过（子进程从未启动/全部异常）→ 判失败退出；
//  - 已有测试完成但剩余子进程挂死（超过 IDLE_TIMEOUT_MS 无任何完成）→
//    杀掉挂死子进程并判失败，避免无限等待（P2 回归：部分挂死必须能收尾）。
const watchdog = setInterval(() => {
  const idleMs = Date.now() - lastCompletion;
  if (next >= files.length && active === 0) {
    clearInterval(watchdog);
    finish();
    return;
  }
  if (active > 0 && idleMs > IDLE_TIMEOUT_MS) {
    failed = true;
    console.error(
      `[test:server] watchdog: ${active} 个子进程超过 ${IDLE_TIMEOUT_MS}ms 无进展，判定挂死并终止`
    );
    for (const child of activeChildren) {
      try {
        child.kill('SIGKILL');
      } catch {}
    }
    activeChildren.clear();
    clearInterval(watchdog);
    // 挂死文件计为失败（results 里缺失的文件在 finish 里显式列出）
    for (const file of files) {
      if (!results.has(file)) {
        results.set(file, { ok: false, code: null, output: 'watchdog: test process hung and was killed\n' });
      }
    }
    active = 0;
    finish();
  }
}, 1_000);
