/**
 * 端到端验证脚本：爆款视频 + 产品图 → viral_recreation_v2 完整 pipeline
 *
 * 流程：
 *   1. 登录（admin/888）拿 cookie
 *   2. 上传爆款视频（真实素材 mat_...mp4）→ /api/materials/upload-file
 *   3. 上传产品图 → /api/materials/upload-file
 *   4. 发起 run（directOutMode=viral_recreation_v2，step1 输入 mediaUrl）
 *   5. 轮询 run 状态直至 completed/failed
 *   6. 报告各 step 输出与最终产物
 *
 * 用法：npx tsx --import ./load-env.ts scripts/verify-e2e-viral-v2.ts
 */
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'http://localhost:3004';

async function login(): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '888' }),
    redirect: 'manual',
  });
  const setCookie = res.headers.get('set-cookie') || '';
  if (!setCookie) {
    const body = await res.text();
    throw new Error(`登录失败（无 cookie）: ${res.status} ${body.slice(0, 200)}`);
  }
  return setCookie.split(';')[0];
}

async function uploadFile(cookie: string, filePath: string, name: string): Promise<string> {
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === '.mp4' ? 'video/mp4' : ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'application/octet-stream';
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: mime }), path.basename(filePath));
  fd.append('name', name);
  const res = await fetch(`${BASE}/api/materials/upload-file`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: fd,
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) {
    throw new Error(`上传失败 ${filePath}: ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
  }
  return json.data?.url || json.data?.fileUrl || '';
}

async function createProduct(cookie: string, name: string): Promise<string> {
  const res = await fetch(`${BASE}/api/products`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name, positioning: '油皮专研 · 温和净澈', price: '49元' }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) throw new Error(`创建产品失败: ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
  // 响应结构：{ success: true, id, message } —— id 在顶层
  return json.id || json.data?.id || json.data?.product?.id || '';
}

async function attachProductAsset(cookie: string, productId: string, filePath: string): Promise<string> {
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'application/octet-stream';
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: mime }), path.basename(filePath));
  fd.append('role', 'hero');
  const res = await fetch(`${BASE}/api/products/${productId}/assets`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: fd,
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) throw new Error(`挂载产品图失败: ${res.status} ${JSON.stringify(json).slice(0, 200)}`);
  const asset = Array.isArray(json.data) ? json.data[0] : json.data;
  return asset?.url || asset?.id || '';
}

async function startRun(
  cookie: string,
  mediaUrl: string,
  productId: string,
  productAssetId: string
): Promise<{ runId: string; snapshot: any }> {
  const pipelineData = {
    directOutMode: 'viral_recreation_v2',
    step1: {
      inputs: {
        mediaUrl,
        platform: 'douyin',
        bloggerType: 'beauty',
        viralReason: '爆款复刻 v2 端到端验证',
      },
    },
    step2: { inputs: {} },
    step3: { inputs: {} },
    step4: { inputs: {} },
    step5: { inputs: {} },
  };
  const res = await fetch(`${BASE}/api/runs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
      'Idempotency-Key': `e2e-v2-${Date.now()}`,
    },
    body: JSON.stringify({
      pipelineData,
      productId,
      productAssetIds: [productAssetId],
      directOutMode: 'viral_recreation_v2',
    }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.success) {
    throw new Error(`启动 run 失败: ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
  }
  return { runId: json.data.id, snapshot: json.data };
}

async function waitRun(cookie: string, runId: string, timeoutMs = 30 * 60_000): Promise<any> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const res = await fetch(`${BASE}/api/runs/${runId}`, { headers: { Cookie: cookie } });
    const json: any = await res.json().catch(() => ({}));
    const snapshot = json.data || json;
    const status = snapshot.status || 'unknown';
    const step = snapshot.currentStep;
    const stepStatus = snapshot.steps?.find((s: any) => s.step === step)?.status;
    console.log(`[${((Date.now() - started) / 1000).toFixed(0)}s] status=${status} step=${step}(${stepStatus})`);
    if (['completed', 'failed', 'cancelled'].includes(status)) return snapshot;
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error(`run ${runId} 超时（${timeoutMs / 1000}s）`);
}

async function main(): Promise<number> {
  const materialsRoot = path.resolve(process.cwd(), 'uploads', 'materials');
  const videoPath = path.join(materialsRoot, 'mat_1785761660278_l27efzmt.mp4');
  const productPath = path.resolve(process.cwd(), '..', 'demo-assets', 'buv-cleanser-hero.png');
  if (!fs.existsSync(videoPath)) throw new Error(`爆款视频不存在: ${videoPath}`);
  if (!fs.existsSync(productPath)) throw new Error(`产品图不存在: ${productPath}`);

  console.log('[e2e-v2] 1/5 登录...');
  const cookie = await login();
  console.log('[e2e-v2] 2/5 上传爆款视频 + 创建产品并挂载产品图...');
  const videoUrl = await uploadFile(cookie, videoPath, '爆款参考视频');
  console.log('  视频 →', videoUrl);
  const productId = await createProduct(cookie, 'BUV 小绿泥洁面');
  console.log('  产品 →', productId);
  const productAssetId = await attachProductAsset(cookie, productId, productPath);
  console.log('  产品资产 →', productAssetId);

  console.log('[e2e-v2] 3/5 发起 viral_recreation_v2 run...');
  const { runId } = await startRun(cookie, videoUrl, productId, productAssetId);
  console.log('  runId →', runId);

  console.log('[e2e-v2] 4/5 轮询（每 5s；step2 多镜提交 + 生成可能 5-20 分钟）...');
  const snapshot = await waitRun(cookie, runId);

  console.log(`[e2e-v2] 5/5 最终状态: ${snapshot.status}`);
  console.log('  错误:', snapshot.errorMessage || '无');
  for (const s of snapshot.steps || []) {
    console.log(`  step${s.step}: ${s.status}${s.errorMessage ? ' | ' + s.errorMessage : ''}`);
  }
  const step5 = snapshot.steps?.find((s: any) => s.step === 5)?.output;
  const step2 = snapshot.steps?.find((s: any) => s.step === 2)?.output;
  console.log('  step2 videoUrl:', step2?.videoUrl || step2?.previewVideoUrl || step2?.multiShotResult?.concatenatedVideoUrl || '无');
  console.log('  step5 产物:', step5?.videoUrl || step5?.publishReport ? '有' : '无');

  return snapshot.status === 'completed' ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error('[e2e-v2] 失败:', e.message);
    process.exit(1);
  });
