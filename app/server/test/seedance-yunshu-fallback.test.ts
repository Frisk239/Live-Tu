/**
 * yunshu.hk 备用视频 provider 契约测试（S7.1 第一刀）：
 *  - 主 provider（relay）可切换故障（5xx）→ 自动提交 yunshu，任务 id 带 yunshu: 前缀
 *  - 输入类 4xx / 未配置 fallback → 不切换
 *  - yunshu 提交 body（model/prompt/image/Bearer key）与轮询端点正确
 *  - 路由 GET /generations/:id 按前缀分派轮询端点
 *
 * 运行：npm run test:yunshu-fallback
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import express from 'express';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'live-tu-yunshu-fallback-'));
process.env.DATA_DIR = path.join(tempRoot, 'data');
process.env.UPLOADS_DIR = path.join(tempRoot, 'uploads');
process.env.NODE_ENV = 'test';
process.env.SEEDANCE_PROVIDER = 'relay';
process.env.SEEDANCE_BASE_URL = 'https://relay.test';
process.env.SEEDANCE_ACCOUNT = 'test-account';
process.env.SEEDANCE_PASSWORD = 'test-password';
process.env.SEEDANCE_FALLBACK_PROVIDER = 'yunshu';
process.env.YUNSHU_BASE_URL = 'https://yunshu.test';
process.env.YUNSHU_API_KEY = 'sk-yunshu-test';
process.env.YUNSHU_MODEL = 'doubao-seedance-1-0-pro-fast-251015';
process.env.YUNWU_API_KEY = 'sk-yunwu-test';

const databaseModule = await import('../lib/db.ts');
databaseModule.initDatabase();
const { db } = databaseModule;
const {
  submitSeedanceVideoWithFallback,
  normalizeYunshuTask,
  seedanceRouter,
} = await import('../routes/seedance.ts');
const { registerSeedanceTaskOwner } = await import('../lib/seedance-ownership.ts');

db.prepare(
  `INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)`
).run('ux-owner', 'ux-owner', 'unused', 'operator');

/** mock fetch：按 URL 分派；记录每个调用（URL + 请求体 + Authorization） */
type FetchCall = { url: string; method: string; body?: any; auth?: string };
const calls: FetchCall[] = [];
let relaySubmitStatus = 500; // 可切换的 5xx 故障
let relaySubmitBody: any = null;
let yunshuSubmitStatus = 200;
const originalFetch = globalThis.fetch;

