const BASE = 'http://localhost:3004';
const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin_products', password: 'products-test-pass' }) });
const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
const sleep = ms => new Promise(r => setTimeout(r, ms));

for (let round = 1; round <= 4; round++) {
  const res = await fetch(`${BASE}/api/pipeline/step2`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({
      static_image_prompt: 'commercial product shot of mint green cleanser, 8k',
      imageUrl: 'https://raw.githubusercontent.com/Frisk239/Live-Tu/main/demo-assets/buv-cleanser-hero.png',
      videoTone: 'xiaohongshu_healing',
      durationSec: 5,
      videoModel: 'Seedance 2.0 Fast',
    }),
  });
  const j = await res.json();
  const st = j.data?.seedanceStatus;
  console.log(`[${new Date().toISOString().slice(11,19)}] round ${round}:`, st, j.data?.seedanceTaskId ? '✓ 已提交!' : (j.data?.seedanceError || '').slice(0, 60));
  if (j.data?.seedanceTaskId) break;
  await sleep(60000);
}
