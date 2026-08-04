import assert from 'node:assert/strict';
import test from 'node:test';
import { seedanceFetch } from '../routes/seedance';

/**
 * S1.2 重试/超时/指数退避单元测试。
 * mock global fetch：token 端点固定返回 accessToken，业务端点按测试配置的响应序列执行。
 */

type FetchBehavior = { status?: number; body?: string; error?: Error };

const originalFetch = globalThis.fetch;
const originalBaseUrl = process.env.SEEDANCE_BASE_URL;
const originalAccount = process.env.SEEDANCE_ACCOUNT;
const originalPassword = process.env.SEEDANCE_PASSWORD;

function installMockFetch(businessResponses: FetchBehavior[]) {
  const calls: Array<{ url: string; method: string }> = [];
  let businessIdx = 0;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    const method = String(init?.method || 'GET');
    calls.push({ url, method });
    if (url.includes('/api/v1/auth/token')) {
      return new Response(JSON.stringify({ data: { accessToken: 'mock-token', expiresIn: 7200 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const behavior = businessResponses[Math.min(businessIdx++, businessResponses.length - 1)];
    if (behavior.error) throw behavior.error;
    return new Response(behavior.body ?? '{}', {
      status: behavior.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return calls;
}

test.before(() => {
  process.env.SEEDANCE_BASE_URL = 'https://relay.test';
  process.env.SEEDANCE_ACCOUNT = 'test-account';
  process.env.SEEDANCE_PASSWORD = 'test-password';
});

test.after(() => {
  globalThis.fetch = originalFetch;
  if (originalBaseUrl === undefined) delete process.env.SEEDANCE_BASE_URL;
  else process.env.SEEDANCE_BASE_URL = originalBaseUrl;
  if (originalAccount === undefined) delete process.env.SEEDANCE_ACCOUNT;
  else process.env.SEEDANCE_ACCOUNT = originalAccount;
  if (originalPassword === undefined) delete process.env.SEEDANCE_PASSWORD;
  else process.env.SEEDANCE_PASSWORD = originalPassword;
});

test('GET 5xx 后自动重试并成功（幂等请求）', async () => {
  const calls = installMockFetch([{ status: 503, body: '{"error":"busy"}' }, { status: 200, body: '{"ok":1}' }]);
  const json = await seedanceFetch('/api/v1/videos/generations/t1');
  assert.deepEqual(json, { ok: 1 });
  const businessCalls = calls.filter((c) => !c.url.includes('/auth/token'));
  assert.equal(businessCalls.length, 2, '503 后应重试一次');
});

test('GET 429 尊重 Retry-After 后重试成功', async () => {
  const calls = installMockFetch([
    { status: 429, body: '{}' },
    { status: 200, body: '{"ok":1}' },
  ]);
  // mock fetch 无法真正等待 Retry-After；这里验证 429 被重试而非直接抛错
  const json = await seedanceFetch('/api/v1/videos/generations/t2');
  assert.deepEqual(json, { ok: 1 });
  const businessCalls = calls.filter((c) => !c.url.includes('/auth/token'));
  assert.equal(businessCalls.length, 2);
});

test('GET 持续 5xx 达到重试上限后抛出带 status 的错误', async () => {
  installMockFetch([{ status: 502, body: '{}' }, { status: 502, body: '{}' }, { status: 502, body: '{}' }]);
  await assert.rejects(
    () => seedanceFetch('/api/v1/videos/generations/t3'),
    (err: any) => err.status === 502
  );
});

test('POST 提交在超时（AbortError）后不重试并提示可能已提交', async () => {
  const calls = installMockFetch([{ error: Object.assign(new Error('aborted'), { name: 'AbortError' }) }]);
  await assert.rejects(
    () =>
      seedanceFetch('/api/v1/videos/generations', {
        method: 'POST',
        body: JSON.stringify({ prompt: 'x' }),
      }),
    /可能已提交/
  );
  const businessCalls = calls.filter((c) => !c.url.includes('/auth/token'));
  assert.equal(businessCalls.length, 1, '付费 POST 超时后不得自动重试');
});

test('POST 提交在 5xx（服务端明确未处理）后安全重试', async () => {
  const calls = installMockFetch([{ status: 500, body: '{}' }, { status: 200, body: '{"id":"task-1"}' }]);
  const json = await seedanceFetch('/api/v1/videos/generations', {
    method: 'POST',
    body: JSON.stringify({ prompt: 'x' }),
  });
  assert.deepEqual(json, { id: 'task-1' });
  const businessCalls = calls.filter((c) => !c.url.includes('/auth/token'));
  assert.equal(businessCalls.length, 2, '5xx 属服务端未处理，可安全重提');
});

test('GET 网络错误（TypeError）后重试成功', async () => {
  const calls = installMockFetch([{ error: new TypeError('fetch failed') }, { status: 200, body: '{"ok":1}' }]);
  const json = await seedanceFetch('/api/v1/videos/generations/t4');
  assert.deepEqual(json, { ok: 1 });
  const businessCalls = calls.filter((c) => !c.url.includes('/auth/token'));
  assert.equal(businessCalls.length, 2);
});

test('401 后刷新 token 重试成功', async () => {
  const calls = installMockFetch([{ status: 401, body: '{}' }, { status: 200, body: '{"ok":1}' }]);
  const json = await seedanceFetch('/api/v1/videos/generations/t5');
  assert.deepEqual(json, { ok: 1 });
  // token 缓存可能被前序测试复用，因此只断言业务请求被重试（401 一次 + 成功一次）
  const businessCalls = calls.filter((c) => !c.url.includes('/auth/token'));
  assert.equal(businessCalls.length, 2, '401 后应重试业务请求');
});

test('GET 超时（AbortError）重试成功（幂等可重试超时）', async () => {
  const calls = installMockFetch([
    { error: Object.assign(new Error('aborted'), { name: 'AbortError' }) },
    { status: 200, body: '{"ok":1}' },
  ]);
  const json = await seedanceFetch('/api/v1/videos/generations/t6');
  assert.deepEqual(json, { ok: 1 });
  const businessCalls = calls.filter((c) => !c.url.includes('/auth/token'));
  assert.equal(businessCalls.length, 2, 'GET 超时属幂等，应重试');
});

test('S1.4 preflightMediaUrl HEAD 预检：200 通过、非 200 失败带原因', async () => {
  const { preflightMediaUrl } = await import('../routes/seedance');
  const calls: string[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    calls.push(`${init?.method || 'GET'} ${url}`);
    if (url.includes('ok.example')) {
      return new Response(null, { status: 200 });
    }
    if (url.includes('missing.example')) {
      return new Response(null, { status: 404 });
    }
    return new Response(null, { status: 403 });
  }) as typeof fetch;

  const ok = await preflightMediaUrl('https://ok.example/uploads/a.png');
  assert.equal(ok.ok, true);

  const missing = await preflightMediaUrl('https://missing.example/uploads/a.png');
  assert.equal(missing.ok, false);
  assert.match(missing.error || '', /404/);

  const forbidden = await preflightMediaUrl('https://private.example/uploads/a.png');
  assert.equal(forbidden.ok, false);
  assert.match(forbidden.error || '', /403/);

  // 60s 内缓存：同一 URL 不再发第二次 HEAD
  await preflightMediaUrl('https://ok.example/uploads/a.png');
  const headCalls = calls.filter((c) => c.startsWith('HEAD') && c.includes('ok.example'));
  assert.equal(headCalls.length, 1, '预检结果应在缓存窗口内复用');
});
