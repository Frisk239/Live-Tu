#!/usr/bin/env node
/**
 * 临时诊断：手动驱动 quality-loop 同款 API 流程，dump shot 表 error_message。
 * 用法：node scripts/repro-ql.mjs <baseUrl>
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:3007';
const cookieJar = { cookie: '' };

async function req(method, url, body, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (cookieJar.cookie) headers.cookie = cookieJar.cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.getSetCookie?.();
  if (setCookie?.length) {
    cookieJar.cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  }
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

const fixture = (name) =>
  readFileSync(path.resolve(process.cwd(), 'e2e/fixtures', name));

async function main() {
  const login = await req('POST', '/api/auth/login', { username: 'admin', password: '888' });
  console.log('login', login.status, JSON.stringify(login.json?.user || login.json));

  // 1. 上传素材（ux-sample.png 作为首帧素材）
  const form = new FormData();
  form.append('file', new Blob([fixture('ux-sample.png')], { type: 'image/png' }), 'ux-sample.png');
  const up = await fetch(BASE + '/api/materials/upload-file', {
    method: 'POST', body: form, headers: { cookie: cookieJar.cookie },
  });
  const upJson = await up.json();
  console.log('upload', up.status, JSON.stringify(upJson).slice(0, 200));
  const frameUrl = upJson.data?.url;

  // 2. 创建产品 + hero 资产
  const prod = await req('POST', '/api/products', { name: 'REPRO 产品', positioning: '卖点', price: '¥99' });
  const productId = prod.json?.data?.id ?? prod.json?.id;
  console.log('product', prod.status, productId);
  const attach = await req('POST', `/api/products/${productId}/assets`, { url: frameUrl, role: 'hero' });
  console.log('attach', attach.status);

  // 3. step2 创建两镜任务
  const shotList = Array.from({ length: 2 }, (_, i) => ({
    shotIndex: i + 1,
    shotType: i === 0 ? 'close-up' : 'wide',
    cameraMovement: 'push-in',
    description: `repro shot ${i + 1}`,
    keyframeUrl: frameUrl,
  }));
  const s2 = await req('POST', '/api/pipeline/step2', { productInfo: { name: 'REPRO' }, shotList });
  console.log('step2', s2.status, JSON.stringify(s2.json).slice(0, 300));
  const sessionId = s2.json?.data?.multiShotResult?.sessionId;

  // 4. 保存草稿
  const shots = Array.from({ length: 2 }, (_, i) => ({
    shotIndex: i + 1, startTime: i * 5, endTime: (i + 1) * 5,
    shotSize: i === 0 ? 'close_up' : 'wide', cameraPosition: 'front',
    cameraMovement: 'push_in', lighting: 'soft', dialogue: [], soundEffects: [],
    mustKeep: ['产品包装'], mustReplace: ['竞品 logo'],
    generationMode: 'image_to_video',
    capabilityConstraints: { maxDurationSec: 5, minDurationSec: 3, supportedAspectRatios: ['9:16'], supportedResolutions: ['720p'], requiredReferenceInputs: 1 },
    status: 'pending', blockers: [], warnings: [], evidence: [],
    candidates: [],
    selectedCandidateId: null, promptOverride: null, modelId: 'Seedance 2.0 Fast',
  }));
  const draft = await req('POST', '/api/workbench/draft', {
    sessionId,
    draftJson: JSON.stringify({ shots, videoModelId: 'Seedance 2.0 Fast', referenceInputCount: 1, productId, referenceKeyframes: [frameUrl] }),
    autonomyMode: 'step_by_step',
  });
  console.log('draft', draft.status, JSON.stringify(draft.json).slice(0, 200));

  // 5. 确认点
  const c1 = await req('POST', '/api/workbench/confirm', { sessionId, type: 'deconstruction' });
  const c2 = await req('POST', '/api/workbench/confirm', { sessionId, type: 'shot_plan' });
  console.log('confirm deconstruction', c1.status, 'shot_plan', c2.status);
  const pf = await req('POST', '/api/workbench/preflight', { sessionId });
  console.log('preflight', pf.status, JSON.stringify(pf.json?.data).slice(0, 400));
  const pa = await req('POST', '/api/workbench/paid-auth', { sessionId, enabled: true });
  console.log('paid-auth', pa.status, JSON.stringify(pa.json?.data).slice(0, 200));

  // 6. 批量提交
  const submit = await req('POST', '/api/workbench/confirm', { sessionId, type: 'batch_submit' });
  console.log('batch_submit', submit.status, JSON.stringify(submit.json).slice(0, 500));

  // 7. 状态
  const state = await req('GET', `/api/workbench/state?sessionId=${encodeURIComponent(sessionId)}`);
  console.log('state', JSON.stringify(state.json?.data?.shotStates ?? state.json?.data).slice(0, 800));

  // 8. QA 第 1 镜（FAKE_SEMANTIC_QA_FAIL_ONCE=hook_quality → 首次 fail）
  const shot1 = state.json?.data?.shotStates?.find((s) => s.shotIndex === 1)?.shotId;
  const qa1 = await req('POST', '/api/workbench/qa-shot', { runId: sessionId, shotId: shot1 });
  console.log('qa-shot-1', qa1.status, JSON.stringify(qa1.json?.data).slice(0, 300));

  // 9. fix-shot 第 1 镜 → 应触发重生成（新版本）
  const fix1 = await req('POST', '/api/workbench/fix-shot', { runId: sessionId, shotId: shot1 });
  console.log('fix-shot-1', fix1.status, JSON.stringify(fix1.json?.data).slice(0, 300));
  const state2 = await req('GET', `/api/workbench/state?sessionId=${encodeURIComponent(sessionId)}`);
  console.log('state-after-fix', JSON.stringify(state2.json?.data?.shotStates ?? []).slice(0, 900));
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
