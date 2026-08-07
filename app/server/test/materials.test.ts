import { initDatabase, db } from '../lib/db';
import express from 'express';
import { materialsRouter } from '../routes/materials';
import path from 'node:path';
import fs from 'node:fs';
import { authStub } from './_helpers';

async function runMaterialsTest() {
  console.log('--- Starting Ticket 04 Materials CRUD Tests ---');
  initDatabase();

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  // 路由依赖 req.authUser（权限/归属过滤），测试以管理员身份挂载
  app.use(authStub);
  app.use('/api/materials', materialsRouter);

  const server = app.listen(3097);

  try {
    // Test 1: GET /api/materials
    const res1 = await fetch('http://localhost:3097/api/materials');
    const json1 = await res1.json();
    if (!(json1.success === true)) throw new Error('Test 1 Failed: GET materials success false');
    if (!(Array.isArray(json1.data))) throw new Error('Test 1 Failed: GET materials data not array');
    console.log(`✓ Test 1 Passed: GET /api/materials returned ${json1.data.length} materials`);

    // Test 2: POST /api/materials/upload with base64 DataURL
    const dummyImageBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const res2 = await fetch('http://localhost:3097/api/materials/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'test_material_upload.png',
        dataUrl: dummyImageBase64,
        mediaType: 'image',
        size: '1.5 KB',
      }),
    });
    const json2 = await res2.json();
    if (!(json2.success === true)) throw new Error('Test 2 Failed: POST materials/upload success false');
    const createdItem = json2.data;
    if (!(Boolean(createdItem?.id))) throw new Error('Test 2 Failed: Missing created material ID');
    if (!(createdItem.url.startsWith('/uploads/materials/'))) throw new Error('Test 2 Failed: Incorrect material URL');
    console.log(`✓ Test 2 Passed: POST /api/materials/upload saved file to disk and SQLite (ID: ${createdItem.id})`);

    // Verify file exists on disk（filePath 相对 uploads 根，解析到测试隔离目录）
    const diskPath = path.resolve(
      process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads'),
      createdItem.filePath.replace(/^uploads[\\/]/, '')
    );
    if (!(fs.existsSync(diskPath))) throw new Error('Test 2 Verification Failed: File not found on disk');
    console.log(`✓ Test 2 Verification Passed: Disk file verified at ${diskPath}`);

    // Test 3: DELETE /api/materials/:id
    const res3 = await fetch(`http://localhost:3097/api/materials/${createdItem.id}`, {
      method: 'DELETE',
    });
    const json3 = await res3.json();
    if (!(json3.success === true)) throw new Error('Test 3 Failed: DELETE material success false');
    console.log(`✓ Test 3 Passed: DELETE /api/materials/${createdItem.id} returned success`);

    // Verify file deleted from disk and SQLite
    if (!(!fs.existsSync(diskPath))) throw new Error('Test 3 Verification Failed: File still exists on disk after deletion');
    const stmt = db.prepare('SELECT * FROM materials WHERE id = ?');
    const row = stmt.get(createdItem.id);
    if (!(!row)) throw new Error('Test 3 Verification Failed: Record still in SQLite after deletion');
    console.log('✓ Test 3 Verification Passed: File removed from disk and record removed from SQLite');

    console.log('--- ALL TICKET 04 MATERIALS CRUD TESTS PASSED! ---');
  } finally {
    server.close();
  }
}

runMaterialsTest().catch((err) => {
  console.error('Materials Test Suite Failed:', err);
  process.exit(1);
});
