/**
 * P0 capability probe 一键运行脚本。
 *
 *   npm run probe:viral            # 真实付费 probe（需 .env 配置 SEEDANCE + 发布路径）
 *   npm run probe:viral:fake       # 零成本确定性演练（PROBE_FAKE=true）
 *
 * 用法：
 *   tsx --import ./load-env.ts scripts/run-viral-probe.ts \
 *     --source <源视频路径> --range 25-50 --product-image <产品图> \
 *     --product-name "BUV 小绿泥洁面" --shot-structure "中景，博主手持产品展示" \
 *     --repeats 3 [--no-audio] [--fake]
 *
 * 默认源素材：app/uploads/materials/mat_1785761660278_l27efzmt.mp4（P3 已知合格
 * 产物回归对照素材），产品介绍段 25-50s；字幕预检不通过则拒绝提交并退出码 2。
 * 退出码：0 = 证据已产出；1 = 预检/运行错误；2 = 字幕预检未通过（拒绝提交）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { runViralProbe, FakeQualityScorer, LlmQualityScorer } from '../server/lib/viral-probe-runner';
import { YunwuAsrClient, FakeAsrClient } from '../server/lib/viral-audio-probe';
import type { SubtitleOverlayScorer } from '../server/lib/viral-subclip';
import { callLlmGateway } from '../server/lib/llm-gateway';
import { initDatabase } from '../server/lib/db';

/** 真实 LLM vision 字幕预检 scorer（允许人物；只查字幕/水印/竞品文字） */
class LlmSubtitleScorer implements SubtitleOverlayScorer {
  readonly name = 'llm-subtitle-preflight';
  async checkFrames(
    frameUrls: string[]
  ): Promise<{ ok: boolean; detected: string[]; reason: string }> {
    if (frameUrls.length === 0) {
      return { ok: false, detected: [], reason: '无帧可检' };
    }
    try {
      const res = await callLlmGateway({
        system:
          '你是视频素材文字层审查员。判断每张图片是否包含：烧录字幕（subtitle_overlay）、' +
          '水印/logo（watermark）、竞品品牌文字（competitor_branding）。' +
          '画面中的人物、动作、产品是允许保留的内容，不属于风险。' +
          '必须返回纯 JSON：{"verdicts":[{"kind":"subtitle_overlay|watermark|competitor_branding","present":true|false,"confidence":0.0-1.0}]}',
        user: '请评估这些参考视频帧中是否存在需要清除的文字层（字幕/水印/竞品文字）。',
        imageUrls: frameUrls,
        temperature: 0.1,
      });
      if (!res.success || !res.data) {
        return { ok: false, detected: [], reason: `字幕预检 LLM 不可用（${res.error || 'no data'}），不得放行未检素材` };
      }
      const verdicts = Array.isArray(res.data.verdicts) ? res.data.verdicts : [];
      const detected = verdicts
        .filter((v: any) => v?.present === true)
        .map((v: any) => String(v?.kind || 'unknown'));
      return { ok: detected.length === 0, detected, reason: detected.length > 0 ? `检出：${detected.join(', ')}` : '未检出文字层' };
    } catch (err: any) {
      return { ok: false, detected: [], reason: `字幕预检失败：${err?.message || String(err)}` };
    }
  }
}

