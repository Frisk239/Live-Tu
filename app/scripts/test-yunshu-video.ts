/**
 * yunshu.hk 视频链路真实验证脚本（S7.1 第一刀验收）：
 *  真实首帧图（公网直链）→ POST /v1/video/generations → 轮询 → 打印结果。
 *  会真实扣费一次（~1-3 元），跑前确认环境变量：
 *    SEEDANCE_FALLBACK_PROVIDER=yunshu、YUNSHU_BASE_URL=https://yunshu.hk
 *    key 取 YUNSHU_API_KEY，留空复用 YUNWU_API_KEY
 * 运行：tsx --import ./load-env.ts scripts/test-yunshu-video.ts
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const baseUrl = (process.env.YUNSHU_BASE_URL || '').replace(/\/$/, '');
const apiKey = (process.env.YUNSHU_API_KEY || process.env.YUNWU_API_KEY || '').trim();
const model = process.env.YUNSHU_MODEL || 'doubao-seedance-1-0-pro-fast-251015';
const imageUrl =
  process.env.YUNSHU_TEST_IMAGE ||
  'https://raw.githubusercontent.com/Frisk239/Live-Tu/main/demo-assets/buv-cleanser-hero.png';
const prompt = 'product hero shot, gentle water splashing on green clay cleanser jar, cinematic close-up, smooth slow motion, clean studio light';

if (!baseUrl || !apiKey) {
  console.error('[yunshu] 缺少 YUNSHU_BASE_URL 或 YUNWU_API_KEY，请先配置 .env');
  process.exit(1);
}

async function api(apiPath: string, init: RequestInit = {}) {
  const res = await fetch(`${baseUrl}${apiPath}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

async function main() {
  console.log('=====================================================');
  console.log('  yunshu.hk 视频生成链路真实验证（扣费一次）');
  console.log('=====================================================\n');
  console.log(`Base URL : ${baseUrl}`);
  console.log(`Model    : ${model}`);
  console.log(`Image    : ${imageUrl}`);
  console.log(`Key      : ${apiKey.slice(0, 8)}***${apiKey.slice(-4)}\n`);

  const startedAt = Date.now();
  console.log('[1/3] 提交视频生成任务 POST /v1/video/generations ...');
  const submit = await api('/v1/video/generations', {
    method: 'POST',
    body: JSON.stringify({ model, prompt, image: imageUrl }),
  });
  console.log(`      状态 ${submit.status}，响应原文：`);
  console.log(JSON.stringify(submit.json, null, 2).slice(0, 800));
  console.log();

  const taskId = submit.json?.data?.task_id || submit.json?.data?.id;
  if (!taskId) {
    console.error('[yunshu] 提交未返回 task_id，终止');
    process.exit(1);
  }
  console.log(`[2/3] 任务 ${taskId}，开始轮询 GET /v1/video/generations/{id}（间隔 5s，上限 10min）...`);

  let lastStatus = '';
  const deadline = startedAt + 10 * 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const poll = await api(`/v1/video/generations/${taskId}`);
    const data = poll.json?.data || {};
    const status = String(data.task_status || data.status || '');
    const url = data.video_url || data.url || '';
    if (status !== lastStatus) {
      console.log(`      [${Math.round((Date.now() - startedAt) / 1000)}s] task_status=${status || '(空)'}${url ? ' → 有视频 URL' : ''}`);
      lastStatus = status;
    }
    if (['succeeded', 'success'].includes(status.toLowerCase()) && url) {
      console.log(`\n[3/3] 完成！耗时 ${Math.round((Date.now() - startedAt) / 1000)}s`);
      console.log(`视频 URL: ${url}`);
      console.log(`完整响应: ${JSON.stringify(poll.json).slice(0, 600)}`);
      process.exit(0);
    }
    if (['failed', 'error'].includes(status.toLowerCase())) {
      console.error(`\n[3/3] 任务失败: ${JSON.stringify(poll.json).slice(0, 400)}`);
      process.exit(1);
    }
  }
  console.error('[yunshu] 轮询超时（10min）');
  process.exit(1);
}

main().catch((err) => {
  console.error('[yunshu] 脚本异常:', err);
  process.exit(1);
});
