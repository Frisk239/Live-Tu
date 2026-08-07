/**
 * P0 风控验证 2：纯生成虚构人物控制图 → 提交
 *
 * 假设：风控检测「画面是否源于已知 UGC 内容」（近似重复检测）。
 * 验证：不用 UGC 帧做参考，仅用产品图 + 文本描述（中景、持产品展示、虚构女性人物），
 *       由 gpt-image 凭空生成控制图 → 提交 Seedance。
 * 200 = 假设成立，P0 控制图路径改为「语义生成虚构人物」；422 = 假设不成立。
 */
import { callImageGenerationGateway } from '../server/lib/llm-gateway';
import { submitProbeTask } from '../server/lib/video-submission-port';
import { initDatabase, db } from '../server/lib/db';
import { buildSeedanceGenerationBody } from '../server/routes/seedance';
import { publishLocalAsset } from '../server/lib/asset-publisher';
import fs from 'node:fs';
import path from 'node:path';
import { cacheConditionedFrameToLocal } from '../server/lib/product-conditioned-frame';

async function main(): Promise<number> {
  initDatabase();
  // probe 任务归属登记需要 users 外键存在（与测试 authStub 同模式）
  try {
    db.prepare(
      `INSERT OR IGNORE INTO users (id, username, password_hash, role, enabled)
       VALUES ('probe', 'probe', 'not-used', 'operator', 1)`
    ).run();
  } catch {}
  const productUrl = 'http://64.83.1.104/live-tu-assets/derived/1786067060787_d3664092.png'; // BUV 产品图（无人物，已验证可过）

  console.log('[verify2] 1/4 纯生成虚构人物控制图（无任何 UGC 参考帧）...');
  const gatewayRes = await callImageGenerationGateway({
    prompt:
      '一名虚构的年轻女性博主，中景构图，右手举起浅绿色洗面奶软管向镜头展示，面带微笑，' +
      '暖色室内背景，自然光。画面中所有人物均为虚构数字形象，与任何真实人物无关。' +
      '产品包装与参考产品图一致：浅绿色软管。画面无任何文字、字幕、水印、logo。9:16 竖屏商业摄影。',
    size: '1024x1536',
    referenceImages: [{ url: productUrl }], // 仅产品图做包装参考；不传任何 UGC 帧
  });
  if (!gatewayRes.success || !gatewayRes.imageUrl) {
    console.error('[verify2] 控制图生成失败:', gatewayRes.error);
    return 1;
  }
  console.log('[verify2] 2/4 控制图生成成功:', gatewayRes.modelUsed);

  const localPath = cacheConditionedFrameToLocal(gatewayRes.imageUrl);
  const published = await publishLocalAsset(localPath);
  console.log('[verify2] 3/4 已发布:', published.publicUrl);

  const prompt =
    '复刻参考视频的镜头与动作，BUV 小绿泥洁面 产品清晰可见。 Do NOT generate any text, subtitle, caption, watermark, or logo in the result.';
  const built = buildSeedanceGenerationBody(
    {
      prompt,
      model: process.env.SEEDANCE_MODEL || 'doubao-seedance-2-0-fast',
      duration: 5,
      resolution: '720p',
      aspectRatio: '9:16',
      materials: [{ url: published.publicUrl, kind: 'image', role: 'first_frame', label: 'virtual_person_control' }],
      generateAudio: false,
    },
    undefined
  );
  console.log('[verify2] 4/4 提交 Seedance...');
  try {
    const result = await submitProbeTask(built.body as Record<string, any>, 'probe');
    console.log('[verify2] ✅ 提交成功（绕过风控）：taskId=' + result.task?.id, 'status=' + result.task?.status, 'provider=' + result.provider);
    return 0;
  } catch (err: any) {
    console.log('[verify2] ❌ 提交仍被拒:', err?.message || String(err));
    return 2;
  }
}

main().then((code) => process.exit(code));
