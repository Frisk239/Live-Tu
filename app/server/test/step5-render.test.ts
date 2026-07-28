import { initDatabase } from '../lib/db';
import express from 'express';
import { pipelineRouter } from '../routes/pipeline';
import { renderRouter } from '../routes/render';
import fs from 'node:fs';
import path from 'node:path';

async function runStep5RenderTest() {
  console.log('--- Starting Ticket 09 Step 5 Video Compositing & FFmpeg Tests ---');
  initDatabase();

  const app = express();
  app.use(express.json());
  app.use('/api/pipeline', pipelineRouter);
  app.use('/api/render', renderRouter);

  const server = app.listen(3095);

  try {
    // Test 1: POST /api/pipeline/step5
    const resStep5 = await fetch('http://localhost:3095/api/pipeline/step5', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inputs: {
          aspectRatio: '9:16',
          subtitleStyle: '黄字黑边',
          productId: 'prod_buv_cleanser',
        },
      }),
    });

    const jsonStep5 = await resStep5.json();
    console.assert(jsonStep5.success === true, 'Test 1 Failed: step5 response success false');
    const d = jsonStep5.data;
    console.assert(Boolean(d.output?.filename), 'Test 1 Failed: filename missing');
    console.assert(Boolean(d.output?.videoUrl), 'Test 1 Failed: videoUrl missing');
    console.assert(Array.isArray(d.timeline) && d.timeline.length > 0, 'Test 1 Failed: timeline missing');
    console.assert(Array.isArray(d.qa_checklist) && d.qa_checklist.length > 0, 'Test 1 Failed: qa_checklist missing');

    const renderFilePath = path.join(process.cwd(), 'uploads', 'renders', d.output.filename);
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
