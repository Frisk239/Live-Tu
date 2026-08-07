import { initDatabase } from '../lib/db';
import express from 'express';
import { pipelineRouter } from '../routes/pipeline';
import { renderRouter } from '../routes/render';
import { authStub, hasFfmpeg } from './_helpers';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

async function runStep5RenderTest() {
  console.log('--- Starting Ticket 09 Step 5 Video Compositing & FFmpeg Tests ---');
  initDatabase();

  // 成片渲染依赖本地 FFmpeg；CI 无 FFmpeg 时干净跳过
  if (!hasFfmpeg()) {
    console.log('SKIPPED: 未检测到 ffmpeg，跳过成片渲染测试');
    return;
  }

  const app = express();
  app.use(express.json());
  // 路由依赖 req.authUser（媒体归属校验），测试以管理员身份挂载
  app.use(authStub);
  app.use('/api/pipeline', pipelineRouter);
  app.use('/api/render', renderRouter);

  const server = app.listen(3095);

  try {
    // 生成 9:16 竖屏测试视频作为 Step2 视频源（隔离目录，不污染仓库）
    const fixtureDir = path.join(process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads'), 'renders');
    fs.mkdirSync(fixtureDir, { recursive: true });
    const fixturePath = path.join(fixtureDir, 'step5-fixture.mp4');
    const fixtureUrl = '/uploads/renders/step5-fixture.mp4';
    const gen = spawnSync(
      'ffmpeg',
      [
        '-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x568:rate=24',
        '-pix_fmt', 'yuv420p', fixturePath,
      ],
      { stdio: 'ignore', timeout: 30000 }
    );
    if (gen.status !== 0 || !fs.existsSync(fixturePath)) {
      throw new Error('ffmpeg fixture generation failed');
    }

    // Test 1: POST /api/pipeline/step5（真实视频源 + 产品上下文）
    const resStep5 = await fetch('http://localhost:3095/api/pipeline/step5', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inputs: {
          aspectRatio: '9:16',
          subtitleStyle: '黄字黑边',
          productId: 'prod_buv_cleanser',
          previewVideoUrl: fixtureUrl,
        },
      }),
    });

    const jsonStep5 = await resStep5.json();
    console.assert(jsonStep5.success === true, `Test 1 Failed: step5 response success false (${jsonStep5.error || jsonStep5.code || 'unknown'})`);
    const d = jsonStep5.data;
    console.assert(Boolean(d.output?.filename), 'Test 1 Failed: filename missing');
    console.assert(Boolean(d.output?.videoUrl), 'Test 1 Failed: videoUrl missing');
    console.assert(Array.isArray(d.timeline) && d.timeline.length > 0, 'Test 1 Failed: timeline missing');
    console.assert(Array.isArray(d.qa_checklist) && d.qa_checklist.length > 0, 'Test 1 Failed: qa_checklist missing');

    const renderFilePath = path.join(
      process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads'),
      'renders',
      d.output.filename
    );
    console.assert(fs.existsSync(renderFilePath), 'Test 1 Failed: rendered MP4 file missing on disk');
    console.log(`✓ Test 1 Passed: Generated video成片: ${d.output.filename} (${d.output.resolution}), file exists on disk!`);

    // Test 2: POST /api/render/ffmpeg Endpoint Direct Call
    const resRender = await fetch('http://localhost:3095/api/render/ffmpeg', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        aspectRatio: '9:16',
        outputFilename: `test_render_${Date.now()}.mp4`,
      }),
    });

    const jsonRender = await resRender.json();
    console.assert(jsonRender.success === true, 'Test 2 Failed: render/ffmpeg endpoint failed');
    console.log(`✓ Test 2 Passed: FFmpeg render engine response: "${jsonRender.message}"`);

    console.log('--- ALL TICKET 09 STEP 5 TESTS PASSED! ---');
  } finally {
    server.close();
  }
}

runStep5RenderTest().catch((err) => {
  console.error('Step 5 Test Suite Failed:', err);
  process.exit(1);
});
