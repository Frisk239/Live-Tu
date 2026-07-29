const BASE = 'http://127.0.0.1:3004';

async function j(p, o) {
  const r = await fetch(BASE + p, {
    ...o,
    headers: { 'Content-Type': 'application/json', ...(o?.headers || {}) },
  });
  const t = await r.text();
  let b;
  try {
    b = JSON.parse(t);
  } catch {
    b = { raw: t.slice(0, 1500) };
  }
  return { status: r.status, b };
}

const key = process.env.YUNWU_API_KEY || process.env.GEMINI_API_KEY;
const ybase = (process.env.YUNWU_BASE_URL || 'https://api3.wlai.vip/v1').replace(/\/$/, '');

// Step5 full error (ASCII title to isolate Chinese font issues)
let r5 = await j('/api/pipeline/step5', {
  method: 'POST',
  body: JSON.stringify({
    aspectRatio: '9:16',
    subtitleStyle: '黄字黑边',
    videoUrl: '/uploads/renders/test_render_1785200791697.mp4',
    title: 'hello e2e',
    productId: 'prod_buv_cleanser',
  }),
});
console.log('STEP5 ASCII title:', r5.status);
console.log(String(r5.b.error || JSON.stringify(r5.b)).slice(0, 1200));

// Step5 with no subtitles if API allows empty
r5 = await j('/api/pipeline/step5', {
  method: 'POST',
  body: JSON.stringify({
    aspectRatio: '9:16',
    subtitleStyle: '黄字黑边',
    videoUrl: '/uploads/renders/test_render_1785200791697.mp4',
    title: '',
    productId: 'prod_buv_cleanser',
  }),
});
console.log('\nSTEP5 empty title:', r5.status, String(r5.b.error || r5.b.success || '').slice(0, 400));

// Public image from seedream for Seedance
const ir = await fetch(ybase + '/images/generations', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'doubao-seedream-4-5-251128',
    prompt: 'mint green cleanser tube product white bg',
    n: 1,
    size: '1024x1024',
  }),
});
const ij = await ir.json();
const publicImg = ij?.data?.[0]?.url;
console.log('\npublicImg status', ir.status, publicImg?.slice(0, 140));

if (publicImg) {
  const s2 = await j('/api/pipeline/step2', {
    method: 'POST',
    body: JSON.stringify({
      static_image_prompt: 'product close-up mint green',
      imageUrl: publicImg,
      videoTone: 'xiaohongshu_healing',
      durationSec: 4,
      textModel: 'Gemini 3.6 Flash',
      videoModel: 'Seedance 2.0 Fast',
      productId: 'prod_buv_cleanser',
    }),
  });
  console.log(
    'STEP2 seedance:',
    s2.status,
    'task=',
    s2.b.data?.seedanceTaskId,
    'st=',
    s2.b.data?.seedanceStatus,
    'err=',
    (s2.b.data?.seedanceError || s2.b.data?.seedanceHint || '').slice(0, 200)
  );

  // Poll if task created
  const taskId = s2.b.data?.seedanceTaskId;
  if (taskId) {
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 8000));
      const q = await j(`/api/seedance/generations/${encodeURIComponent(taskId)}`);
      const st = q.b.data?.status || q.b.data?.state;
      const url = q.b.data?.url || q.b.data?.video_url || q.b.data?.previewVideoUrl;
      console.log(`poll ${i + 1}`, q.status, st, url?.slice?.(0, 80) || JSON.stringify(q.b).slice(0, 120));
      if (url || /fail|error|success|completed|succeeded/i.test(String(st))) break;
    }
  }
}

const h = await j('/api/health');
console.log('\nhealth seedance ready', h.b.readiness?.seedance);
console.log('ffmpeg', h.b.readiness?.ffmpeg);
