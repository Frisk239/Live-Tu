/**
 * Materials UX 契约测试（Roadmap P1-1 S4.1/S4.2/S4.4）：
 * 覆盖素材库/Step1 前端依赖的上传→可访问→删除→文件消失 全链路，
 * 以及未鉴权访问与删除的拒绝行为。
 *
 * 运行：npm run test:materials-ux
 */
import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import express from 'express';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'live-tu-materials-ux-'));
process.env.DATA_DIR = path.join(tempRoot, 'data');
process.env.UPLOADS_DIR = path.join(tempRoot, 'uploads');
process.env.NODE_ENV = 'test';
delete process.env.METRICS_TOKEN;
// 避免测试环境误触发 MinIO 同步（未配置时应跳过）
delete process.env.MINIO_ENDPOINT;

const databaseModule = await import('../lib/db.ts');
databaseModule.initDatabase();
const { db } = databaseModule;
const { authRouter, requireAuth, limitExpensiveOperations } = await import('../lib/auth.ts');
const { materialsRouter } = await import('../routes/materials.ts');
const { requireOwnedUpload } = await import('../lib/media-ownership.ts');

function passwordHash(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

const password = 'materials-ux-password';
db.prepare(
  `INSERT INTO users (id, username, password_hash, role)
   VALUES (?, ?, ?, ?)`
).run('ux-operator-id', 'haini', passwordHash(password), 'operator');

const app = express();
app.use(express.json());
app.use('/auth', authRouter);
app.use('/materials', requireAuth, limitExpensiveOperations, materialsRouter);
// 与 server.ts 相同的 /uploads 私有媒体链路：鉴权 → 所有权校验 → static
app.use(
  '/uploads',
  requireAuth,
  requireOwnedUpload,
  express.static(path.resolve(process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads')))
);

const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const address = server.address();
assert.ok(address && typeof address === 'object');
const baseUrl = `http://127.0.0.1:${address.port}`;

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

async function login(username: string) {
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = (await response.json()) as any;
  assert.equal(response.status, 200, JSON.stringify(body));
  const cookie = response.headers.getSetCookie()[0]?.split(';', 1)[0];
  assert.ok(cookie, 'login must set a session cookie');
  return { body, cookie };
}

/** 1x1 合法 PNG（通过魔数校验） */
const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

async function uploadPng(cookie: string, name = 'ux-test.png') {
  const form = new FormData();
  form.append('file', new Blob([tinyPng], { type: 'image/png' }), name);
  form.append('name', name);
  const response = await fetch(`${baseUrl}/materials/upload-file`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: form,
  });
  const body = (await response.json()) as any;
  assert.equal(response.status, 201, JSON.stringify(body));
  assert.ok(body.success, JSON.stringify(body));
  assert.ok(body.data?.id, 'upload must return material id');
  assert.ok(body.data?.url?.startsWith('/uploads/materials/'), 'upload must return url');
  return body.data as { id: string; url: string };
}

test('未登录上传/访问/删除均被拒绝', async () => {
  const form = new FormData();
  form.append('file', new Blob([tinyPng], { type: 'image/png' }), 'anon.png');
  const upload = await fetch(`${baseUrl}/materials/upload-file`, {
    method: 'POST',
    body: form,
  });
  assert.equal(upload.status, 401);

  const list = await fetch(`${baseUrl}/materials`);
  assert.equal(list.status, 401);

  const del = await fetch(`${baseUrl}/materials/mat_does_not_exist`, { method: 'DELETE' });
  assert.equal(del.status, 401);
});

test('上传后素材可访问；删除后文件、记录与所有权同步消失', async () => {
  const { cookie } = await login('haini');
  const { id, url } = await uploadPng(cookie);

  // 登录态可读取上传文件
  const read = await fetch(`${baseUrl}${url}`, { headers: { Cookie: cookie } });
  assert.equal(read.status, 200, 'owned media must be readable');

  // 列表包含新素材
  const listBefore = await fetch(`${baseUrl}/materials`, { headers: { Cookie: cookie } });
  const listBody = (await listBefore.json()) as any;
  assert.ok(
    (listBody.data || []).some((m: any) => m.id === id),
    'new material must appear in list'
  );

  // 删除素材
  const del = await fetch(`${baseUrl}/materials/${id}`, {
    method: 'DELETE',
    headers: { Cookie: cookie },
  });
  const delBody = (await del.json()) as any;
  assert.equal(del.status, 200, JSON.stringify(delBody));
  assert.equal(delBody.success, true);

  // 删除后文件不可读（所有权行/磁盘文件已清理 → 404）
  const readAfter = await fetch(`${baseUrl}${url}`, { headers: { Cookie: cookie } });
  assert.equal(readAfter.status, 404, 'deleted media file must be gone');

  // 删除后记录从列表消失
  const listAfter = await fetch(`${baseUrl}/materials`, { headers: { Cookie: cookie } });
  const listAfterBody = (await listAfter.json()) as any;
  assert.ok(
    !(listAfterBody.data || []).some((m: any) => m.id === id),
    'deleted material must vanish from list'
  );
});

test('删除他人素材被拒绝（所有权隔离）', async () => {
  const { cookie } = await login('haini');
  const { id } = await uploadPng(cookie, 'owned-by-haini.png');

  // 造一个无权限的第二个用户
  const otherPassword = 'other-ux-password';
  db.prepare(
    `INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)`
  ).run('ux-other-id', 'other-user', passwordHash(otherPassword), 'operator');
  const otherLogin = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'other-user', password: otherPassword }),
  });
  const otherBody = (await otherLogin.json()) as any;
  assert.equal(otherLogin.status, 200, JSON.stringify(otherBody));
  const otherCookie = otherLogin.headers.getSetCookie()[0]?.split(';', 1)[0];
  assert.ok(otherCookie);

  const del = await fetch(`${baseUrl}/materials/${id}`, {
    method: 'DELETE',
    headers: { Cookie: otherCookie },
  });
  assert.equal(del.status, 404, 'cross-user delete must be denied');

  // 素材仍然可读（未被误删）
  const list = await fetch(`${baseUrl}/materials`, { headers: { Cookie: cookie } });
  const listBody = (await list.json()) as any;
  assert.ok((listBody.data || []).some((m: any) => m.id === id), 'material must survive');
});

test('413 文案与实际 200MB 限制一致', async () => {
  // 无法在测试中真传 200MB，锁定错误文案常量，防止再次出现 100MB/200MB 漂移
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'routes', 'materials.ts'), 'utf8');
  assert.match(source, /文件超过 200MB 上传限制/, 'LIMIT_FILE_SIZE message must say 200MB');
  assert.ok(!/文件超过 100MB 上传限制/.test(source), '100MB stale message must be removed');
});
