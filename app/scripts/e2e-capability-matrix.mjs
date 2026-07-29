/**
 * Full product capability matrix against live server + 云雾.
 * Run: node --import ./load-env.ts scripts/e2e-capability-matrix.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:3004';
const results = [];
const t0all = Date.now();

function record(area, name, ok, detail = '', ms = 0) {
  results.push({ area, name, ok, detail: String(detail).slice(0, 220), ms });
  const icon = ok ? '✓' : '✗';
  console.log(`${icon} [${area}] ${name} ${ms ? `(${ms}ms)` : ''} ${detail ? '— ' + String(detail).slice(0, 120) : ''}`);
}

async function jsonFetch(urlPath, opts = {}) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}${urlPath}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  return { res, body, ms: Date.now() - t0 };
}

async function main() {
  console.log(`\n=== Live-Tu Capability Matrix @ ${BASE} ===\n`);

  // 0. Health
  {
    const { res, body, ms } = await jsonFetch('/api/health');
    const ok = res.ok && body.status === 'ok';
    record('infra', 'health', ok, JSON.stringify(body.readiness || body).slice(0, 180), ms);
  }

  // 1. Models config
  let models = null;
  {
    const { res, body, ms } = await jsonFetch('/api/models/config');
    const ok = res.ok && body.success && body.textModels?.length && body.imageModels?.length;
    models = body;
    record(
      'models',
      'GET /models/config',
      ok,
      `text=${body.textModels?.length} image=${body.imageModels?.length} video=${body.videoModels?.length} defT=${body.defaultTextModel} defI=${body.defaultImageModel}`,
      ms
    );
    if (ok) {
      const hasGemini = body.textModels.some((m) => m.id === 'Gemini 3.6 Flash' && m.enabled);
      const hasGptImg = body.imageModels.some((m) => m.id === 'GPT Image 1' && m.enabled);
      const noFake = !body.imageModels.some((m) => /Imagen|Nano Banana/i.test(m.id));
      record('models', 'default Gemini + real image models', hasGemini && hasGptImg && noFake, `gemini=${hasGemini} gptImg=${hasGptImg} noFake=${noFake}`);
    }
  }

  // 2. Products / materials / presets / tasks / bgm
  for (const [area, p] of [
    ['crud', '/api/products'],
    ['crud', '/api/materials'],
    ['crud', '/api/presets'],
    ['crud', '/api/tasks'],
    ['crud', '/api/bgm'],
  ]) {
    try {
      const { res, body, ms } = await jsonFetch(p);
      const ok = res.ok && (body.success !== false);
      const n = Array.isArray(body.data) ? body.data.length : Array.isArray(body) ? body.length : '?';
      record(area, `GET ${p}`, ok, `n=${n}`, ms);
    } catch (e) {
      record(area, `GET ${p}`, false, e.message);
    }
  }

  // 3. Pick product
  let productId = null;
  {
    const { body } = await jsonFetch('/api/products');
    const list = body.data || body.products || [];
    productId = list[0]?.id || null;
    record('crud', 'has product seed', Boolean(productId), productId || 'none');
  }

  // 4. Step1 vision (Gemini) — use public image URL so no PUBLIC_BASE_URL needed
  const sampleImage =
    'https://images.unsplash.com/photo-1556228720-195a672e8a03?auto=format&fit=crop&w=600&q=80';
  let step1Out = null;
  {
    const { res, body, ms } = await jsonFetch('/api/pipeline/step1', {
      method: 'POST',
      body: JSON.stringify({
        mediaUrl: sampleImage,
        platform: 'xiaohongshu',
        bloggerType: 'daily_seeding',
        viralReason: 'e2e capability matrix',
        textModel: 'Gemini 3.6 Flash',
        productId,
      }),
    });
    const ok = res.ok && body.success && body.data?.static_image_prompt;
    step1Out = body.data;
    record('step1', 'multimodal vision (Gemini)', ok, `source=${body.source} model=${body.modelUsed}`, ms);
  }

  // 5. Text2img — prefer Seedream (faster) if available else GPT Image Mini
  let genImageUrl = null;
  {
    const imageModel =
      models?.imageModels?.find((m) => m.id === 'Seedream 4.5' && m.enabled)?.id ||
      models?.imageModels?.find((m) => m.id === 'GPT Image 1 Mini' && m.enabled)?.id ||
      'GPT Image 1';
    const prompt =
      step1Out?.static_image_prompt ||
      'mint green skincare tube product photo, white bathroom, commercial lifestyle, 8k';
    const { res, body, ms } = await jsonFetch('/api/pipeline/generate-image', {
      method: 'POST',
      body: JSON.stringify({ prompt: String(prompt).slice(0, 500), productId, imageModel }),
    });
    const ok = res.ok && body.success && body.data?.imageUrl;
    genImageUrl = body.data?.imageUrl || null;
    const local = genImageUrl?.startsWith('/uploads/');
    if (local) {
      const fp = path.join(process.cwd(), genImageUrl.replace(/^\//, ''));
      const exists = fs.existsSync(fp);
      const size = exists ? fs.statSync(fp).size : 0;
      record('step1', `text2img (${imageModel})`, ok && exists && size > 1000, `url=${genImageUrl} bytes=${size} source=${body.source}`, ms);
    } else {
      record('step1', `text2img (${imageModel})`, ok, `url=${String(genImageUrl).slice(0, 80)} source=${body.source} err=${body.error || ''}`, ms);
    }
  }

  // 6. Step2 motion + seedance (may fail without PUBLIC_BASE_URL)
  let step2Out = null;
  {
    const imageUrl = genImageUrl?.startsWith('http') ? genImageUrl : sampleImage;
    const { res, body, ms } = await jsonFetch('/api/pipeline/step2', {
      method: 'POST',
      body: JSON.stringify({
        static_image_prompt: step1Out?.static_image_prompt || 'product close-up',
        imageUrl,
        videoTone: 'xiaohongshu_healing',
        durationSec: 4,
        textModel: 'Gemini 3.6 Flash',
        videoModel: 'Seedance 2.0 Fast',
        productId,
      }),
    });
    const ok = res.ok && body.success && body.data?.video_prompt;
    step2Out = body.data;
    record(
      'step2',
      'motion prompt LLM',
      ok,
      `source=${body.source} seedance=${body.data?.seedanceStatus || body.data?.seedanceHint || 'n/a'}`,
      ms
    );
    if (body.data?.seedanceTaskId) {
      record('step2', 'seedance task submitted', true, `taskId=${body.data.seedanceTaskId}`);
    } else {
      record(
        'step2',
        'seedance task submitted',
        false,
        body.data?.seedanceHint || body.data?.seedanceError || 'no task (often PUBLIC_BASE_URL missing for local uploads)'
      );
    }
  }

  // 7. Step3 copywriting
  let step3Out = null;
  {
    const { res, body, ms } = await jsonFetch('/api/pipeline/step3', {
      method: 'POST',
      body: JSON.stringify({
        videoPrompt: step2Out?.video_prompt || 'slow zoom on product',
        targetPlatform: 'xiaohongshu',
        scriptPersona: '油皮亲妈',
        textModel: 'Gemini 3.6 Flash',
        productId,
      }),
    });
    const ok = res.ok && body.success && body.data?.title;
    step3Out = body.data;
    record('step3', 'copywriting (Gemini)', ok, `source=${body.source} title=${body.data?.title}`, ms);
  }

  // 8. Step4 BGM
  let step4Out = null;
  {
    const { res, body, ms } = await jsonFetch('/api/pipeline/step4', {
      method: 'POST',
      body: JSON.stringify({
        copywritingTitle: step3Out?.title || 'e2e test',
        tonePreference: '治愈',
        commercialScenario: '抖音/小红书商业化',
        textModel: 'Gemini 3.6 Flash',
        productId,
      }),
    });
    const ok = res.ok && body.success && body.data?.bgm_recommendation;
    step4Out = body.data;
    record(
      'step4',
      'BGM match',
      ok,
      `source=${body.source} track=${body.data?.bgm_recommendation?.track_name}`,
      ms
    );
  }

  // 9. Step5 render readiness + attempt
  {
    const { res, body, ms } = await jsonFetch('/api/health');
    const ffmpegOk = body?.readiness?.ffmpeg?.installed;
    record('step5', 'ffmpeg available', Boolean(ffmpegOk), JSON.stringify(body?.readiness?.ffmpeg || {}), ms);
  }

  // Prefer seedance preview; else valid local source (e2e_valid_source / e2e_step5_fixed)
  {
    const renderDir = path.join(process.cwd(), 'uploads', 'renders');
    const preferred = ['e2e_valid_source.mp4', 'e2e_step5_fixed.mp4'];
    const localValid = preferred.find((f) => fs.existsSync(path.join(renderDir, f)));
    const videoUrl = step2Out?.previewVideoUrl || (localValid ? `/uploads/renders/${localValid}` : null);

    if (videoUrl) {
      const { res, body, ms } = await jsonFetch('/api/pipeline/step5', {
        method: 'POST',
        body: JSON.stringify({
          aspectRatio: '9:16',
          subtitleStyle: '黄字黑边',
          videoUrl,
          videoSourceUrl: videoUrl,
          audioUrl: step4Out?.bgm_recommendation?.audioSampleUrl,
          title: step3Out?.title || 'e2e 成片测试',
          productId,
        }),
      });
      const outUrl = body.data?.output?.videoUrl || body.data?.output?.filename;
      const ok = res.ok && body.success && Boolean(outUrl);
      if (ok && outUrl?.startsWith?.('/uploads/')) {
        const fp = path.join(process.cwd(), outUrl.replace(/^\//, ''));
        const size = fs.existsSync(fp) ? fs.statSync(fp).size : 0;
        record('step5', 'render pipeline', size > 1000, `out=${outUrl} bytes=${size} source=${body.source}`, ms);
      } else {
        record('step5', 'render pipeline', ok, `source=${body.source} err=${body.error || ''} out=${outUrl || ''}`, ms);
      }
    } else {
      record('step5', 'render pipeline', false, 'no seedance video and no valid local mp4');
    }
  }

  // 10. Direct yunwu text+image spot check (bypass app if needed)
  {
    const key = process.env.YUNWU_API_KEY || process.env.GEMINI_API_KEY;
    const ybase = (process.env.YUNWU_BASE_URL || 'https://api3.wlai.vip/v1').replace(/\/$/, '');
    if (key) {
      const t0 = Date.now();
      const r = await fetch(`${ybase}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gemini-3.6-flash',
          messages: [{ role: 'user', content: 'Reply with JSON only: {"pong":true}' }],
          temperature: 0,
        }),
      });
      record('yunwu', 'gemini-3.6-flash chat', r.ok, `status=${r.status}`, Date.now() - t0);
    }
  }

  // Summary
  console.log('\n=== SUMMARY ===');
  const byArea = {};
  for (const r of results) {
    byArea[r.area] = byArea[r.area] || { pass: 0, fail: 0, items: [] };
    if (r.ok) byArea[r.area].pass++;
    else byArea[r.area].fail++;
    byArea[r.area].items.push(r);
  }
  let totalPass = 0;
  let totalFail = 0;
  for (const [area, s] of Object.entries(byArea)) {
    totalPass += s.pass;
    totalFail += s.fail;
    console.log(`${area}: ${s.pass} pass / ${s.fail} fail`);
  }
  console.log(`\nTOTAL: ${totalPass} pass / ${totalFail} fail in ${Date.now() - t0all}ms`);
  console.log(totalFail === 0 ? '\nPRODUCT MATRIX: ALL GREEN' : '\nPRODUCT MATRIX: GAPS REMAIN');

  // Write report
  const reportPath = path.join(process.cwd(), 'uploads', 'e2e_capability_report.json');
  fs.writeFileSync(
    reportPath,
    JSON.stringify({ at: new Date().toISOString(), base: BASE, totalPass, totalFail, results }, null, 2)
  );
  console.log(`report → ${reportPath}`);

  process.exit(totalFail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
