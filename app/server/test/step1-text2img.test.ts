import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import { pipelineRouter } from '../routes/pipeline';

const app = express();
app.use(express.json());
app.use('/api/pipeline', pipelineRouter);

let server: Server;
let baseUrl = '';

describe('Ticket 11 — 文生图 API / 静态图生成测试', () => {
  before((_, done) => {
    server = app.listen(0, () => {
      const addr = server.address() as any;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      done();
    });
  });

  after((_, done) => {
    if (server) server.close(done);
  });

  it('POST /api/pipeline/generate-image 应成功接受 prompt 并返回图片 URL 属性', async () => {
    const res = await fetch(`${baseUrl}/api/pipeline/generate-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'A sleek product shot of BUV cleanser on a polished marble surface, soft green tone',
        productId: 'prod_buv_cleanser',
      }),
    });

    const json = (await res.json()) as any;
    assert.equal(res.status, 200);
    assert.equal(json.success, true);
    assert.notEqual(json.data, undefined);
    assert.equal(typeof json.data.imageUrl, 'string');
    assert.ok(json.data.imageUrl.length > 0);
    assert.ok(json.data.materialId);
  });

  it('POST /api/pipeline/generate-image 缺少 prompt 时应返回 400 错误', async () => {
    const res = await fetch(`${baseUrl}/api/pipeline/generate-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const json = (await res.json()) as any;
    assert.equal(res.status, 400);
    assert.equal(json.success, false);
  });
});
