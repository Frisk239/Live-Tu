import { initDatabase } from '../lib/db';
import express from 'express';
import { pipelineRouter } from '../routes/pipeline';
import { authStub, hasGatewayKey } from './_helpers';

async function runStep3Test() {
  console.log('--- Starting Ticket 07 Step 3 Copywriting & Compliance Scan Tests ---');
  initDatabase();

  // Step 3 文案生成依赖真实 LLM Key；CI 无 Key 时干净跳过（本地配置 Key 后自动恢复）
  if (!hasGatewayKey()) {
    console.log('SKIPPED: 未配置 YUNWU_API_KEY/GEMINI_API_KEY，跳过需要真实 LLM 的文案生成测试');
    return;
  }

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
    if (!(jsonStep3.success === true)) throw new Error('Test 1 Failed: step3 response success false');
    const d = jsonStep3.data;
    if (!(Boolean(d.title))) throw new Error('Test 1 Failed: title missing');
    if (!(Boolean(d.hook))) throw new Error('Test 1 Failed: hook missing');
    if (!(Boolean(d.body))) throw new Error('Test 1 Failed: body missing');
    if (!(Array.isArray(d.hashtags) && d.hashtags.length > 0)) throw new Error('Test 1 Failed: hashtags missing');
    if (!(Boolean(d.cta))) throw new Error('Test 1 Failed: cta missing');
    if (!(Boolean(d.platform_fit?.douyin))) throw new Error('Test 1 Failed: platform_fit.douyin missing');
    if (!(Boolean(d.platform_fit?.xiaohongshu))) throw new Error('Test 1 Failed: platform_fit.xiaohongshu missing');

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
    if (!(jsonHit.success === true)) throw new Error('Test 2 Failed: step3 response success false');
    const dHit = jsonHit.data;
    if (!(Array.isArray(dHit.warnings) && dHit.warnings.length > 0)) throw new Error('Test 2 Failed: warnings expected when prohibited words are present in text');
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
