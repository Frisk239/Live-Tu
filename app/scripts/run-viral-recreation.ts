/**
 * P0 完整成片脚本（v1）：虚构人物带货成片
 *
 * 已验证能力（真实 probe 结论）：
 * - UGC 帧素材被中转风控拦截（copyright restrictions）→ 不用 UGC 帧；
 * - 纯生成虚构人物控制图（无 UGC 参考帧）→ ✅ 提交成功并产出视频。
 *
 * 本脚本按 6 个语义镜头（hook→problem→product_intro→demo→proof→cta）：
 *   1. 每镜用「虚构人物 + 镜头语义 + 产品」prompt 生成控制图（gpt-image 纯生成，
 *      产品图仅作包装参考，不引用任何 UGC 帧）；
 *   2. 每镜提交 Seedance（materials = [控制图 first_frame]）→ 轮询 → 下载；
 *   3. ffmpeg 拼接成 9:16 成片（复用 runFfmpegRender 的 concat 能力）；
 *   4. 证据 JSON 落盘 p0-evidence/。
 *
 * 用法：npx tsx --import ./load-env.ts scripts/run-viral-recreation.ts [--shots=6] [--duration=5]
 */
import fs from 'node:fs';
import path from 'node:path';
import { callImageGenerationGateway } from '../server/lib/llm-gateway';
import { submitProbeTask } from '../server/lib/video-submission-port';
import { initDatabase, db } from '../server/lib/db';
import { buildSeedanceGenerationBody, getSeedanceVideo } from '../server/routes/seedance';
import { publishLocalAsset } from '../server/lib/asset-publisher';
import { cacheConditionedFrameToLocal } from '../server/lib/product-conditioned-frame';
import { runFfmpegRender } from '../server/routes/render';

const PRODUCT_URL = 'http://64.83.1.104/live-tu-assets/derived/1786067060787_d3664092.png'; // BUV 产品图（已验证可过风控）
const PRODUCT_NAME = 'BUV 小绿泥洁面';

/** 6 镜叙事蓝图：每镜 = 虚构人物带货镜头语义（不引用任何 UGC 帧/人物形象） */
const SHOT_BLUEPRINTS: Array<{
  beat: string;
  structure: string;
  prompt: string;
}> = [
  {
    beat: 'hook',
    structure: '近景：虚构年轻女性博主手持浅绿色洗面奶软管，对镜头展示，表情惊喜',
    prompt:
      '一名虚构的年轻女性博主，近景，右手举起浅绿色洗面奶软管向镜头展示，表情惊喜，' +
      '暖色室内背景虚化，自然光。人物为虚构数字形象，与任何真实人物无关。' +
      '产品包装与参考产品图一致：浅绿色软管。画面无任何文字、字幕、水印、logo。9:16 竖屏商业摄影。',
  },
  {
    beat: 'problem',
    structure: '特写：虚构女性手指轻触脸颊，表现出皮肤困扰的表情，产品在画面边缘可见',
    prompt:
      '一名虚构的年轻女性博主，特写，指尖轻触脸颊表现皮肤困扰，眉头微蹙，' +
      '画面边缘可见浅绿色洗面奶软管。人物为虚构数字形象。' +
      '产品包装与参考产品图一致。画面无任何文字、字幕、水印、logo。9:16 竖屏商业摄影。',
  },
  {
    beat: 'product_intro',
    structure: '中景：虚构女性双手举起产品软管展示包装，微笑介绍',
    prompt:
      '一名虚构的年轻女性博主，中景，双手举起浅绿色洗面奶软管展示包装，微笑面对镜头，' +
      '暖色室内背景。人物为虚构数字形象。' +
      '产品包装与参考产品图一致：浅绿色软管。画面无任何文字、字幕、水印、logo。9:16 竖屏商业摄影。',
  },
  {
    beat: 'demo',
    structure: '中近景：虚构女性挤压软管，挤出绿色洁面泥于掌心',
    prompt:
      '一名虚构的年轻女性博主，中近景，挤压浅绿色洗面奶软管，挤出绿色洁面泥于掌心，' +
      '动作自然，暖色室内光。人物为虚构数字形象。' +
      '产品包装与参考产品图一致。画面无任何文字、字幕、水印、logo。9:16 竖屏商业摄影。',
  },
  {
    beat: 'proof',
    structure: '特写：虚构女性将洁面泥涂抹于脸颊，表情满意，产品在画面中',
    prompt:
      '一名虚构的年轻女性博主，特写，将绿色洁面泥涂抹于脸颊，表情满意放松，' +
      '浅绿色软管在画面一侧可见。人物为虚构数字形象。' +
      '产品包装与参考产品图一致。画面无任何文字、字幕、水印、logo。9:16 竖屏商业摄影。',
  },
  {
    beat: 'cta',
    structure: '中景：虚构女性手持产品对镜头微笑，做推荐收尾姿态',
    prompt:
      '一名虚构的年轻女性博主，中景，手持浅绿色洗面奶软管对镜头微笑推荐，' +
      '干净背景，明亮光线。人物为虚构数字形象。' +
      '产品包装与参考产品图一致：浅绿色软管。画面无任何文字、字幕、水印、logo。9:16 竖屏商业摄影。',
  },
];

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const eq = key.indexOf('=');
      if (eq >= 0) {
        out[key.slice(0, eq)] = key.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          out[key] = next;
          i++;
        } else {
          out[key] = 'true';
        }
      }
    }
  }
  return out;
}

