import { db } from '../server/lib/db';

async function testProbeAll() {
  console.log('=====================================================');
  console.log('  测试全量 SQLite 模型真实连通性探测接口');
  console.log('=====================================================\n');

  const rows = db.prepare('SELECT * FROM model_config').all() as any[];

  for (const r of rows) {
    const model = {
      id: r.id,
      name: r.name,
      category: r.category,
      provider: r.provider,
      baseUrl: r.base_url,
      apiKey: r.api_key,
      modelCode: r.model_code,
    };

    console.log(`探测 [${r.category.toUpperCase()}] ${r.name} (${r.model_code}) ...`);

    try {
      const res = await fetch('http://localhost:3004/api/models/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      });

      if (!res.ok) {
        console.log(`  ✗ HTTP ${res.status} ${res.statusText}`);
      } else {
        const json = await res.json();
        console.log(`  ${json.message}`);
      }
    } catch (err: any) {
      console.log(`  ✗ 异常: ${err.message}`);
    }
  }

  console.log('\n=====================================================');
}

testProbeAll().catch(console.error);
