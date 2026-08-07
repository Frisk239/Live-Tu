/**
 * P0 风控验证脚本：文字清除 → 重新提交
 *
 * 流程：
 *   1) 对被拒控制图（本地缓存 conditioned_first_frame_*.png）做「仅移除文字层」编辑
 *      （云雾 /images/edits，保留人物/动作/场景/产品，仅去除文字）；
 *   2) 发布公网（DEMO_PUBLIC_UPLOAD_URL 中继）；
 *   3) 以 kind=image role=first_frame 提交 Seedance；
 *   4) 打印结果（200 = 绕过风控成功；422 = 仍被拦）。
 *
 * 用法：npx tsx --import ./load-env.ts scripts/verify-detext-submit.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { removeTextLayersFromImage } from '../server/lib/viral-control-image';
import { submitProbeTask } from '../server/lib/video-submission-port';
import { initDatabase } from '../server/lib/db';
import { buildSeedanceGenerationBody } from '../server/routes/seedance';

async function main(): Promise<number> {
  initDatabase();
  // 被拒控制图本地缓存（与公网 1786068698142_174e10b6.png 同字节）
  const controlLocal = path.resolve(
    process.cwd(),
    'uploads',
    'renders',
    'conditioned_first_frame_1786068698524_e54b00c1.png'
  );
  if (!fs.existsSync(controlLocal)) {
    console.error('[verify] 控制图本地缓存不存在:', controlLocal);
    return 1;
  }
  const controlPublic = 'http://64.83.1.104/live-tu-assets/derived/1786068698142_174e10b6.png';
  console.log('[verify] 1/4 文字清除编辑（保留人物/动作/场景/产品，仅移除文字）...');

  const detexted = await removeTextLayersFromImage({
    imageUrl: controlPublic,
    productName: 'BUV 小绿泥洁面',
    size: '1024x1536',
    persist: { runId: 'verify-detext', ownerId: 'probe' },
  });
  console.log('[verify] 2/4 去文字产物已发布:', detexted.imageUrl);
  console.log('  model:', detexted.model, '| promptVersion:', detexted.promptVersion);

  // 3/4 构造请求体并提交（与 P0 probe 相同的 body 结构）
  const prompt =
    '复刻参考视频的镜头与动作，BUV 小绿泥洁面 产品清晰可见。 Do NOT generate any text, subtitle, caption, watermark, or logo in the result.';
  const built = buildSeedanceGenerationBody(
    {
      prompt,
      model: process.env.SEEDANCE_MODEL || 'doubao-seedance-2-0-fast',
      duration: 5,
      resolution: '720p',
      aspectRatio: '9:16',
      materials: [{ url: detexted.imageUrl, kind: 'image', role: 'first_frame', label: 'product_control_image_detexted' }],
      generateAudio: false,
    },
    undefined
  );
  console.log('[verify] 3/4 提交 Seedance（materials[0].url = 去文字控制图）...');
  try {
    const result = await submitProbeTask(built.body as Record<string, any>, 'probe');
    console.log('[verify] 4/4 ✅ 提交成功（绕过风控）');
    console.log('  taskId:', result.task?.id);
    console.log('  status:', result.task?.status);
    console.log('  provider:', result.provider);
    console.log('  inferenceId:', result.task?.inferenceId);
    return 0;
  } catch (err: any) {
    console.log('[verify] 4/4 ❌ 提交仍被拒');
    console.log('  ', err?.message || String(err));
    return 2;
  }
}

main().then((code) => process.exit(code));
