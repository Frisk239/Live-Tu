const BASE = 'http://localhost:3004';
const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin_products', password: 'products-test-pass' }) });
const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
const res = await fetch(`${BASE}/api/pipeline/step2`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify({
    static_image_prompt: 'commercial product shot',
    imageUrl: 'https://raw.githubusercontent.com/Frisk239/Live-Tu/main/demo-assets/buv-cleanser-hero.png',
    videoTone: 'xiaohongshu_healing',
    durationSec: 5,
    videoModel: 'Seedance 2.0 Fast',
  }),
});
const j = await res.json();
console.log('success:', j.success, '| seedanceStatus:', j.data?.seedanceStatus);
console.log('error:', (j.data?.seedanceError || j.error || '(无)').slice(0, 160));
console.log('taskId:', j.data?.seedanceTaskId || '(无)');
