import { db } from '../server/lib/db';

async function testBackendHandlerDirectly() {
  console.log('=====================================================');
  console.log('  直接测试模型连通性探测后端逻辑（非走旧 3004 端口进程）');
  console.log('=====================================================\n');

  const rows = db.prepare('SELECT * FROM model_config').all() as any[];

  for (const r of rows) {
    const category = r.category;
    let baseUrl = (r.base_url || '').trim() || process.env.YUNWU_BASE_URL || 'https://api3.wlai.vip/v1';
    let apiKey = (r.api_key || '').trim() || process.env.YUNWU_API_KEY || process.env.GEMINI_API_KEY || '';

    baseUrl = baseUrl.replace(/\/$/, '');

    console.log(`探测 [${category.toUpperCase()}] ${r.name} (${r.model_code}) @ ${baseUrl} ...`);
    const t0 = Date.now();

    if (category === 'text') {
      try {
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: r.model_code,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 1,
          }),
        });

        const elapsed = Date.now() - t0;
        if (response.ok) {
          console.log(`  ✓ 真实连通成功 (${elapsed}ms)`);
        } else {
          console.log(`  ✗ 连通失败 (HTTP ${response.status}): ${await response.text()}`);
        }
      } catch (err: any) {
        console.log(`  ✗ 异常: ${err.message}`);
      }
    } else if (category === 'image') {
      try {
        const response = await fetch(`${baseUrl}/models`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${apiKey}` },
        });

        const elapsed = Date.now() - t0;
        if (response.ok || response.status === 400 || response.status === 404) {
          console.log(`  ✓ 真实连通成功 (${elapsed}ms)`);
        } else {
          console.log(`  ✗ 连通失败 (HTTP ${response.status})`);
        }
      } catch (err: any) {
        console.log(`  ✗ 异常: ${err.message}`);
      }
    } else if (category === 'video') {
      const { getSeedanceToken } = await import('../server/routes/seedance');
      try {
        await getSeedanceToken(false);
        const elapsed = Date.now() - t0;
        console.log(`  ✓ 真实连通成功 (${elapsed}ms)`);
      } catch (err: any) {
        const elapsed = Date.now() - t0;
        console.log(`  ✗ 连通失败: ${err.message} (${elapsed}ms)`);
      }
    }
  }

  console.log('\n=====================================================');
}

testBackendHandlerDirectly().catch(console.error);
