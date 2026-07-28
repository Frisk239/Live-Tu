import { initDatabase } from '../lib/db';
import express from 'express';
import { pipelineRouter } from '../routes/pipeline';

async function runStep1Test() {
  console.log('--- Starting Ticket 05 Step 1 Multimodal Vision Tests ---');
  initDatabase();

  const app = express();
  app.use(express.json());
  app.use('/api/pipeline', pipelineRouter);

  const server = app.listen(3098);

  try {
    // Test 1: POST /api/pipeline/step1 with image URL
    const res1 = await fetch('http://localhost:3098/api/pipeline/step1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inputs: {
          mediaUrl: 'https://images.unsplash.com/photo-1556228720-195a672e8a03?auto=format&fit=crop&w=600&q=80',
          platform: 'xiaohongshu',
          bloggerType: 'skincare_expert',
          viralReason: '高光特写+膏体冰淇淋拉丝质感',
          productId: 'prod_buv_cleanser',
        },
      }),
    });

    const json1 = await res1.json();
    console.assert(json1.success === true, 'Test 1 Failed: step1 response success false');
    console.assert(Boolean(json1.data?.static_image_prompt), 'Test 1 Failed: static_image_prompt missing');
    console.assert(Array.isArray(json1.data?.palette), 'Test 1 Failed: palette is not array');
    console.assert(Boolean(json1.data?.rationale), 'Test 1 Failed: rationale missing');
    console.log('✓ Test 1 Passed: Step 1 with image URL returned full 10-field Vision deconstruction data');

    // Test 2: POST /api/pipeline/step1 text-only fallback (no image URL)
    const res2 = await fetch('http://localhost:3098/api/pipeline/step1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inputs: {
          platform: 'douyin',
          bloggerType: 'ingredient_geek',
          viralReason: '3重天然泥对比硬核测评',
          productId: 'prod_buv_cleanser',
        },
      }),
    });

    const json2 = await res2.json();
    console.assert(json2.success === true, 'Test 2 Failed: step1 text-only success false');
    console.assert(Boolean(json2.data?.scene), 'Test 2 Failed: scene missing in text-only fallback');
    console.log('✓ Test 2 Passed: Step 1 text-only fallback returned full 10-field deconstruction data');

    console.log('--- ALL TICKET 05 STEP 1 TESTS PASSED! ---');
  } finally {
    server.close();
  }
}

runStep1Test().catch((err) => {
  console.error('Step 1 Test Suite Failed:', err);
  process.exit(1);
});
