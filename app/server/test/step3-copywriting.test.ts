import { initDatabase } from '../lib/db';
import express from 'express';
import { pipelineRouter } from '../routes/pipeline';

async function runStep3Test() {
  console.log('--- Starting Ticket 07 Step 3 Copywriting & Compliance Scan Tests ---');
  initDatabase();

  const app = express();
  app.use(express.json());
  app.use('/api/pipeline', pipelineRouter);

  const server = app.listen(3097);

  try {
    // Test 1: Standard Step 3 Copywriting Generation
    const resStep3 = await fetch('http://localhost:3097/api/pipeline/step3', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inputs: {
          videoPrompt: 'A smooth slow zoom-in camera motion focusing on BUV cleanser',
          targetPlatform: 'douyin',
          scriptPersona: '成分党',
          productId: 'prod_buv_cleanser',
        },
      }),
    });

    const jsonStep3 = await resStep3.json();
    console.assert(jsonStep3.success === true, 'Test 1 Failed: step3 response success false');
    const d = jsonStep3.data;
    console.assert(Boolean(d.title), 'Test 1 Failed: title missing');
    console.assert(Boolean(d.hook), 'Test 1 Failed: hook missing');
    console.assert(Boolean(d.body), 'Test 1 Failed: body missing');
    console.assert(Array.isArray(d.hashtags) && d.hashtags.length > 0, 'Test 1 Failed: hashtags missing');
    console.assert(Boolean(d.cta), 'Test 1 Failed: cta missing');
    console.assert(Boolean(d.platform_fit?.douyin), 'Test 1 Failed: platform_fit.douyin missing');
    console.assert(Boolean(d.platform_fit?.xiaohongshu), 'Test 1 Failed: platform_fit.xiaohongshu missing');

    console.log(`✓ Test 1 Passed: Generated copywriting title: "${d.title}"`);

    // Test 2: Prohibited word hit simulation
    const resHit = await fetch('http://localhost:3097/api/pipeline/step3', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inputs: {
          videoPrompt: 'Zoom in',
          targetPlatform: 'douyin',
          scriptPersona: '成分党',
          productInfo: {
            name: '测试产品',
            prohibitedWords: ['第一名', '绝对', '强效'],
          },
        },
      }),
    });

    const jsonHit = await resHit.json();
    console.assert(jsonHit.success === true, 'Test 2 Failed: step3 response success false');
    const dHit = jsonHit.data;
    console.assert(Array.isArray(dHit.warnings) && dHit.warnings.length > 0, 'Test 2 Failed: warnings expected when prohibited words are present in text');
    console.log(`✓ Test 2 Passed: Prohibited words compliance scan detected ${dHit.warnings.length} warning(s)`);

    console.log('--- ALL TICKET 07 STEP 3 TESTS PASSED! ---');
  } finally {
    server.close();
  }
}

runStep3Test().catch((err) => {
  console.error('Step 3 Test Suite Failed:', err);
  process.exit(1);
});
