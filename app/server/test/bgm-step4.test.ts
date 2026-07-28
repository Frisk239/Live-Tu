import { initDatabase } from '../lib/db';
import express from 'express';
import { bgmRouter } from '../routes/bgm';
import { pipelineRouter } from '../routes/pipeline';

async function runBgmStep4Test() {
  console.log('--- Starting Ticket 08 BGM Library & Step 4 Semantic Matching Tests ---');
  initDatabase();

  const app = express();
  app.use(express.json());
  app.use('/api/bgm', bgmRouter);
  app.use('/api/pipeline', pipelineRouter);

  const server = app.listen(3098);

  try {
    // Test 1: GET /api/bgm (List seeded BGM entries)
    const resList = await fetch('http://localhost:3098/api/bgm');
    const jsonList = await resList.json();
    console.assert(jsonList.success === true, 'Test 1 Failed: GET /api/bgm success false');
    console.assert(Array.isArray(jsonList.data) && jsonList.data.length >= 4, 'Test 1 Failed: BGM seed entries missing');
    console.log(`✓ Test 1 Passed: Retrieved ${jsonList.data.length} BGM entries from SQLite`);

    // Test 2: POST /api/bgm/upload (Upload custom BGM)
    const resUpload = await fetch('http://localhost:3098/api/bgm/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Test Chill Wave',
        artist: 'Test Beats',
        bpm: 95,
        mood: '治愈',
        styleTags: ['Lofi', 'Chill'],
        url: 'https://assets.mixkit.co/music/preview/mixkit-feeling-happy-5.mp3',
      }),
    });

    const jsonUpload = await resUpload.json();
    console.assert(jsonUpload.success === true, 'Test 2 Failed: BGM upload failed');
    const newBgmId = jsonUpload.data.id;
    console.log(`✓ Test 2 Passed: Uploaded BGM ID: ${newBgmId}`);

    // Test 3: POST /api/pipeline/step4 (LLM / SQLite Semantic BGM Matching)
    const resStep4 = await fetch('http://localhost:3098/api/pipeline/step4', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inputs: {
          copywritingTitle: 'BUV 小绿泥洁面膏爆款体验',
          tonePreference: '卡点',
          commercialScenario: '抖音/小红书商业化',
          productId: 'prod_buv_cleanser',
        },
      }),
    });

    const jsonStep4 = await resStep4.json();
    console.assert(jsonStep4.success === true, 'Test 3 Failed: Step 4 response success false');
    const rec = jsonStep4.data?.bgm_recommendation;
    console.assert(Boolean(rec?.track_name), 'Test 3 Failed: track_name missing');
    console.assert(Boolean(rec?.sync_point), 'Test 3 Failed: sync_point missing');
    console.assert(Boolean(rec?.audioSampleUrl), 'Test 3 Failed: audioSampleUrl missing');
    console.log(`✓ Test 3 Passed: Matched BGM track: "${rec.track_name}" (${rec.bpm} BPM)`);

    // Test 4: DELETE /api/bgm/:id
    const resDel = await fetch(`http://localhost:3098/api/bgm/${newBgmId}`, { method: 'DELETE' });
    const jsonDel = await resDel.json();
    console.assert(jsonDel.success === true, 'Test 4 Failed: BGM deletion failed');
    console.log(`✓ Test 4 Passed: Successfully deleted BGM ID ${newBgmId}`);

    console.log('--- ALL TICKET 08 BGM & STEP 4 TESTS PASSED! ---');
  } finally {
    server.close();
  }
}

runBgmStep4Test().catch((err) => {
  console.error('BGM Step 4 Test Suite Failed:', err);
  process.exit(1);
});