function installFetchMock() {
  calls.length = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    // 本地测试服务器请求走真实 fetch，不 mock
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
      return originalFetch(input, init);
    }
    const method = (init?.method || 'GET').toUpperCase();
    const call: FetchCall = { url, method, auth: (init?.headers as any)?.['Authorization'] };
    if (init?.body && typeof init.body === 'string') {
      try {
        call.body = JSON.parse(init.body);
      } catch {
        call.body = init.body;
      }
    }
    calls.push(call);
    if (url.includes('/auth/token')) {
      return new Response(
        JSON.stringify({ data: { accessToken: 'relay-token', expiresIn: 7200 } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (url.includes('yunshu.test') && url.endsWith('/v1/video/generations') && method === 'POST') {
      return new Response(
        yunshuSubmitStatus === 200
          ? JSON.stringify({ code: 0, message: 'ok', data: { task_id: 'ys-task-1', task_status: 'processing' } })
          : JSON.stringify({ code: 500, message: 'yunshu down', data: {} }),
        { status: yunshuSubmitStatus, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (url.includes('yunshu.test') && url.includes('/v1/video/generations/')) {
      return new Response(
        JSON.stringify({
          code: 0,
          message: 'ok',
          data: { task_id: url.split('/').at(-1), task_status: 'succeeded', video_url: 'https://yunshu.test/video/out.mp4' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (url.includes('relay.test') && url.endsWith('/api/v1/videos/generations') && method === 'POST') {
      relaySubmitBody = call.body;
      return new Response(
        relaySubmitStatus >= 500
          ? JSON.stringify({ error: 'relay exploded' })
          : JSON.stringify({ data: { id: 'relay-task-1', status: 'processing' } }),
        { status: relaySubmitStatus, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (url.includes('relay.test') && url.includes('/api/v1/videos/generations/')) {
      return new Response(
        JSON.stringify({ data: { id: url.split('/').at(-1), status: 'processing' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
}

const input = {
  prompt: 'product close-up, cinematic motion',
  model: 'doubao-seedance-2-0-fast',
  duration: 5,
  resolution: '720p',
  aspectRatio: '9:16',
  imageUrl: 'https://public.example.com/first-frame.png',
};

test('relay 5xx 时自动切 yunshu 备用通道，任务 id 带 yunshu: 前缀', async () => {
  installFetchMock();
  relaySubmitStatus = 500;
  const { task, provider, fallbackUsed } = await submitSeedanceVideoWithFallback(input);
  assert.equal(fallbackUsed, true);
  assert.equal(provider, 'yunshu');
  assert.equal(task.id, 'yunshu:ys-task-1');
  assert.equal(task.status, 'processing');
  // relay 提交（5xx 重试 3 次）+ yunshu 提交各发生
  const relayPosts = calls.filter(
    (c) => c.url === 'https://relay.test/api/v1/videos/generations' && c.method === 'POST'
  );
  assert.equal(relayPosts.length, 3, 'relay 5xx 应重试到耗尽');
  assert.ok(calls.some((c) => c.url === 'https://yunshu.test/v1/video/generations'), '应提交 yunshu');
});

test('yunshu 提交体正确：model/prompt/image=首帧公网 URL + Bearer key', async () => {
  installFetchMock();
  relaySubmitStatus = 500;
  await submitSeedanceVideoWithFallback(input);
  const yunshuPost = calls.find((c) => c.url === 'https://yunshu.test/v1/video/generations');
  assert.ok(yunshuPost, 'yunshu POST 必须发生');
  assert.equal(yunshuPost.method, 'POST');
  assert.equal(yunshuPost.body?.model, 'doubao-seedance-1-0-pro-fast-251015');
  assert.equal(yunshuPost.body?.prompt, input.prompt);
  assert.equal(yunshuPost.body?.image, 'https://public.example.com/first-frame.png');
  assert.equal(yunshuPost.auth, 'Bearer sk-yunshu-test');
});

test('relay 输入类 4xx（400）不触发 fallback', async () => {
  installFetchMock();
  relaySubmitStatus = 400;
  await assert.rejects(
    () => submitSeedanceVideoWithFallback(input),
    /failed 400/
  );
  assert.ok(
    !calls.some((c) => c.url === 'https://yunshu.test/v1/video/generations'),
    '4xx 不应切 yunshu'
  );
});

test('未启用 fallback（SEEDANCE_FALLBACK_PROVIDER=none）时不切换', async () => {
  installFetchMock();
  relaySubmitStatus = 500;
  process.env.SEEDANCE_FALLBACK_PROVIDER = 'none';
  try {
    await assert.rejects(() => submitSeedanceVideoWithFallback(input), /failed 500/);
    assert.ok(
      !calls.some((c) => c.url === 'https://yunshu.test/v1/video/generations'),
      '未启用时不应切 yunshu'
    );
  } finally {
    process.env.SEEDANCE_FALLBACK_PROVIDER = 'yunshu';
  }
});

test('YUNSHU_API_KEY 留空时复用 YUNWU_API_KEY', async () => {
  installFetchMock();
  relaySubmitStatus = 500;
  process.env.YUNSHU_API_KEY = '';
  try {
    await submitSeedanceVideoWithFallback(input);
    const yunshuPost = calls.find((c) => c.url === 'https://yunshu.test/v1/video/generations');
    assert.equal(yunshuPost?.auth, 'Bearer sk-yunwu-test');
  } finally {
    process.env.YUNSHU_API_KEY = 'sk-yunshu-test';
  }
});

test('normalizeYunshuTask 状态与 URL 映射', () => {
  assert.deepEqual(
    {
      status: normalizeYunshuTask({ data: { task_id: 'a', task_status: 'succeeded', video_url: 'https://x/a.mp4' } }).status,
      url: normalizeYunshuTask({ data: { task_id: 'a', task_status: 'succeeded', video_url: 'https://x/a.mp4' } }).url,
    },
    { status: 'success', url: 'https://x/a.mp4' }
  );
  assert.equal(
    normalizeYunshuTask({ data: { task_id: 'b', task_status: 'failed', message: 'boom' } }).status,
    'failed'
  );
  assert.equal(
    normalizeYunshuTask({ data: { task_id: 'c', task_status: 'processing' } }).status,
    'processing'
  );
  assert.equal(normalizeYunshuTask({ data: { task_id: 'c', task_status: 'processing' } }).error, null);
  // 有 video_url 即视为成功（与 pollExternal 的 url 判定兼容）
  assert.equal(
    normalizeYunshuTask({ data: { task_id: 'd', task_status: 'pending', video_url: 'https://x/d.mp4' } }).status,
    'success'
  );
});

// ---------- 路由级：GET /generations/:id 按前缀分派轮询端点 ----------
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.authUser = { id: 'ux-owner', username: 'ux-owner', role: 'operator', permissions: [] };
  next();
});
app.use('/seedance', seedanceRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const address = server.address();
assert.ok(address && typeof address === 'object');
const baseUrl = `http://127.0.0.1:${address.port}/seedance`;

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  globalThis.fetch = originalFetch;
  db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('路由：yunshu: 前缀任务走 New API 轮询端点并缓存成片', async () => {
  installFetchMock();
  registerSeedanceTaskOwner('yunshu:ys-task-1', 'ux-owner', 'test');
  const res = await fetch(`${baseUrl}/generations/yunshu:ys-task-1`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.success, true);
  assert.equal(body.source, 'yunshu');
  assert.ok(
    calls.some((c) => c.url === 'https://yunshu.test/v1/video/generations/ys-task-1'),
    '应轮询 yunshu 端点'
  );
  assert.equal(body.data.url, 'https://yunshu.test/video/out.mp4');
});

test('路由：无前缀任务走 relay 轮询端点', async () => {
  installFetchMock();
  registerSeedanceTaskOwner('relay-task-1', 'ux-owner', 'test');
  const res = await fetch(`${baseUrl}/generations/relay-task-1`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.source, 'seedance-relay');
  assert.ok(
    calls.some((c) => c.url === 'https://relay.test/api/v1/videos/generations/relay-task-1'),
    '应轮询 relay 端点'
  );
});
