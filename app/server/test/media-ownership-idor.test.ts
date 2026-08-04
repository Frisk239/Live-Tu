import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { requireOwnedUpload } from '../lib/media-ownership';

/**
 * S2.1 IDOR 回归：/uploads 编码路径不得绕过鉴权。
 * 旧缺陷：normalizedUploadPath 只查字面 `..`，`%2e%2e` 编码绕过；
 * 且 /uploads/bgm/ 对所有登录用户放行 → `/uploads/bgm/%2e%2e/renders/x.mp4`
 * 经 express.static 解码后越权读取任意文件。
 */
test('S2.1 编码路径无法绕过 /uploads 鉴权（IDOR）', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'live-tu-idor-'));
  const uploadsDir = path.join(root, 'uploads');
  process.env.DATA_DIR = path.join(root, 'data');
  process.env.UPLOADS_DIR = uploadsDir;
  process.env.NODE_ENV = 'test';

  // 受害者文件：admin 的成片 renders + 素材
  mkdirSync(path.join(uploadsDir, 'renders'), { recursive: true });
  mkdirSync(path.join(uploadsDir, 'materials'), { recursive: true });
  writeFileSync(path.join(uploadsDir, 'renders', 'victim.mp4'), 'victim-render');
  writeFileSync(path.join(uploadsDir, 'materials', 'owner-a.mp4'), 'owner-a-material');
  writeFileSync(path.join(uploadsDir, 'materials', 'my file.png'), 'space-file');
  mkdirSync(path.join(uploadsDir, 'bgm'), { recursive: true });
  writeFileSync(path.join(uploadsDir, 'bgm', 'shared.mp3'), 'bgm-track');

  // 套件共享进程/DB：用唯一后缀避免与其他测试的用户/素材撞名
  const suffix = Date.now().toString(36);
  const adminUser = `admin-${suffix}`;
  const ownerUser = `owner-${suffix}`;
  const matAId = `mat-a-${suffix}`;
  const matSpaceId = `mat-space-${suffix}`;

  const { initDatabase } = await import('../lib/db');
  const { db } = await import('../lib/db');
  initDatabase();
  db.prepare(
    `INSERT OR IGNORE INTO users (id, username, password_hash, role)
     VALUES (?, ?, ?, 'admin'), (?, ?, ?, 'operator')`
  ).run(adminUser, adminUser, 'unused', ownerUser, ownerUser, 'unused');
  // owner 的素材（url 未编码语义）与空格文件名（%20 编码请求兼容）
  db.prepare(
    `INSERT INTO materials (id, name, file_path, url, media_type, owner_id)
     VALUES (?, ?, ?, ?, 'video', ?), (?, ?, ?, ?, 'image', ?)`
  ).run(
    matAId, 'owner-a.mp4', 'uploads/materials/owner-a.mp4', '/uploads/materials/owner-a.mp4', ownerUser,
    matSpaceId, 'my file.png', 'uploads/materials/my file.png', '/uploads/materials/my file.png', ownerUser
  );

  const app = express();
  app.use((req, _res, next) => {
    const userId = String(req.headers['x-test-user'] || '');
    if (userId) {
      const role = userId === adminUser ? 'admin' : 'operator';
      const permissions = userId.startsWith('no-bgm')
        ? []
        : role === 'operator'
          ? ['module.bgm.read']
          : ['module.bgm.read', 'module.bgm.write'];
      req.authUser = { id: userId, username: userId, role, permissions };
    }
    next();
  });
  app.use(
    '/uploads',
    requireOwnedUpload,
    express.static(uploadsDir)
  );
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const ownerHeaders = { 'x-test-user': ownerUser };
    const adminHeaders = { 'x-test-user': adminUser };

    // 1) 编码 .. 绕过 BGM 放行前缀 → 必须 404
    const encodedTraversal = await fetch(
      `${baseUrl}/uploads/bgm/%2e%2e/renders/victim.mp4`,
      { headers: ownerHeaders }
    );
    assert.equal(encodedTraversal.status, 404, '编码路径穿越必须被拒绝');

    // 2) 大写编码同样拦截
    const upperTraversal = await fetch(
      `${baseUrl}/uploads/bgm/%2E%2E/renders/victim.mp4`,
      { headers: ownerHeaders }
    );
    assert.equal(upperTraversal.status, 404);

    // 3) 编码反斜杠穿越（Windows 语义）拦截
    const backslashTraversal = await fetch(
      `${baseUrl}/uploads/bgm/%5c%2e%2e%5crenders/victim.mp4`,
      { headers: ownerHeaders }
    );
    assert.equal(backslashTraversal.status, 404);

    // 4) 明文 .. 仍拦截（原有行为保持）
    const plainTraversal = await fetch(
      `${baseUrl}/uploads/bgm/../renders/victim.mp4`,
      { headers: ownerHeaders }
    );
    assert.equal(plainTraversal.status, 404);

    // 5) 正常素材：owner 可读自己的
    const ownMaterial = await fetch(`${baseUrl}/uploads/materials/owner-a.mp4`, {
      headers: ownerHeaders,
    });
    assert.equal(ownMaterial.status, 200);
    assert.equal(await ownMaterial.text(), 'owner-a-material');

    // 6) 空格文件名：%20 编码请求应命中未编码存储（兼容两种语义）
    const spaced = await fetch(`${baseUrl}/uploads/materials/my%20file.png`, {
      headers: ownerHeaders,
    });
    assert.equal(spaced.status, 200, '空格文件名 %20 编码请求应可读');
    assert.equal(await spaced.text(), 'space-file');

    // 7) 他人素材不可读（owner 隔离保持）
    const foreign = await fetch(`${baseUrl}/uploads/renders/victim.mp4`, {
      headers: ownerHeaders,
    });
    assert.equal(foreign.status, 404);

    // 8) BGM 共享曲库：具备 module.bgm.read 的 operator 可读
    const bgmRead = await fetch(`${baseUrl}/uploads/bgm/shared.mp3`, {
      headers: ownerHeaders,
    });
    assert.equal(bgmRead.status, 200, '具备 bgm.read 的 operator 应可试听 BGM');
    assert.equal(await bgmRead.text(), 'bgm-track');

    // 9) 无 bgm.read 权限的角色不可读 BGM 媒体（防御未来角色扩展）
    const noBgmRead = await fetch(`${baseUrl}/uploads/bgm/shared.mp3`, {
      headers: { 'x-test-user': 'no-bgm-role' },
    });
    assert.equal(noBgmRead.status, 404, '无 bgm.read 权限的角色不得读取 BGM 媒体');

    // 10) admin 全放行保持
    const adminRead = await fetch(`${baseUrl}/uploads/renders/victim.mp4`, {
      headers: adminHeaders,
    });
    assert.equal(adminRead.status, 200);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    try {
      db.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});