/** 证据持久化（每镜完成后调用，防中断丢失） */
function persistEvidence(
  runId: string,
  evidenceDir: string,
  productName: string,
  productUrl: string,
  shotCount: number,
  durationSec: number,
  shots: Array<Record<string, unknown>>,
  finalMp4: string | null
): void {
  const evidence = {
    runId,
    updatedAt: new Date().toISOString(),
    productName,
    productUrl,
    shotCount,
    durationSec,
    path: '纯生成虚构人物控制图（无 UGC 帧，规避风控）',
    shots,
    finalMp4,
    finalMp4AbsolutePath: finalMp4 ? path.resolve(process.cwd(), 'uploads', 'renders', path.basename(finalMp4)) : null,
  };
  fs.writeFileSync(path.join(evidenceDir, `${runId}.json`), JSON.stringify(evidence, null, 2));
}

/** 轮询任务直到完成 */
async function pollTask(taskId: string, timeoutMs = 12 * 60_000): Promise<{ status: string; url: string | null }> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const raw = await getSeedanceVideo(taskId).catch(() => null);
    if (raw) {
      const data = raw?.data || raw || {};
      const status = String(data.status || '').toLowerCase();
      const url = data.url || data.content?.video_url || data.video_url || null;
      // 实测中转响应可能不含 status 字段，但 url 存在即任务成功
      if (url) return { status: status || 'success', url };
      if (status === 'success' || status === 'completed') return { status, url };
      if (status === 'failed' || status === 'error') return { status, url };
    }
    await new Promise((r) => setTimeout(r, 15_000));
  }
  return { status: 'timeout', url: null };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const shotCount = Math.max(4, Math.min(8, Number(args.shots || 6)));
  const durationSec = Math.max(4, Math.min(15, Number(args.duration || 5)));
  const resumeRunId = args.resume || '';
  const runId = resumeRunId || `recreation-${Date.now()}`;
  const evidenceDir = path.resolve(process.cwd(), '..', 'p0-evidence');
  fs.mkdirSync(evidenceDir, { recursive: true });

  // resume 模式：读取已有证据，跳过已提交镜头，只轮询未完成任务
  let shots: Array<{
    beat: string;
    controlImageUrl: string;
    taskId: string | null;
    status: string;
    videoUrl: string | null;
    localPath: string | null;
    error: string | null;
  }> = [];
  let submittedCount = 0;
  if (resumeRunId) {
    const existingPath = path.join(evidenceDir, `${resumeRunId}.json`);
    if (fs.existsSync(existingPath)) {
      const existing = JSON.parse(fs.readFileSync(existingPath, 'utf8'));
      shots = existing.shots || [];
      submittedCount = shots.filter((s) => s.taskId).length;
      console.log(`[recreation] resume ${resumeRunId}：已有 ${shots.length} 镜记录，${submittedCount} 镜已提交`);
    } else {
      console.error(`[recreation] resume 失败：证据文件不存在 ${existingPath}`);
      return 1;
    }
  }

  initDatabase();
  try {
    db.prepare(
      `INSERT OR IGNORE INTO users (id, username, password_hash, role, enabled)
       VALUES ('probe', 'probe', 'not-used', 'operator', 1)`
    ).run();
  } catch {}

  const blueprints = SHOT_BLUEPRINTS.slice(0, shotCount);

  if (!resumeRunId) {
    console.log(`[recreation] 开始完整成片（${shotCount} 镜 × ${durationSec}s，虚构人物路径）`);
  }

  for (let i = 0; i < blueprints.length; i++) {
    // resume 模式：跳过已记录镜头（已提交或已失败）
    if (resumeRunId && i < shots.length) continue;
    const bp = blueprints[i];
    console.log(`\n[recreation] === 镜 ${i + 1}/${blueprints.length}（${bp.beat}）===`);
    try {
      // 1) 纯生成虚构人物控制图（仅产品图参考，无 UGC 帧）
      console.log(`  1/3 生成控制图（虚构人物 + ${bp.beat} 镜头语义）...`);
      const imgRes = await callImageGenerationGateway({
        prompt: bp.prompt,
        size: '1024x1536',
        referenceImages: [{ url: PRODUCT_URL }],
      });
      if (!imgRes.success || !imgRes.imageUrl) {
        throw new Error(`控制图生成失败：${imgRes.error || 'no image'}`);
      }
      const localPath = cacheConditionedFrameToLocal(imgRes.imageUrl);
      const published = await publishLocalAsset(localPath);
      console.log(`  2/3 控制图已发布: ${published.publicUrl}`);

      // 2) 提交 Seedance（materials = [控制图 first_frame]，generateAudio=true 试音画）
      const prompt =
        `${bp.prompt} 视频需复刻该镜头的动作与镜头语言，产品清晰可见，` +
        'Do NOT generate any text, subtitle, caption, watermark, or logo in the result.';
      const built = buildSeedanceGenerationBody(
        {
          prompt,
          model: process.env.SEEDANCE_MODEL || 'doubao-seedance-2-0-fast',
          duration: durationSec,
          resolution: '720p',
          aspectRatio: '9:16',
          materials: [{ url: published.publicUrl, kind: 'image', role: 'first_frame', label: `control_${bp.beat}` }],
          generateAudio: true,
        },
        undefined
      );
      const result = await submitProbeTask(built.body as Record<string, any>, 'probe');
      console.log(`  3/3 已提交 taskId=${result.task?.id} status=${result.task?.status}`);
      shots.push({
        beat: bp.beat,
        controlImageUrl: published.publicUrl,
        taskId: result.task?.id ?? null,
        status: String(result.task?.status || 'generating'),
        videoUrl: result.task?.url ?? null,
        localPath: null,
        error: null,
      });
      // 每镜提交成功即持久化（防后续轮询中断丢失已提交任务）
      persistEvidence(runId, evidenceDir, PRODUCT_NAME, PRODUCT_URL, shotCount, durationSec, shots as Array<Record<string, unknown>>, null);
    } catch (err: any) {
      console.error(`  ❌ 镜 ${i + 1} 失败:`, err?.message || String(err));
      shots.push({
        beat: bp.beat,
        controlImageUrl: '',
        taskId: null,
        status: 'failed',
        videoUrl: null,
        localPath: null,
        error: err?.message || String(err),
      });
    }
  }

  // 轮询所有已提交任务（跳过已完成/已下载的）
  console.log('\n[recreation] 轮询全部任务...');
  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i];
    if (!shot.taskId) continue;
    if (shot.localPath && fs.existsSync(shot.localPath)) {
      console.log(`  镜 ${i + 1}（${shot.beat}）已有本地产物，跳过`);
      continue;
    }
    const polled = await pollTask(shot.taskId);
    shot.status = polled.status;
    shot.videoUrl = polled.url;
    // 每镜完成即持久化证据（防中断丢失）
    persistEvidence(runId, evidenceDir, PRODUCT_NAME, PRODUCT_URL, shotCount, durationSec, shots, null);
    if (polled.url) {
      // 下载到本地供拼接
      try {
        const res = await fetch(polled.url, { signal: AbortSignal.timeout(180_000) });
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          const outPath = path.resolve(process.cwd(), 'uploads', 'renders', `recreation_${runId}_shot${i + 1}_${shot.beat}.mp4`);
          fs.writeFileSync(outPath, buf);
          shot.localPath = outPath;
          console.log(`  镜 ${i + 1}（${shot.beat}）✅ ${shot.status} → ${outPath}`);
        } else {
          shot.error = `下载失败 HTTP ${res.status}`;
          console.log(`  镜 ${i + 1}（${shot.beat}）下载失败 HTTP ${res.status}`);
        }
      } catch (err: any) {
        shot.error = `下载异常: ${err?.message || String(err)}`;
        console.log(`  镜 ${i + 1}（${shot.beat}）下载异常: ${err?.message || String(err)}`);
      }
    } else {
      console.log(`  镜 ${i + 1}（${shot.beat}）status=${shot.status}（无视频 URL）`);
    }
  }

  // 拼接（仅成功且有本地文件的镜头）
  const readyShots = shots.filter((s) => s.localPath && fs.existsSync(s.localPath));
  let finalMp4: string | null = null;
  if (readyShots.length >= 2) {
    console.log(`\n[recreation] 拼接 ${readyShots.length} 个镜头...`);
    try {
      const renderResult = await runFfmpegRender({
        videoSourceUrls: readyShots.map((s) => s.localPath!),
        outputFilename: `recreation_final_${runId}.mp4`,
        aspectRatio: '9:16',
      });
      if (!renderResult.success) {
        throw new Error(renderResult.error || '拼接失败');
      }
      finalMp4 = renderResult.data?.videoUrl || null;
      console.log(`✅ 成片已生成: ${finalMp4}`);
    } catch (err: any) {
      console.error('❌ 拼接失败:', err?.message || String(err));
    }
  } else {
    console.log('\n[recreation] 成功镜头不足 2 个，跳过拼接');
  }

  // 证据落盘
  persistEvidence(runId, evidenceDir, PRODUCT_NAME, PRODUCT_URL, shotCount, durationSec, shots as Array<Record<string, unknown>>, finalMp4);
  const evidencePath = path.join(evidenceDir, `${runId}.json`);
  console.log(`\n[recreation] 证据: ${evidencePath}`);
  const absFinal = finalMp4 ? path.resolve(process.cwd(), 'uploads', 'renders', path.basename(finalMp4)) : null;
  console.log(`[recreation] 成片绝对路径: ${absFinal || '无'}`);

  return finalMp4 ? 0 : 1;
}

main().then((code) => process.exit(code));
