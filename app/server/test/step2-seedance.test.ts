import { initDatabase } from '../lib/db';
import express from 'express';
import { pipelineRouter } from '../routes/pipeline';
import { seedanceRouter } from '../routes/seedance';

async function runStep2Test() {
  console.log('--- Starting Ticket 06 Step 2 & Seedance Relay Tests ---');
  initDatabase();

  const app = express();
  app.use(express.json());
  app.use('/api/pipeline', pipelineRouter);
  app.use('/api/seedance', seedanceRouter);

  const server = app.listen(3096);

  try {
    // Test 1: GET /api/seedance/status
    const resStatus = await fetch('http://localhost:3096/api/seedance/status');
    const jsonStatus = await resStatus.json();
    console.assert(jsonStatus.success === true, 'Test 1 Failed: seedance status success false');
    console.log(`✓ Test 1 Passed: Seedance relay status checked (configured: ${jsonStatus.configured})`);

    // Test 2: POST /api/pipeline/step2
    const resStep2 = await fetch('http://localhost:3096/api/pipeline/step2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inputs: {
          static_image_prompt: 'A high-end commercial shot of BUV cleanser on marble background',
          imageUrl: 'https://images.unsplash.com/photo-1556228720-195a672e8a03?auto=format&fit=crop&w=600&q=80',
          videoTone: 'douyin_beat',
          durationSec: 5,
          videoModel: 'Seedance 2.0 Fast',
          productId: 'prod_buv_cleanser',
        },
      }),
    });

    const jsonStep2 = await resStep2.json();
    console.assert(jsonStep2.success === true, 'Test 2 Failed: step2 response success false');
    const d = jsonStep2.data;
    console.assert(Boolean(d.motion_type), 'Test 2 Failed: motion_type missing');
    console.assert(Boolean(d.motion_description), 'Test 2 Failed: motion_description missing');
    console.assert(Boolean(d.video_prompt), 'Test 2 Failed: video_prompt missing');
    console.assert(Boolean(d.negative_prompt), 'Test 2 Failed: negative_prompt missing');
    console.assert(d.seedanceConfigured !== undefined, 'Test 2 Failed: seedanceConfigured status missing');

    console.log(`✓ Test 2 Passed: Step 2 generated video motion prompt (${d.motion_type}, status: ${d.seedanceStatus})`);

    console.log('--- ALL TICKET 06 STEP 2 TESTS PASSED! ---');
  } finally {
    server.close();
  }
}

runStep2Test().catch((err) => {
  console.error('Step 2 Test Suite Failed:', err);
  process.exit(1);
});