/** 确定性 Fake 字幕预检（测试/演练）：始终放行 */
class FakeSubtitleScorer implements SubtitleOverlayScorer {
  readonly name = 'fake-subtitle-preflight';
  async checkFrames(_frameUrls: string[]): Promise<{ ok: boolean; detected: string[]; reason: string }> {
    return { ok: true, detected: [], reason: 'Fake 字幕预检放行（演练模式）' };
  }
}

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

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const fake = args.fake === 'true' || process.env.PROBE_FAKE === 'true';
  initDatabase();

  const defaultSource = path.resolve(process.cwd(), 'uploads', 'materials', 'mat_1785761660278_l27efzmt.mp4');
  const sourceVideoPath = path.resolve(args.source || defaultSource);
  if (!fs.existsSync(sourceVideoPath)) {
    console.error(`[probe] 源视频不存在: ${sourceVideoPath}`);
    return 1;
  }

  const range = (args.range || '25-50').split('-').map((v) => Number(v));
  if (range.length !== 2 || !range.every((v) => Number.isFinite(v)) || range[0] >= range[1]) {
    console.error('[probe] --range 格式错误（应为 start-end，如 25-50）');
    return 1;
  }

  const productAssetUrls = (args['product-image'] || '').split(',').filter(Boolean).map((p) => path.resolve(p));
  if (productAssetUrls.length === 0) {
    // 兜底：demo-assets 产品图
    const fallback = path.resolve(process.cwd(), '..', 'demo-assets', 'buv-cleanser-hero.png');
    if (fs.existsSync(fallback)) {
      productAssetUrls.push(fallback);
    }
  }
  if (productAssetUrls.length === 0) {
    console.error('[probe] 缺少产品图：--product-image <path>');
    return 1;
  }
  // 产品图统一放入 uploads/product-assets 并生成 /uploads 相对路径
  // （真实模式 callImageGenerationGateway 与策略出口只接受 /uploads / http(s) / data: 来源）
  const uploadsRoot = path.resolve(process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads'));
  const productAssetsDir = path.join(uploadsRoot, 'product-assets');
  fs.mkdirSync(productAssetsDir, { recursive: true });
  const normalizedProductAssets = productAssetUrls.map((p) => {
    if (p.startsWith('/uploads/')) return p;
    const target = path.join(productAssetsDir, path.basename(p));
    fs.copyFileSync(p, target);
    const rel = path.relative(uploadsRoot, target).split(path.sep).join('/');
    return `/uploads/${rel}`;
  });
  console.log(`  products=${normalizedProductAssets.join(', ')}`);

  const evidenceDir = path.resolve(args['evidence-dir'] || path.resolve(process.cwd(), '..', 'p0-evidence'));
  const repeats = Math.max(1, Math.min(5, Number(args.repeats || 3)));
  const runAudioGroups = args['no-audio'] !== 'true';
  // 字幕/水印无法物理清除时的显式实验开关（如 UGC 素材水印横跨画面中部）：
  // 默认严格阻断；--allow-text-layer 显式开启后 prompt 要求模型忽略文字层，
  // 污染率由 textContaminationRate 实测回答「prompt 指令能否压制文字层污染」
  const allowTextLayer = args['allow-text-layer'] === 'true' || process.env.PROBE_ALLOW_TEXT_LAYER === 'true';

  console.log('[probe] 开始 P0 capability probe');
  console.log(`  fake=${fake} source=${sourceVideoPath}`);
  console.log(`  range=${range.join('-')}s repeats=${repeats} audioGroups=${runAudioGroups}`);
  console.log(`  allowTextLayer=${allowTextLayer} products=${normalizedProductAssets.join(', ')}`);

  const subtitleScorer: SubtitleOverlayScorer = fake ? new FakeSubtitleScorer() : new LlmSubtitleScorer();
  const asrClient = fake ? new FakeAsrClient() : new YunwuAsrClient();
  const scorer = fake ? new FakeQualityScorer() : new LlmQualityScorer();

  try {
    const evidence = await runViralProbe({
      sourceVideoPath,
      rangeStartSec: range[0],
      rangeEndSec: range[1],
      productAssetUrls: normalizedProductAssets,
      productName: args['product-name'] || 'BUV 小绿泥洁面',
      shotStructure: args['shot-structure'] || '中景，博主手持绿色产品管展示',
      repeats,
      durationSec: Number(args.duration || 5),
      modelCode: args.model || process.env.SEEDANCE_MODEL || 'doubao-seedance-2-0-fast',
      scorer,
      subtitleScorer,
      asrClient,
      fake,
      evidenceDir,
      runAudioGroups,
      allowTextLayer,
    });

    const evidencePath = path.join(evidenceDir, `${evidence.runId}.json`);
    console.log(`\n[probe] 证据已写入: ${evidencePath}`);
    console.log(`[probe] 联合组: 动作保留率=${evidence.summary.motionRetentionRate?.toFixed(2) ?? 'n/a'} ` +
      `产品身份率=${evidence.summary.productIdentityRate?.toFixed(2) ?? 'n/a'} ` +
      `文字污染=${evidence.summary.textContaminationRate?.toFixed(2) ?? 'n/a'}`);
    console.log(`[probe] 音频: 音轨存在率=${evidence.summary.audioTrackPresentRate?.toFixed(2) ?? 'n/a'} ` +
      `口播语义匹配率=${evidence.summary.speechSemanticMatchRate?.toFixed(2) ?? 'n/a'} ` +
      `ASR可用=${evidence.summary.asrAvailable ?? 'n/a'}`);
    console.log('[probe] 路由判定:');
    console.log(`  native_reference_video: ${evidence.routeDecisions.nativeReferenceVideo.routable ? '✅ 可路由' : '❌ 不可路由'} — ${evidence.routeDecisions.nativeReferenceVideo.reason}`);
    console.log(`  native_speech: ${evidence.routeDecisions.nativeSpeech.routable ? '✅ 可路由' : '❌ 不可路由'} — ${evidence.routeDecisions.nativeSpeech.reason}`);
    console.log(`  silent_fallback: ${evidence.routeDecisions.silentFallback.routable ? '✅ 可路由' : '❌ 不可路由'}`);
    return 0;
  } catch (err: any) {
    console.error(`[probe] 运行失败: ${err?.message || String(err)}`);
    if (err?.code === 'subtitle_preflight_failed') return 2;
    return 1;
  }
}

main().then((code) => process.exit(code));
