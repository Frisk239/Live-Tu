#!/usr/bin/env node
/**
 * S3 真实 Demo 闭环运行器：「爆款视频 + 产品图片 → 复刻成片」（真实 provider）
 *
 * 主链路（用户只输入 referenceVideoUrl + productAssetUrls）：
 *   1. Manifest 启动前校验（大小 + SHA-256，素材被替换即拒绝运行）；
 *   2. 系统自动下载爆款视频 → ffmpeg 场景检测自动拆镜 → 按叙事价值选段
 *      （覆盖开头/中段/结尾，不再按镜头时长挑选）→ 每镜提取参考关键帧；
 *   3. 参考关键帧发布为公网 URL（共享 asset-publication port：自建中继 /
 *      PUBLIC_BASE_URL 部署域名；imgur/litterbox 仅显式 DEMO_ASSET_PUBLISHER 开启）；
 *   4. 每镜生成独立的产品条件化首帧（参考关键帧构图 + 产品图包装 → 云雾 /images/edits 多图编辑）；
 *   5. 首帧预检（产品出现/包装一致/构图一致/竞品残留/公网可达），不通过自动重生成（最多 2 次）；
 *   6. 预检通过后才提交 Seedance（首帧 role=first_frame + 参考关键帧 role=reference_image）；
 *   7. 逐镜 QA（LLM vision，受限并发 2）→ 失败只返修该镜（最多 2 轮，并行）；
 *   8. 最终质量门禁（fail/unverified 未人工确认禁止合成）→ concat → step5 → 最终 MP4 下载；
 *   9. 成片序列语义门禁（真实 LLM wiring，经共享适配器；LLM 不可用 → 如实 unverified）；
 *   10. 证据 JSON（完整输入/派生资产/provider/耗时/费用/QA 判决）+ golden_runs 落库。
 *
 * 用法：node scripts/run-p3-demo.mjs [--port=3011] [--shots=2|6|7|8] [--segments=53.5-54.9,60.95-62.75] [--skip-manifest-check]
 * 前置：.env 已配置 YUNWU_API_KEY / SEEDANCE_BASE_URL / SEEDANCE_ACCOUNT / SEEDANCE_PASSWORD，
 *       资产发布须有正式路径（PUBLIC_BASE_URL 公网域名，或 DEMO_PUBLIC_UPLOAD_URL 自建中继），
 *       或显式开启 DEMO_ASSET_PUBLISHER=imgur|litterbox（test/demo 通道，默认关闭）。
 * 注意：本脚本发起真实付费调用（图像 edits + Seedance 视频 + LLM），数量受控。
 */
import { spawn, execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const args = process.argv.slice(2);
const portArg = args.find((a) => a.startsWith('--port='));
const shotsArg = args.find((a) => a.startsWith('--shots='));
const segmentsArg = args.find((a) => a.startsWith('--segments='));
const skipManifest = args.includes('--skip-manifest-check');
const FULL_VIDEO = args.includes('--full-video');
const PORT = portArg ? portArg.split('=')[1] : '3011';
const requestedShotCount = Number(shotsArg?.split('=')[1] || (FULL_VIDEO ? 6 : 2));
const SHOT_COUNT = FULL_VIDEO
  ? Math.max(6, Math.min(8, requestedShotCount || 6))
  : Math.max(2, Math.min(4, requestedShotCount || 2));
const BASE = `https://127.0.0.1:${PORT}`;

/**
 * 人工审核镜头段覆盖。格式：--segments=53.5-54.9,60.95-62.75
 *
 * 仅用于 demo 的素材选择，不是业务侧的硬编码；未传时仍走场景检测和自动挑选。
 * 这让审核过的无人脸/无版权风险镜头可以被可重复地用于真实 provider 验证。
 */
function parseSegmentOverrides(raw, durationSec) {
  if (!raw) return null;
  const entries = raw.split(',').map((value) => value.trim()).filter(Boolean);
  if (entries.length === 0) throw new Error('--segments 不能为空');
  if (entries.length !== SHOT_COUNT) {
    throw new Error(`--segments 数量（${entries.length}）必须与 --shots（${SHOT_COUNT}）一致`);
  }

  const segments = entries.map((entry) => {
    const match = /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(entry);
    if (!match) throw new Error(`无效的镜头段 "${entry}"，格式应为 起始秒-结束秒`);
    const startSec = Number(match[1]);
    const endSec = Number(match[2]);
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec) || startSec < 0 || endSec <= startSec) {
      throw new Error(`无效的镜头段 "${entry}"`);
    }
    if (endSec > durationSec) {
      throw new Error(`镜头段 "${entry}" 超出参考视频时长 ${durationSec.toFixed(2)}s`);
    }
    if (endSec - startSec < 0.5) {
      throw new Error(`镜头段 "${entry}" 过短，至少需要 0.5 秒`);
    }
    return { startSec, endSec };
  });

  return segments.sort((a, b) => a.startSec - b.startSec);
}

// ==================== 真实样例（确定性 fixture，非业务硬编码） ====================
const { REAL_DEMO_SAMPLE, verifyRealDemoManifest, verifyRealAsset } = await import(
  '../shared/real-demo-sample.ts'
);
const { createFullVideoPlan, validateFullVideoPlan } = await import(
  '../server/lib/full-video-plan.ts'
);
const { buildSequenceFrameTargets, runDeterministicStructureChecks, runSequenceSemanticGate } = await import(
  '../server/lib/sequence-semantic-gate.ts'
);
// 剪辑点定向返修：gate 定位 seam → 只重生成接收镜（前一镜结束边界帧为锚点）
const { resolveSeamRepairTargets } = await import('../server/lib/seam-repair.ts');
// P5：序列门禁与语义理解的「真实 LLM」wiring 全部经共享适配器，CLI 不再自行拼装 provider 调用
const { createSequenceGateLlm } = await import('../server/adapters/sequence-gate-llm.ts');
const { LlmSourceSemanticAnalyzer } = await import('../server/adapters/source-semantic-analyzer.ts');
// P5：叙事选段（开头/中段/结尾按叙事价值）经共享领域模块
const { selectNarrativeSegments, sceneSegments } = await import(
  '../server/domain/reference-analysis/reference-analysis.ts'
);
// P5：资产公网发布经共享 port/adapter（与服务器同一实现，不再各自复制上传逻辑）
const { publishLocalAsset } = await import('../server/lib/asset-publisher.ts');
const sample = REAL_DEMO_SAMPLE;

// ==================== 证据目录 ====================
const demoRoot = path.join(root, 'p3-evidence');
const certDir = path.join(demoRoot, 'certs');
const dataDir = path.join(demoRoot, 'data-s3');
const artifactDir = path.join(demoRoot, 'artifacts');
mkdirSync(certDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(artifactDir, { recursive: true });

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const evidence = {
  sampleId: sample.sampleId,
  sampleName: sample.sampleName,
  startedAt: new Date().toISOString(),
  baseUrl: BASE,
  inputs: {
    referenceVideoUrl: sample.referenceVideoUrl,
    productAssetUrls: sample.productAssetUrls,
    productName: sample.productName,
  },
  providers: {
    imageConditioning: null, // 真实探测/声明结果
    video: 'seedance-relay (real)',
    qa: 'llm-vision-semantic-qa (real)',
  },
  manifestCheck: null,
  derivedAssets: { keyframes: [], firstFrames: [], published: [] },
  shots: [],
  qaRounds: [],
  costLedger: [],
  finalMp4: null,
  compositeGate: null,
  restartRecovery: null,
  errors: [],
  steps: [],
  fullVideoPlan: null,
  sourceSemanticAnalysis: null,
  semanticStoryboard: null,
  sequenceGate: null,
  contactSheets: { shots: null, final: null, seams: null, seamTargets: [] },
};

function log(step, msg) {
  const line = `[${new Date().toISOString()}] ${step}: ${msg}`;
  console.log(line);
  evidence.steps.push({ at: new Date().toISOString(), step, msg });
}

let cookie = '';
let server = null;
let serverLog = '';

/** One non-paid vision pass that explains the source video's narrative logic. */
async function analyzeSourceSemantics(kfPublished, segments) {
  const analyzer = new LlmSourceSemanticAnalyzer();
  return analyzer.analyzeSource({
    productName: sample.productName,
    segments,
    keyframeUrls: kfPublished.map((item) => item.publicUrl),
    modelId: 'Gemini 3.6 Flash',
  });
}
// 注：main() 的 full-video 流程已改为「候选帧 → analyzeRaw → 按叙事价值选段 →
// 最终关键帧」；analyzeSourceSemantics 保留供人工复核/其他入口使用。


async function api(method, route, body) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30 * 60 * 1000),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok && res.status !== 409) {
    throw new Error(`${method} ${route} → ${res.status}: ${JSON.stringify(json).slice(0, 400)}`);
  }
  return { status: res.status, json };
}

async function startServer(extraEnv = {}) {
  if (!existsSync(path.join(certDir, 'cert.pem'))) {
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout ${path.join(certDir, 'key.pem')} ` +
        `-out ${path.join(certDir, 'cert.pem')} -days 30 -nodes ` +
        `-subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1,DNS:localhost"`,
      { stdio: 'ignore' }
    );
    log('server', '自签名证书已生成');
  }
  server = spawn('npx', ['tsx', '--import', './load-env.ts', 'server.ts'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      ...extraEnv,
      PORT,
      DATA_DIR: dataDir,
      HTTPS_CERT: path.join(certDir, 'cert.pem'),
      HTTPS_KEY: path.join(certDir, 'key.pem'),
      FAKE_VIDEO_PROVIDER: 'false',
      FAKE_TECH_QA: 'false',
      SEMANTIC_QA_SCORER: 'llm',
      ALLOW_MOCK_FALLBACK: 'false',
      PIPELINE_WORKER_DISABLED: 'true',
      // 中转创建任务需等待虚拟素材注册（多素材更慢），放宽提交超时
      SEEDANCE_FETCH_TIMEOUT_MS: '180000',
      // 派生首帧/参考关键帧需要公网 URL。P5 起不再默认/自动回退第三方图床：
      // 正式路径 = 自建中继（DEMO_PUBLIC_UPLOAD_URL）或 PUBLIC_BASE_URL 部署域名；
      // test/demo 通道需显式设置 DEMO_ASSET_PUBLISHER=imgur|litterbox，否则
      // 发布失败将如实抛出 asset_publication_unavailable（不发起付费生成）。
    },
  });
  serverLog = '';
  server.stdout.on('data', (c) => (serverLog += c));
  server.stderr.on('data', (c) => (serverLog += c));
  server.on('exit', (code) => {
    writeFileSync(path.join(demoRoot, 'server-s3.log'), serverLog.slice(-20000));
  });
  for (let i = 0; i < 90; i++) {
    if (server.exitCode !== null) {
      console.error('服务器启动失败:\n' + serverLog.slice(-3000));
      process.exit(1);
    }
    try {
      const res = await fetch(`${BASE}/api/live`);
      if (res.ok) {
        log('server', 'HTTPS 服务器就绪');
        return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.error('服务器启动超时:\n' + serverLog.slice(-3000));
  process.exit(1);
}

async function stopServer() {
  if (server) {
    const pid = server.pid;
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
      } else {
        server.kill('SIGKILL');
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
    server = null;
  }
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(`${BASE}/api/live`);
      if (!res.ok) return;
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

// ==================== 受限并发（demo 侧；与服务端 mapWithConcurrency 同语义） ====================
async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i], i) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

// ==================== 视频处理：自动下载 + 场景检测拆镜 + 参考关键帧 ====================

/** 下载爆款视频到本地，返回本地路径 */
async function downloadViralVideo() {
  const videoPath = path.join(root, 'uploads', 'materials', 's3-viral-reference.mp4');
  if (existsSync(videoPath)) {
    log('video', `爆款视频已存在本地: ${videoPath}`);
    return videoPath;
  }
  log('video', `下载爆款视频（${sample.referenceVideoUrl}）…`);
  const res = await fetch(sample.referenceVideoUrl, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`爆款视频下载失败 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(videoPath, buf);
  log('video', `爆款视频已下载: ${(buf.length / 1024 / 1024).toFixed(1)}MB`);
  return videoPath;
}

/** ffmpeg 场景检测：返回场景变化时间点（秒） */
function detectSceneChanges(videoPath) {
  const out = execSync(
    `ffmpeg -v info -i "${videoPath}" -vf "select='gt(scene,0.28)',showinfo" -f null - 2>&1`,
    { encoding: 'utf8', timeout: 180_000, maxBuffer: 64 * 1024 * 1024 }
  );
  const times = [];
  for (const m of out.matchAll(/pts_time:([\d.]+)/g)) {
    const t = parseFloat(m[1]);
    if (Number.isFinite(t)) times.push(t);
  }
  return times.sort((a, b) => a - b);
}

/** 场景切分 → 镜头段（非 full-video 演示：简单场景切分 + 均匀兜底，按 SHOT_COUNT） */
function buildLegacyShotSegments(sceneChanges, durationSec, overrides = null) {
  if (overrides) {
    return overrides.map((seg, i) => ({
      ...seg,
      structure:
        i === 0
          ? '人工审核的无人脸产品动作镜头（保留产品动作、景别与节奏，不复刻原人物身份、字幕或水印）'
          : '人工审核的无人脸产品特写镜头（保留产品展示构图，不复刻原人物身份、字幕或水印）',
    }));
  }
  const bounds = [0, ...sceneChanges, durationSec];
  const segments = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i];
    const end = bounds[i + 1];
    if (end - start < 2.0) continue; // 过滤过短片段
    segments.push({ startSec: start, endSec: end });
  }
  if (segments.length < SHOT_COUNT) {
    // 场景检测段不足：均匀切分兜底
    segments.length = 0;
    for (let i = 0; i < SHOT_COUNT; i++) {
      segments.push({
        startSec: (durationSec / SHOT_COUNT) * i,
        endSec: (durationSec / SHOT_COUNT) * (i + 1),
      });
    }
  }
  const picked = segments.slice(0, SHOT_COUNT).sort((a, b) => a.startSec - b.startSec);
  return picked.map((seg, i) => ({
    ...seg,
    structure: `镜${i + 1}：${seg.endSec - seg.startSec >= 5 ? '中景' : '近景'}产品展示段（保留参考视频的主体位置与运镜意图）`,
  }));
}

/**
 * 候选段（P5 建议 3 + 二轮坐标贯穿）：场景切点全部段按 开头/中段/结尾 三区均摊
 * 取上限，每段带真实秒数与 candidateId（= LLM prompt 的候选序号，1-based），
 * 作为「语义分析前」的候选关键帧来源；分析后按叙事价值再选最终段。
 */
function buildCandidateSegments(sceneChanges, durationSec, limit = 12) {
  const all = sceneSegments(sceneChanges, durationSec);
  const third = durationSec / 3;
  const zones = [[], [], []];
  for (const seg of all) {
    const mid = (seg.startSec + seg.endSec) / 2;
    zones[mid < third ? 0 : mid < 2 * third ? 1 : 2].push(seg);
  }
  const perZone = Math.ceil(limit / 3);
  const picked = [];
  for (const zone of zones) picked.push(...zone.slice(0, perZone));
  if (picked.length < 6) {
    for (let i = 0; i < limit; i++) {
      picked.push({ startSec: (durationSec / limit) * i, endSec: (durationSec / limit) * (i + 1) });
    }
  }
  return picked
    .sort((a, b) => a.startSec - b.startSec)
    .slice(0, limit)
    .map((seg, index) => ({
      ...seg,
      candidateId: `cand-${index + 1}`,
      structure: `候选帧 ${index + 1}（${seg.startSec.toFixed(2)}-${seg.endSec.toFixed(2)}s）`,
    }));
}

/** 本地绝对路径 → /uploads 相对 URL（llm-gateway 会把 uploads 内文件转 base64，无需公网发布） */
function toUploadsUrl(localPath) {
  const rel = path.relative(path.join(root, 'uploads'), localPath).split(path.sep).join('/');
  return `/uploads/${rel}`;
}

/** 提取每镜参考关键帧（段中点），返回本地路径列表 */
function extractReferenceKeyframes(videoPath, segments, kfDir) {
  mkdirSync(kfDir, { recursive: true });
  const paths = [];
  for (let i = 0; i < segments.length; i++) {
    const t = (segments[i].startSec + segments[i].endSec) / 2;
    const out = path.join(kfDir, `shot${i + 1}_kf_${t.toFixed(1)}s.jpg`);
    execSync(
      `ffmpeg -y -v error -ss ${t.toFixed(2)} -i "${videoPath}" -frames:v 1 -q:v 2 "${out}"`,
      { stdio: 'ignore', timeout: 60_000 }
    );
    if (existsSync(out)) paths.push(out);
  }
  return paths;
}

/**
 * Build one early/middle/late contact strip for each source candidate.  This
 * stays inside the local /uploads LLM-analysis boundary: source pixels never
 * become provider reference material.  A midpoint-only frame can identify a
 * scene, but it cannot tell the planner whether the source performed a reveal,
 * a wipe, a result change, or a motion match-cut.
 */
function extractCandidateEvidenceStrips(videoPath, segments, stripDir) {
  mkdirSync(stripDir, { recursive: true });
  const paths = [];
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const length = segment.endSec - segment.startSec;
    const inset = Math.min(0.45, Math.max(0.08, length / 8));
    const early = segment.startSec + inset;
    const middle = (segment.startSec + segment.endSec) / 2;
    const late = segment.endSec - inset;
    const out = path.join(stripDir, `candidate${i + 1}_${early.toFixed(1)}-${middle.toFixed(1)}-${late.toFixed(1)}.jpg`);
    try {
      execSync(
        `ffmpeg -y -v error -ss ${early.toFixed(3)} -i "${videoPath}" -ss ${middle.toFixed(3)} -i "${videoPath}" -ss ${late.toFixed(3)} -i "${videoPath}" -filter_complex "[0:v]scale=320:-2,setsar=1[a];[1:v]scale=320:-2,setsar=1[b];[2:v]scale=320:-2,setsar=1[c];[a][b][c]hstack=inputs=3" -frames:v 1 -q:v 2 "${out}"`,
        { stdio: 'ignore', timeout: 60_000 }
      );
      if (existsSync(out)) paths.push(out);
    } catch {
      // Keep the analysis honest: a missing strip simply means fewer pieces of
      // source evidence, not a silently fabricated motion observation.
    }
  }
  return paths;
}

/**
 * 把本地关键帧发布为公网 URL（共享 port/adapter 实现，与服务器同一份代码）。
 * 正式路径：自建中继 / PUBLIC_BASE_URL 部署域名；imgur/litterbox 仅显式开启。
 * 发布失败 → asset_publication_unavailable 统一错误（不发起付费生成）。
 */
async function publishKeyframes(localPaths) {
  const published = [];
  for (const p of localPaths) {
    const { publicUrl, source, expiresAtMs } = await publishLocalAsset(p, {
      runId: sample.sampleId,
      sessionId: 'p3-demo',
    });
    const provider = source === 'relay' ? 'remote-host' : source;
    published.push({ localPath: p, publicUrl, provider, expiresAtMs });
    log('keyframe', `参考关键帧已发布(${provider}): ${publicUrl}`);
  }
  return published;
}

// ==================== 主流程 ====================

async function main() {
  // 1. Manifest + 素材真实性校验（大小 + SHA-256）
  log('manifest', `校验 ${REAL_DEMO_SAMPLE ? 'manifest.json' : ''} 与素材（大小 + SHA-256）…`);
  const manifestCheck = await verifyRealDemoManifest();
  evidence.manifestCheck = manifestCheck;
  if (!manifestCheck.ok && !skipManifest) {
    console.error('Manifest 校验失败（素材可能被替换），拒绝运行：\n' + manifestCheck.errors.join('\n'));
    console.error('（确认素材无误可用 --skip-manifest-check 跳过，仅用于排查）');
    writeFileSync(path.join(demoRoot, `${sample.sampleId}-evidence.json`), JSON.stringify(evidence, null, 2));
    process.exit(1);
  }
  log('manifest', manifestCheck.ok ? `校验通过：${manifestCheck.matched.join(', ')}` : `校验告警：${manifestCheck.errors.join('; ')}`);

  // 2. 自动下载爆款视频
  const videoPath = await downloadViralVideo();
  const probe = execSync(
    `ffprobe -v error -show_entries format=duration -of csv=p=0 "${videoPath}"`,
    { encoding: 'utf8', timeout: 30_000 }
  );
  const durationSec = parseFloat(probe.trim());
  log('video', `爆款视频时长 ${durationSec.toFixed(2)}s`);

  // 3. 场景检测 → 候选切点 →（full-video）语义分析 → 按叙事价值选段 → 抽最终关键帧 → 发布公网
  const sceneChanges = detectSceneChanges(videoPath);
  log('video', `场景检测到 ${sceneChanges.length} 个切点: ${sceneChanges.map((t) => t.toFixed(1)).join(', ')}`);
  // 需要人工审核段时仍可用 --segments 显式覆盖（直接作为最终镜头段）。
  const segmentOverrides =
    parseSegmentOverrides(segmentsArg?.split('=')[1], durationSec) || null;

  // P5 修复（建议 3）：真实流程 = 候选切点 → 抽候选关键帧（本地，不发布）→
  // LLM 语义分析 → 按分析的叙事价值选段（覆盖开头/中段/结尾）→ 抽最终关键帧。
  // 候选帧经 llm-gateway 的 /uploads base64 转换进 LLM，不产生额外公网发布。
  let semantic = null;
  let storyboard = null;
  let segments;
  if (FULL_VIDEO) {
    const candidateSegments = buildCandidateSegments(sceneChanges, durationSec, 12);
    const candidateEvidenceDir = path.join(root, 'uploads', 'materials', 'keyframes', `s3-demo-candidate-evidence-${Date.now()}`);
    let candidateEvidence = extractCandidateEvidenceStrips(videoPath, candidateSegments, candidateEvidenceDir);
    // Candidate index is a contract all the way through LLM analysis →
    // narrative selection → storyboard.  A partial strip batch would shift
    // image #N onto candidate #N+1, so fall back as a whole to midpoint frames
    // rather than mixing evidence formats or silently losing alignment.
    const candidateEvidenceMode = candidateEvidence.length === candidateSegments.length
      ? 'early_mid_late_strip'
      : 'single_keyframe';
    if (candidateEvidenceMode === 'single_keyframe') {
      const fallbackDir = path.join(root, 'uploads', 'materials', 'keyframes', `s3-demo-candidate-fallback-${Date.now()}`);
      candidateEvidence = extractReferenceKeyframes(videoPath, candidateSegments, fallbackDir);
    }
    const analyzer = new LlmSourceSemanticAnalyzer();
    semantic = await analyzer.analyzeRaw({
      productName: sample.productName,
      keyframeUrls: candidateEvidence.map((p) => toUploadsUrl(p)),
      frameEvidence: candidateEvidenceMode,
      // P5 二轮：候选段携带真实秒数（LLM 返回的 shotCandidates.shotIndex 即候选序号）
      segments: candidateSegments.map(({ candidateId, startSec, endSec, structure }) => ({ candidateId, startSec, endSec, structure })),
      modelId: 'Gemini 3.6 Flash',
    });
    log(
      'semantic',
      semantic.schemaValid
        ? `原视频语义分析完成（${candidateEvidence.length} ${candidateEvidenceMode === 'early_mid_late_strip' ? '组动作证据' : '张关键帧'}，schema 校验通过）`
        : `语义分析回退到确定性选段（${semantic.error || 'schema 校验失败'}）`
    );
    // 按 LLM 叙事价值选最终段（candidateId/shotIndex 与秒数双坐标匹配）；
    // 人工审核段（--segments）优先
    segments = selectNarrativeSegments({
      sceneChanges,
      durationSec,
      shotCount: SHOT_COUNT,
      overrides: segmentOverrides,
      candidates: candidateSegments,
      rawAnalysis: semantic.rawAnalysis ?? undefined,
    });
    storyboard = analyzer.buildStoryboardFromAnalysis({
      productName: sample.productName,
      segments: segments.map(({ candidateId, startSec, endSec, structure }) => ({ candidateId, startSec, endSec, structure })),
      rawAnalysis: semantic.rawAnalysis ?? undefined,
      analyzedKeyframeCount: candidateEvidence.length,
    });
  } else {
    segments = buildLegacyShotSegments(sceneChanges, durationSec, segmentOverrides);
  }
  let fullVideoPlan = FULL_VIDEO
    ? createFullVideoPlan({
        productName: sample.productName,
        targetDurationSec: 30,
        shotCount: SHOT_COUNT, // 6-8 镜动态契约（与 storyboard/sequence gate 同源）
        safeReferenceSegments: segments.map(({ startSec, endSec }) => ({ startSec, endSec })),
        semanticStoryboard: storyboard,
      })
    : null;
  if (fullVideoPlan) {
    const planErrors = validateFullVideoPlan(fullVideoPlan);
    if (planErrors.length > 0) throw new Error(`full video plan invalid: ${planErrors.join('; ')}`);
    evidence.fullVideoPlan = fullVideoPlan;
    log('plan', `Full Video Plan: ${fullVideoPlan.shots.length} shots / ${fullVideoPlan.targetDurationSec}s / ${fullVideoPlan.beats.join(' -> ')}`);
  }
  log(
    'video',
    `${segmentOverrides ? '使用人工审核镜头段' : '自动拆出结构镜头'} ${segments.length} 个: ${segments
      .map((s) => `[${s.startSec.toFixed(2)}-${s.endSec.toFixed(2)}s]`)
      .join(' ')}`
  );
  const kfDir = path.join(root, 'uploads', 'materials', 'keyframes', `s3-demo-${Date.now()}`);
  const kfLocalPaths = extractReferenceKeyframes(videoPath, segments, kfDir);
  const kfPublished = await publishKeyframes(kfLocalPaths);
  evidence.derivedAssets.keyframes = kfPublished.map((k) => ({
    localPath: k.localPath.replace(/\\/g, '/'),
    publicUrl: k.publicUrl,
    provider: k.provider,
  }));

  if (FULL_VIDEO && semantic && storyboard) {
    evidence.sourceSemanticAnalysis = {
      source: semantic.source,
      schemaValid: semantic.schemaValid,
      modelUsed: semantic.modelUsed,
      rawAnalysis: semantic.rawAnalysis,
      error: semantic.error,
    };
    evidence.semanticStoryboard = storyboard;
    log(
      'semantic',
      `${semantic.source === 'deterministic_fallback' ? '语义分析回退到确定性故事板' : '原视频语义分析完成'}：${storyboard.shots.map((shot) => `${shot.beat}/${shot.purpose.slice(0, 18)}`).join(' → ')}`
    );

    // 付费前的确定性序列门禁：节拍顺序/承接契约/产品进入/CTA 收束/无装饰镜头。
    // 结构层 fail 是确定失败——不花一分钱就拒绝本次运行，绝不带着断链的 plan 提交 provider。
    const structureChecks = runDeterministicStructureChecks(fullVideoPlan);
    evidence.sequenceGate = {
      stage: 'preflight_structure',
      status: structureChecks.some((check) => check.verdict === 'fail') ? 'fail' : 'pass',
      checks: structureChecks,
      note: '付费调用前的确定性序列门禁（LLM 视觉序列 QA 在成片后执行）',
    };
    const structureFails = structureChecks.filter((check) => check.verdict === 'fail');
    if (structureFails.length > 0) {
      console.error('确定性序列门禁未通过（不发起付费调用）:');
      for (const check of structureFails) {
        console.error(`- [${check.id}] ${check.reason} → 修复: ${check.fix?.action || '（无）'}${check.fix?.shotIndex ? `（第 ${check.fix.shotIndex} 镜）` : ''}`);
      }
      writeFileSync(path.join(demoRoot, `${sample.sampleId}-evidence.json`), JSON.stringify(evidence, null, 2));
      process.exit(3);
    }
    log('sequence-gate', `付费前确定性序列门禁通过（${structureChecks.length} 项检查，节拍链 ${fullVideoPlan.beats.join(' -> ')}）`);
  }

  // 4. 启动 HTTPS 服务器（真实 provider，无 fake）
  await startServer();

  // 5. 登录 + 创建产品（产品图用真实公网 URL——中转可直接下载）
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '888' }),
  });
  const loginJson = await loginRes.json();
  const setCookie = loginRes.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  if (!loginRes.ok) {
    console.error('登录失败:', JSON.stringify(loginJson));
    process.exit(1);
  }
  log('auth', 'admin 登录成功');

  const prodRes = await api('POST', '/api/products', {
    name: `${sample.productName}（S3 真实样例）`,
    positioning: sample.productPositioning,
    price: sample.productPrice,
  });
  const productId = prodRes.json.data?.id ?? prodRes.json.id;
  // P5 收紧后：产品资产必须绑定真实本地字节（SHA-256）才能通过服务端视觉安全
  // 核验——远程公网 URL 无本地摘要 → unverified → 提交边界拒绝。因此先把产品图
  // 下载到本系统 uploads/product-assets/，用本地 URL 入库（hash 绑定 + 真实
  // LLM 视觉评估；派生时 resolveReferenceImageBuffer 走本地 base64 通道）。
  const localProductUrl = await cacheProductAssetLocal(sample.productAssetUrls[0]);
  const attachRes = await api('POST', `/api/products/${productId}/assets`, {
    url: localProductUrl,
    role: 'hero',
  });
  if (attachRes.status !== 201 && attachRes.status !== 200) {
    log('product', `资产附加 status=${attachRes.status}（可能已存在）`);
  }
  log('product', `产品 ${productId} + 资产 ${localProductUrl}（本地字节 hash 绑定）`);
  // 后续锚点/派生参考全部使用本地 URL（product_assets 表可核验 + base64 通道可用）
  const effectiveProductAssetUrls = [localProductUrl];

  // 6. 能力探测（云雾多图条件生成——真实调用一次，写入证据）
  log('capability', '探测云雾多图条件生成能力（/images/edits，真实一次调用）…');
  const { probeEditsCapability, getImageConditioningCapability } = await import('../server/lib/image-conditioning-capability.ts');
  let capability;
  if (FULL_VIDEO) {
    // The full-video slice already has a verified edits capability contract.
    // Do not spend another paid image call on a duplicate probe before the six
    // actual conditioned frames are generated.
    capability = getImageConditioningCapability({});
    log('capability', '复用已验证的 /images/edits 能力声明，跳过重复探测调用');
  } else {
    try {
      capability = await probeEditsCapability({ probeImagePath: kfLocalPaths[0] });
    } catch (e) {
      capability = null;
    }
  }
  if (!capability || !capability.supported) {
    // 探测失败不阻断：本轮派生调用会真实调用 /images/edits，若真不支持会以
    // product_conditioning_provider_unavailable 显式失败（禁止静默降级）。
    const declared = getImageConditioningCapability({});
    evidence.providers.imageConditioning = capability ?? declared;
    log('capability', `探测未通过（${capability?.evidence || '异常'}）；改用声明能力继续：${declared.evidence}`);
  } else {
    evidence.providers.imageConditioning = capability;
    log('capability', capability.evidence);
  }

  // 7. step2：创建镜头任务（参考视频 + 参考关键帧入库；用户不提供首帧）
  const legacyShotList = segments.map((seg, i) => ({
    shotIndex: i + 1,
    shotType: i === 0 ? 'close-up' : 'wide',
    cameraMovement: 'push-in',
    description: seg.structure,
    keyframeUrl: kfPublished[i].publicUrl, // 参考关键帧（构图基座，非首帧）
  }));
  const shotList = segments.map((seg, i) => {
    const planned = fullVideoPlan?.shots[i];
    const referenceUrl = kfPublished[i].publicUrl;
    return {
      shotIndex: i + 1,
      shotType:
        planned?.beat === 'hook' ||
        planned?.beat === 'product_intro' ||
        planned?.beat === 'proof' ||
        planned?.beat === 'cta'
          ? 'close-up'
          : 'medium',
      cameraMovement: planned?.cameraDirection || 'push-in',
      description: planned?.visualIntent || seg.structure,
      motionPrompt: planned
        ? `${planned.prompt} Hard visual constraints: ${planned.negativeConstraints.join('; ')}.`
        : undefined,
      keyframeUrl: referenceUrl,
      referenceKeyframeUrl: referenceUrl,
      negativeConstraints: planned?.negativeConstraints,
    };
  });
  const step2 = await api('POST', '/api/pipeline/step2', {
    productInfo: { name: sample.productName },
    productId,
    referenceVideoUrl: sample.referenceVideoUrl,
    referenceKeyframes: kfPublished.map((k) => k.publicUrl),
    productAssetUrls: effectiveProductAssetUrls,
    shotList,
  });
  const sessionId = step2.json.data?.multiShotResult?.sessionId;
  if (!sessionId) throw new Error(`step2 未返回 sessionId: ${JSON.stringify(step2.json).slice(0, 300)}`);
  log('step2', `镜头任务已创建 sessionId=${sessionId}（${segments.length} 镜，首帧=派生产物）`);

  // 8. 工作台草稿（新输入模型：无候选首帧；携带 参考视频/参考关键帧/产品图 上下文）
  const legacyShotsDraft = segments.map((seg, i) => ({
    shotIndex: i + 1,
    startTime: seg.startSec,
    endTime: seg.endSec,
    shotSize: i === 0 ? 'close_up' : 'medium',
    cameraPosition: 'front',
    cameraMovement: 'push_in',
    lighting: 'soft',
    dialogue: [],
    soundEffects: [],
    mustKeep: ['BUV 品牌产品', '绿色软管包装', '洁面泡沫'],
    mustReplace: ['竞品品牌标识', '非 BUV 产品包装', '医疗效果声称'],
    generationMode: 'image_to_video',
    capabilityConstraints: {
      maxDurationSec: 5,
      minDurationSec: 3,
      supportedAspectRatios: ['9:16'],
      supportedResolutions: ['720p'],
      requiredReferenceInputs: 1,
    },
    status: 'pending',
    blockers: [],
    warnings: [],
    evidence: [],
    candidates: [], // S3：用户不提供首帧，首帧由系统派生
    selectedCandidateId: null,
    promptOverride: null,
    modelId: 'Seedance 2.0 Fast',
  }));
  const shotsDraft = segments.map((seg, i) => {
    const planned = fullVideoPlan?.shots[i];
    const safeReferenceUrl = kfPublished[i].publicUrl;
    // Source keyframes are retained for structure/audit and prompt generation,
    // but never used as the visual conditioning anchor in the product-only demo:
    // they contain hands and source overlays that the image model tends to copy.
    // P5：一律 semantic_replacement + 产品图锚点（ReferenceInputPolicy 在服务端
    // 条件化首帧出口强制执行，safe_keyframe 原帧锚点会被策略拒绝）。
    const referencePolicy = 'semantic_replacement';
    const conditioningAnchorUrl = effectiveProductAssetUrls[0];
    return {
      shotIndex: i + 1,
      startTime: planned ? planned.targetStartMs / 1000 : seg.startSec,
      endTime: planned ? planned.targetEndMs / 1000 : seg.endSec,
      shotSize:
        planned?.beat === 'hook' ||
        planned?.beat === 'product_intro' ||
        planned?.beat === 'proof' ||
        planned?.beat === 'cta'
          ? 'close_up'
          : 'medium',
      cameraPosition: 'front',
      cameraMovement: planned?.cameraDirection || 'push_in',
      lighting: 'soft daylight',
      dialogue: [],
      soundEffects: [],
      mustKeep: ['BUV product packaging', 'green and white palette', 'clean foam texture', 'viral pacing and shot intent'],
      mustReplace: ['source person identity', 'all hands, fingers, arms, skin and body parts', 'source subtitles or watermark', 'competitor packaging'],
      generationMode: 'image_to_video',
      capabilityConstraints: {
        maxDurationSec: 5,
        minDurationSec: 3,
        supportedAspectRatios: ['9:16'],
        supportedResolutions: ['720p'],
        requiredReferenceInputs: 1,
      },
      status: 'pending',
      blockers: [],
      warnings: [],
      evidence: [],
      candidates: [],
      selectedCandidateId: null,
      promptOverride: planned?.prompt || null,
      modelId: 'Seedance 2.0 Fast',
      beat: planned?.beat,
      referencePolicy,
      // Keep raw source keyframe only on the step2 prompt/audit object. The
      // first-frame boundary uses the clean product asset as its continuity
      // anchor for every full-video shot.
      referenceKeyframeUrl: null,
      continuityAnchorUrl: conditioningAnchorUrl,
      continuityGroup: planned?.continuityGroup,
      visualIntent: planned?.visualIntent,
      productExposure: planned?.productExposure,
      semanticPurpose: planned?.semanticPurpose,
      sourceAction: planned?.safeVisualProxy || planned?.sourceAction,
      safeVisualProxy: planned?.safeVisualProxy,
      safeCoverageCriteria: planned?.safeCoverageCriteria,
      sourceActionAudit: planned?.sourceActionAudit,
      audienceEffect: planned?.audienceEffect,
      transitionIn: planned?.transitionIn,
      transitionOut: planned?.transitionOut,
      replacementIntent: planned?.replacementIntent,
      negativeConstraints: planned?.negativeConstraints,
      targetStartMs: planned?.targetStartMs,
      targetEndMs: planned?.targetEndMs,
      sourceReferenceSegment: { startSec: seg.startSec, endSec: seg.endSec },
    };
  });
  await api('POST', '/api/workbench/draft', {
    sessionId,
    draftJson: JSON.stringify({
      shots: shotsDraft,
      videoModelId: 'Seedance 2.0 Fast',
      productId,
      productName: sample.productName,
      referenceVideoUrl: sample.referenceVideoUrl,
      referenceKeyframes: kfPublished.map((k) => k.publicUrl),
      productAssetUrls: effectiveProductAssetUrls,
      fullVideoPlan,
      prohibitedItems: ['竞品品牌标识', '非 BUV 产品包装', '医疗效果声称', '夸大功效文字'],
      allowedItems: ['BUV 品牌产品', '绿色软管包装', '洁面泡沫'],
      referenceStructure: fullVideoPlan?.semanticStoryboard
        ? `${fullVideoPlan.semanticStoryboard.sourceIntent}；情绪链：${fullVideoPlan.semanticStoryboard.emotionalArc}；视觉语法：${fullVideoPlan.semanticStoryboard.visualGrammar.transitionLanguage}`
        : '爆款视频参考段落：洁面泡沫涂抹 / 产品展示',
    }),
    autonomyMode: 'step_by_step',
  });
  await api('POST', '/api/workbench/confirm', { sessionId, type: 'deconstruction' });
  await api('POST', '/api/workbench/confirm', { sessionId, type: 'shot_plan' });
  await api('POST', '/api/workbench/paid-auth', { sessionId, enabled: true });
  const preflight = await api('POST', '/api/workbench/preflight', { sessionId });
  if (!preflight.json.data?.canSubmit) {
    console.error('预检阻断（不提交 provider）:', JSON.stringify(preflight.json.data?.blockers || []).slice(0, 800));
    await stopServer();
    writeFileSync(path.join(demoRoot, `${sample.sampleId}-evidence.json`), JSON.stringify(evidence, null, 2));
    process.exit(1);
  }
  log('preflight', `预检通过（含首帧派生计划），逐镜成本 ${JSON.stringify(preflight.json.data?.cost?.perShot || [])}`);

  // 9. 批量提交（真实付费）：服务端自动 派生首帧（edits）→ 预检 → Seedance 提交。
  // 该请求可能持续数分钟（逐镜派生 + 预检 + 中转素材注册），不阻塞等待——
  // 并发发起后由第 10 步轮询驱动进度，最后再收拢结果。
  const submittedAt = Date.now();
  const confirmPromise = fetch(`${BASE}/api/workbench/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ sessionId, type: 'batch_submit' }),
  })
    .then(async (res) => {
      const json = await res.json().catch(() => null);
      return { status: res.status, json };
    })
    .catch((e) => ({ status: 0, json: null, error: String(e?.message || e) }));
  log('submit', '批量提交已发起（异步；逐镜 首帧派生→预检→Seedance 提交 由轮询驱动）…');

  // 10. 轮询镜头完成（shot-tasks 轮询驱动状态）
  const POLL_TIMEOUT_MS = 25 * 60 * 1000;
  const startedPoll = Date.now();
  let shotStates = [];
  let confirm = null;
  let confirmFetchFailed = false;
  while (Date.now() - startedPoll < POLL_TIMEOUT_MS) {
    // confirm 请求为「异步发起」：客户端连接失败不代表服务端未处理
    // （服务端可能仍在逐镜派生/提交）——只记警告，继续按镜头状态轮询。
    if (confirm === null) {
      const settled = await Promise.race([
        confirmPromise.then((r) => r),
        new Promise((resolve) => setTimeout(() => resolve(null), 500)),
      ]);
      if (settled) {
        if (settled.status !== 200 && settled.status !== 409) {
          confirmFetchFailed = true;
          evidence.errors.push(`confirm 响应异常 HTTP ${settled.status}: ${JSON.stringify(settled.json || settled.error).slice(0, 200)}（服务端可能仍在处理，继续轮询）`);
          log('submit', `confirm 响应异常 HTTP ${settled.status}（继续轮询镜头状态）`);
        }
        confirm = settled;
      }
    }
    const stRes = await api('GET', `/api/pipeline/shot-tasks/${encodeURIComponent(sessionId)}`).catch(() => null);
    if (!stRes) {
      // 服务端瞬断：重试
      await new Promise((r) => setTimeout(r, 5_000));
      continue;
    }
    const state = await api('GET', `/api/workbench/state?sessionId=${encodeURIComponent(sessionId)}`);
    shotStates = state.json.data?.shotStates || [];
    if (shotStates.length > 0 && shotStates.every((s) => s.status === 'completed' || s.status === 'failed')) break;
    await new Promise((r) => setTimeout(r, 10_000));
    const done = shotStates.filter((s) => s.status === 'completed').length;
    log('generate', `轮询 ${Math.round((Date.now() - startedPoll) / 1000)}s：${done}/${shotStates.length} 完成`);
  }
  if (confirm === null) {
    // The state endpoint is authoritative once every shot is terminal.  Some
    // provider relays keep the original batch-submit connection open after
    // persisting all shot results; never let that socket block QA/export.
    const settledConfirm = await Promise.race([
      confirmPromise,
      new Promise((resolve) => setTimeout(() => resolve(null), 3_000)),
    ]);
    confirm = settledConfirm || {
      status: 0,
      json: null,
      error: 'batch submit response not observed; terminal shot state is authoritative',
    };
    if (!settledConfirm) {
      evidence.errors.push('batch submit response not observed after terminal shot state; continued with persisted tasks');
    }
  }
  const submittedCount = confirm.json?.data?.submittedCount;
  if (typeof submittedCount === 'number') {
    log('submit', `批量提交返回 submittedCount=${submittedCount}`);
  } else {
    evidence.errors.push(`confirm 未返回 submittedCount: ${JSON.stringify(confirm.json || confirm.error).slice(0, 200)}`);
  }
  const generationDurationMs = Date.now() - submittedAt;
  const completedShots = shotStates.filter((s) => s.status === 'completed');
  const failedShots = shotStates.filter((s) => s.status === 'failed');
  if (completedShots.length === 0) {
    console.error('全部镜头生成失败：', JSON.stringify(shotStates.map((s) => ({ i: s.shotIndex, st: s.status, err: s.failureReason }))));
    await stopServer();
    writeFileSync(path.join(demoRoot, `${sample.sampleId}-evidence.json`), JSON.stringify(evidence, null, 2));
    process.exit(1);
  }
  log('generate', `${completedShots.length}/${shotStates.length} 镜完成，总耗时 ${Math.round(generationDurationMs / 1000)}s`);
  evidence.shots = shotStates.map((s) => ({
    shotIndex: s.shotIndex,
    shotId: s.shotId,
    status: s.status,
    videoUrl: s.videoUrl,
    failureReason: s.failureReason,
    derivedFirstFrameUrl: s.derivedFirstFrameUrl || null,
    firstFramePreflightStatus: s.firstFramePreflightStatus || null,
  }));

  // 10b. 缓存远端产物到本地（供 QA 帧提取 / concat）——必须在 QA 之前。
  // S4.1 修复：修复轮新生成的镜头产物 URL 与首轮不同，必须每轮修复后重跑本函数，
  // 否则修复后 QA 帧提取不到本地缓存 → 判决退化为 unverified（不是真实的 QA 结论）。
  async function cacheRemoteVideos(shotStates) {
    const cacheDb = new DatabaseSync(path.join(dataDir, 'pipeline.db'));
    for (const s of shotStates) {
      if (s.status !== 'completed' || !s.videoUrl) continue;
      if (s.videoUrl.startsWith('/uploads/')) continue;
      try {
        const name = path.basename(new URL(s.videoUrl).pathname);
        const local = path.join(root, 'uploads', 'renders', name);
        if (!existsSync(local)) {
          const res = await fetch(s.videoUrl, { signal: AbortSignal.timeout(180_000) });
          if (res.ok) {
            const buf = Buffer.from(await res.arrayBuffer());
            writeFileSync(local, buf);
            log('cache', `产物已缓存 ${name} (${(buf.length / 1024).toFixed(0)}KB)`);
          }
        }
        const localUrl = `/uploads/renders/${name}`;
        cacheDb.prepare(
          `UPDATE shot_generation_tasks
              SET video_url = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?`
        ).run(localUrl, s.shotId);
        cacheDb.prepare(
          `UPDATE shot_versions
              SET video_url = ?
            WHERE shot_id = ? AND version = COALESCE((SELECT current_version FROM shot_generation_tasks WHERE id = ?), 1)`
        ).run(localUrl, s.shotId, s.shotId);
        s.videoUrl = localUrl;
      } catch (e) {
        evidence.errors.push(`产物缓存失败 ${s.videoUrl}: ${e.message}`);
      }
    }
    cacheDb.close();
  }
  await cacheRemoteVideos(shotStates);

  // 11. 逐镜 QA（真实 LLM vision，受限并发 2）
  async function qaRound(label) {
    const state = await api('GET', `/api/workbench/state?sessionId=${encodeURIComponent(sessionId)}`);
    const shots = state.json.data?.shotStates || [];
    const qaTargets = shots.filter((s) => s.status === 'completed');
    log('qa', `${label}：对 ${qaTargets.length} 个完成镜头执行 QA（并发 2）…`);
    const outcomes = await mapConcurrent(qaTargets, 2, async (s) => {
      try {
        const qa = await api('POST', '/api/workbench/qa-shot', { runId: sessionId, shotId: s.shotId });
        return { shotIndex: s.shotIndex, verdict: qa.json.data?.overallVerdict, summary: qa.json.data?.summary };
      } catch (e) {
        return { shotIndex: s.shotIndex, verdict: 'error', summary: e.message };
      }
    });
    for (const o of outcomes) {
      if (o.status === 'fulfilled') {
        log('qa', `${label} 第 ${o.value.shotIndex} 镜判决=${o.value.verdict} · ${o.value.summary}`);
      } else {
        evidence.errors.push(`QA 失败: ${String(o.reason)}`);
      }
    }
    return outcomes.filter((o) => o.status === 'fulfilled').map((o) => o.value);
  }

  const qaRound1 = await qaRound('首轮');

  // 12. 定向修复（最多 2 轮，每轮并行修复全部不合格镜头，失败只返修对应镜头）
  // - completed 且语义 fail → fix-shot（含首帧重派生，如果 product_consistency）
  // - status failed（首帧派生/预检失败）→ retry-shot（重新派生首帧 + 重拍）
  const fixRounds = [];
  for (let fixRound = 0; fixRound < 2; fixRound++) {
    const state = await api('GET', `/api/workbench/state?sessionId=${encodeURIComponent(sessionId)}`);
    const shotsNow = state.json.data?.shotStates || [];
    const fixableShots = shotsNow.filter(
      (s) =>
        !s.manualPassed &&
        ((s.status === 'completed' && s.semanticVerdict === 'fail' && s.autoFixCount <= fixRound) ||
          (s.status === 'failed' && s.autoFixCount <= fixRound))
    );
    if (fixableShots.length === 0) break;
    log('fix', `第 ${fixRound + 1} 轮修复：${fixableShots.map((s) => `第${s.shotIndex}镜(${s.status})`).join('、')}（并发 2）`);
    const fixOutcomes = await mapConcurrent(fixableShots, 2, async (fixable) => {
      const fixStarted = Date.now();
      try {
        if (fixable.status === 'failed') {
          // 失败镜头（首帧派生/预检失败）：retry-shot 重新派生首帧 + 重拍
          await api('POST', '/api/workbench/retry-shot', {
            runId: sessionId,
            shotId: fixable.shotId,
            attempt: Math.max(1, (fixable.autoFixCount || 0) + 1),
            failureReason: 'auto_fix_regenerate:first_frame_retry',
          });
        } else {
          await api('POST', '/api/workbench/fix-shot', { runId: sessionId, shotId: fixable.shotId });
        }
      } catch (e) {
        return { shotIndex: fixable.shotIndex, verdict: 'retry_failed', summary: e.message };
      }
      // 修复触发真实重新生成（含首帧重派生）→ 轮询完成
      while (Date.now() - fixStarted < 12 * 60 * 1000) {
        await api('GET', `/api/pipeline/shot-tasks/${encodeURIComponent(sessionId)}`).catch(() => null);
        const st = await api('GET', `/api/workbench/state?sessionId=${encodeURIComponent(sessionId)}`);
        const shot = (st.json.data?.shotStates || []).find((x) => x.shotId === fixable.shotId);
        if (shot?.status === 'completed' || shot?.status === 'failed') break;
        await new Promise((r) => setTimeout(r, 10_000));
      }
      // S4.1：修复轮产物必须缓存到本地，QA 帧提取才有素材（否则判决退化为 unverified）
      const freshState = await api('GET', `/api/workbench/state?sessionId=${encodeURIComponent(sessionId)}`);
      await cacheRemoteVideos(freshState.json.data?.shotStates || []);
      const qaAfter = await api('POST', '/api/workbench/qa-shot', { runId: sessionId, shotId: fixable.shotId });
      return { shotIndex: fixable.shotIndex, verdict: qaAfter.json.data?.overallVerdict, summary: qaAfter.json.data?.summary };
    });
    for (const o of fixOutcomes) {
      if (o.status === 'fulfilled') {
        log('fix', `第 ${o.value.shotIndex} 镜修复后判决=${o.value.verdict}`);
      } else {
        evidence.errors.push(`修复失败: ${String(o.reason)}`);
      }
    }
    fixRounds.push({ round: fixRound + 1, results: fixOutcomes.map((o) => (o.status === 'fulfilled' ? o.value : { error: String(o.reason) })) });
  }
  evidence.qaRounds = [{ round: 1, results: qaRound1 }, ...fixRounds];

  // 14-15b. 最终合成 + step5 下载 + 序列门禁（抽成可复用函数：首轮与剪辑点返修轮共用）。
  // 剪辑点返修后必须重新合成/重新下载/重新 gate——否则证据停留在旧成片上。
  const finalState = { gateShots: [], renderedTimeline: null, sequenceGatePassed: false };
  async function runComposeAndGate(label) {
    const gateState = await api('GET', `/api/workbench/state?sessionId=${encodeURIComponent(sessionId)}`);
    finalState.gateShots = gateState.json.data?.shotStates || [];
    const gate = await api('POST', '/api/pipeline/concat-shots', {
      sessionId,
      videoUrls: finalState.gateShots.filter((s) => s.status === 'completed' && s.videoUrl).map((s) => s.videoUrl),
      // The quality path binds concat to the same approved 6-8 shot plan used
      // for generation and sequence QA.  The server re-reads ordered task URLs
      // and probes real durations; it never relies on this client-side list.
      ...(fullVideoPlan ? { fullVideoPlan } : {}),
    });
    evidence.compositeGate = { status: gate.status, data: gate.json, label };
    if (gate.status !== 200 || !gate.json.data?.concatenatedVideoUrl) {
      console.error(`最终合成被质量门禁阻断（${label}；符合要求：fail/unverified 未人工确认不能合成）:`);
      console.error(JSON.stringify(gate.json, null, 2).slice(0, 1200));
      await stopServer();
      writeFileSync(path.join(demoRoot, `${sample.sampleId}-evidence.json`), JSON.stringify(evidence, null, 2));
      process.exit(2);
    }
    // The final sequence gate samples real boundary times from this exact
    // rendered timeline. Do not fall back to an idealised 5-second-per-shot
    // assumption after FFmpeg has already computed the actual composition.
    finalState.renderedTimeline = gate.json.data?.timeline || null;
    evidence.renderTimeline = finalState.renderedTimeline;
    log('render', `[${label}] 拼接产物: ${gate.json.data.concatenatedVideoUrl}`);

    // step5 成片（携带 sessionId——Step5 侧同样过门禁）
    const concatUrl = gate.json.data.concatenatedVideoUrl;
    const step5 = await api('POST', '/api/pipeline/step5', {
      inputs: {
        sessionId,
        videoSourceUrl: concatUrl,
        durationSec: fullVideoPlan?.targetDurationSec || undefined,
        subtitleStyle: 'none',
        aspectRatio: '9:16',
        productId,
        title: `${sample.sampleName} · 真实复刻`,
        hook: '爆款复刻 · 产品条件化首帧直出',
      },
    });
    const downloadUrl = step5.json.data?.output?.downloadUrl || step5.json.data?.downloadUrl;
    log('render', `[${label}] step5 status=${step5.status} downloadUrl=${downloadUrl || '(无)'}`);
    if (downloadUrl) {
      const res = await fetch(`${BASE}${downloadUrl}`, { headers: { Cookie: cookie } });
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        const outFile = path.join(artifactDir, `${sample.sampleId}-final.mp4`);
        writeFileSync(outFile, buf);
        // 可播放性验证：ffprobe 读取时长/编码
        let playable = false;
        let probeInfo = null;
        try {
          const probeOut = execSync(
            `ffprobe -v error -show_entries format=duration,size:stream=codec_name,width,height -of json "${outFile}"`,
            { encoding: 'utf8', timeout: 60_000 }
          );
          probeInfo = JSON.parse(probeOut);
          playable = Boolean(probeInfo?.streams?.length > 0);
        } catch {}
        evidence.finalMp4 = {
          url: downloadUrl,
          file: outFile,
          bytes: buf.length,
          playable,
          probe: probeInfo,
        };
        log('render', `[${label}] 最终 MP4 已下载: ${outFile} (${(buf.length / 1024 / 1024).toFixed(2)}MB) playable=${playable}`);
      } else {
        evidence.errors.push(`[${label}] 最终 MP4 下载失败 HTTP ${res.status}`);
      }
    }

    // 成片级序列语义门禁（抽帧 → LLM 视觉验证故事顺序/承接/产品进入/CTA/无装饰镜）。
    // fail/unverified → 不得标记通过；仅当 gate 定位到具体 seam 时才触发定向返修。
    if (fullVideoPlan && evidence.finalMp4?.file) {
      const finalLocal = path.join(root, 'uploads', 'renders', `final-${sample.sampleId}.mp4`);
      mkdirSync(path.dirname(finalLocal), { recursive: true });
      try {
        copyFileSync(evidence.finalMp4.file, finalLocal);
        // P5 修复（真实 wiring）：显式注入真实 LLM（经共享适配器 createSequenceGateLlm，
        // 底层是 llm-gateway 真实 provider）。LLM 不可用/帧提取失败时 gate 如实返回
        // unverified（不伪造 pass），退出码仍为 3。
        const seqGate = await runSequenceSemanticGate({
          plan: fullVideoPlan,
          finalVideoUrl: finalLocal,
          uploadsRoot: path.join(root, 'uploads'),
          ...(finalState.renderedTimeline ? { timeline: finalState.renderedTimeline } : {}),
          llm: createSequenceGateLlm({ modelId: 'Gemini 3.6 Flash' }),
        });
        evidence.sequenceGate = {
          preflight: evidence.sequenceGate?.preflight ?? evidence.sequenceGate,
          final: {
            stage: 'final_composite',
            label,
            status: seqGate.status,
            fallback: seqGate.fallback,
            scorer: seqGate.scorer,
            sampledFrames: seqGate.sampledFrames.map((f) => ({
              nodeIndex: f.nodeIndex,
              timeSec: f.timeSec,
              url: f.url,
              role: f.role,
              shotIndex: f.shotIndex,
              boundaryToShotIndex: f.boundaryToShotIndex,
            })),
            checks: seqGate.checks.map((check) => ({
              id: check.id,
              verdict: check.verdict,
              evidence: check.evidence,
              reason: check.reason,
              fix: check.fix,
            })),
          },
        };
        finalState.sequenceGatePassed = seqGate.status === 'pass';
        log('sequence-gate', `[${label}] 成片序列语义门禁: ${seqGate.status}${seqGate.fallback ? '（fallback，未获视觉验证）' : ''} — ${seqGate.checks.map((c) => `${c.id}=${c.verdict}`).join(', ')}`);
        if (!finalState.sequenceGatePassed) {
          console.error(`[${label}] 序列级语义门禁未通过（成片已产出但不得标记为通过），修复建议:`);
          for (const check of seqGate.checks.filter((c) => c.verdict === 'fail' || c.verdict === 'unverified')) {
            console.error(`- [${check.id}] ${check.reason} → ${check.fix ? `${check.fix.action}${check.fix.shotIndex ? `（第 ${check.fix.shotIndex} 镜）` : ''}` : '（无自动建议，需人工复核成片）'}`);
          }
        }
      } catch (e) {
        evidence.errors.push(`[${label}] 序列语义门禁执行失败: ${String(e?.message || e)}`);
        log('sequence-gate', `[${label}] 序列语义门禁执行失败: ${String(e?.message || e)}`);
      }
    } else {
      evidence.errors.push(`[${label}] 未执行序列语义门禁：缺少 fullVideoPlan 或最终 MP4`);
    }
  }

  await runComposeAndGate('首轮合成');

  // 15b-2. 剪辑点定向返修（sequence gate 定位 seam → 只重生成接收镜 → 重新合成 → 重新 gate）。
  // 绝不整条重跑；返修锚点 = 前一镜结束边界帧（本系统生成产物，hash 绑定可信登记）。
  const seamRounds = [];
  for (let round = 0; round < 2; round++) {
    const gateResult = evidence.sequenceGate?.final;
    if (finalState.sequenceGatePassed || !gateResult || !fullVideoPlan) break;
    const targets = resolveSeamRepairTargets(gateResult, fullVideoPlan.shots.length);
    if (targets.length === 0) break;
    log('seam-repair', `第 ${round + 1} 轮剪辑点定向返修：${targets.map((t) => `seam ${t.fromShotIndex}->${t.toShotIndex}`).join('、')}`);
    const shotById = new Map(finalState.gateShots.map((s) => [s.shotId, s]));
    const roundResults = [];
    for (const target of targets) {
      const toShot = shotById.get(target.toShotId) || finalState.gateShots.find((s) => s.shotIndex === target.toShotIndex);
      const fromShot = finalState.gateShots.find((s) => s.shotIndex === target.fromShotIndex);
      if (!toShot || !fromShot) {
        evidence.errors.push(`seam-repair: 找不到镜头（to=${target.toShotIndex}, from=${target.fromShotIndex}）`);
        continue;
      }
      const repairRes = await api('POST', '/api/workbench/repair-seam', {
        sessionId,
        shotId: toShot.shotId,
        fromShotId: fromShot.shotId,
        reason: target.reason,
      });
      if (repairRes.status !== 200) {
        evidence.errors.push(`seam-repair 第${target.toShotIndex}镜失败: ${JSON.stringify(repairRes.json || repairRes.error).slice(0, 300)}`);
        roundResults.push({ toShotIndex: target.toShotIndex, ok: false, error: repairRes.json?.error || String(repairRes.status) });
        continue;
      }
      // 等接收镜重新生成完成（最多 12 分钟）
      const fixStarted = Date.now();
      while (Date.now() - fixStarted < 12 * 60 * 1000) {
        await api('GET', `/api/pipeline/shot-tasks/${encodeURIComponent(sessionId)}`).catch(() => null);
        const st = await api('GET', `/api/workbench/state?sessionId=${encodeURIComponent(sessionId)}`);
        const shot = (st.json.data?.shotStates || []).find((x) => x.shotId === toShot.shotId);
        if (shot?.status === 'completed' || shot?.status === 'failed') break;
        await new Promise((r) => setTimeout(r, 10_000));
      }
      const fresh = await api('GET', `/api/workbench/state?sessionId=${encodeURIComponent(sessionId)}`);
      const shotAfter = (fresh.json.data?.shotStates || []).find((x) => x.shotId === toShot.shotId);
      await cacheRemoteVideos(fresh.json.data?.shotStates || []);
      log('seam-repair', `第${target.toShotIndex}镜返修后 status=${shotAfter?.status} anchor=${repairRes.json?.data?.anchorUrl}`);
      roundResults.push({
        toShotIndex: target.toShotIndex,
        ok: shotAfter?.status === 'completed',
        status: shotAfter?.status,
        anchorUrl: repairRes.json?.data?.anchorUrl || null,
        reason: target.reason,
      });
    }
    seamRounds.push({ round: round + 1, targets: targets.map((t) => ({ from: t.fromShotIndex, to: t.toShotIndex, checkId: t.checkId })), results: roundResults });
    // 重新合成 + 重新 gate（同一函数，证据自动覆盖为最新成片）
    await runComposeAndGate(`剪辑点返修第 ${round + 1} 轮后合成`);
  }
  evidence.seamRepairRounds = seamRounds;
  const gateShots = finalState.gateShots;
  const renderedTimeline = finalState.renderedTimeline;
  let sequenceGatePassed = finalState.sequenceGatePassed;
  // 15c. contact sheet（人工验收）：逐镜首帧 + 叙事节点 + 每个剪辑点的左右两侧。
  // 最后一项与 sequence gate 使用同一套真实 timeline，而不是靠肉眼猜测
  // 计划中的 4 秒节点是否仍和最终成片一致。
  try {
    evidence.contactSheets = buildContactSheets(
      gateShots,
      evidence.finalMp4?.file || null,
      fullVideoPlan,
      renderedTimeline
    );
    log('contact-sheet', `contact sheet 已生成: shots=${evidence.contactSheets.shots || '(失败)'} final=${evidence.contactSheets.final || '(失败)'} seams=${evidence.contactSheets.seams || '(失败)'}`);
    console.log('人工验收请查看:');
    if (evidence.contactSheets.shots) console.log(`  6 镜首帧表: ${evidence.contactSheets.shots}`);
    if (evidence.contactSheets.final) console.log(`  成片节点帧表: ${evidence.contactSheets.final}`);
    if (evidence.contactSheets.seams) console.log(`  剪辑点左右帧表: ${evidence.contactSheets.seams}`);
    if (evidence.finalMp4?.file) console.log(`  最终 MP4: ${evidence.finalMp4.file}`);
  } catch (e) {
    evidence.errors.push(`contact sheet 生成失败: ${String(e?.message || e)}`);
  }

  // 16. 成本账本（估算成本 + 重试记录）
  const ledger = await api('GET', `/api/v1/runs/${sessionId}`).catch(() => null);
  evidence.costLedger = {
    generationDurationMs,
    shotStates: gateShots.map((s) => ({
      shotIndex: s.shotIndex,
      status: s.status,
      failureReason: s.failureReason,
      autoFixCount: s.autoFixCount,
    })),
    preflightCost: preflight.json.data?.cost || null,
  };

  // 17. 服务重启恢复
  log('restart', '重启服务器验证状态恢复…');
  await stopServer();
  await startServer();
  const recovered = await api('GET', `/api/workbench/state?sessionId=${encodeURIComponent(sessionId)}`);
  const recShots = recovered.json.data?.shotStates || [];
  evidence.restartRecovery = {
    restored: recShots.length > 0,
    shotStates: recShots.map((s) => ({ shotIndex: s.shotIndex, status: s.status, semanticVerdict: s.semanticVerdict })),
  };
  log('restart', `重启后恢复 ${recShots.length} 镜`);

  // 18. golden_runs 落库（真实运行记录）
  await recordGoldenRuns(sessionId, gateShots, generationDurationMs, kfPublished.map((k) => k.publicUrl));

  // 19. 汇总证据
  evidence.completedAt = new Date().toISOString();
  evidence.summary = {
    shotsCompleted: completedShots.length,
    shotsFailed: failedShots.length,
    generationDurationMs,
    qaVerdicts: gateShots.map((s) => ({ shotIndex: s.shotIndex, verdict: s.semanticVerdict, manualPassed: s.manualPassed })),
    compositeGatePassed: gate.status === 200,
    finalMp4Downloaded: Boolean(evidence.finalMp4),
    sequenceGatePassed,
    sequenceGateStatus: evidence.sequenceGate?.final?.status ?? evidence.sequenceGate?.status ?? 'skipped',
    contactSheetsGenerated: Boolean(evidence.contactSheets?.shots && evidence.contactSheets?.final && evidence.contactSheets?.seams),
    restartRecovered: evidence.restartRecovery?.restored,
  };
  writeFileSync(path.join(demoRoot, `${sample.sampleId}-evidence.json`), JSON.stringify(evidence, null, 2));
  log('done', `证据已写入 ${path.join(demoRoot, `${sample.sampleId}-evidence.json`)}`);

  await stopServer();
  // 退出码语义：
  //   0 = 成片产出 + 序列语义门禁通过（完整验收闭环）
  //   2 = 成片未产出
  //   3 = 成片已产出但序列语义门禁 fail/unverified（不得视为「完整爆款复刻 Demo 通过」）
  process.exit(evidence.finalMp4 ? (sequenceGatePassed ? 0 : 3) : 2);
}

/** 下载产品图到本系统 uploads/product-assets/，返回 /uploads 本地 URL（P5 hash 绑定前提） */
async function cacheProductAssetLocal(remoteUrl) {
  const fileName = `buv-product-${Date.now()}.png`;
  const localDir = path.join(root, 'uploads', 'product-assets');
  mkdirSync(localDir, { recursive: true });
  const localPath = path.join(localDir, fileName);
  const res = await fetch(remoteUrl, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) {
    throw new Error(`产品图下载失败 HTTP ${res.status}: ${remoteUrl.slice(0, 120)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(localPath, buf);
  log('product', `产品图已缓存到本地: ${localPath} (${(buf.length / 1024).toFixed(0)}KB)`);
  return `/uploads/product-assets/${fileName}`;
}

/**
 * 生成人工验收用的 contact sheet（ffmpeg tile）：
 * 1. 6 镜首帧表（从每镜已完成视频抽帧，人工核对每镜语义职责是否兑现）；
 * 2. 成片节点帧表（按 full-video plan 的镜头时间节点抽帧，人工核对串起来是否成立）；
 * 3. 剪辑点左右帧表（每一个 out/in 相邻成对，专门检查动作、状态、布光是否断裂）。
 * 返回 { shots, final, seams, seamTargets }（文件路径；失败返回 null）。
 */
function buildContactSheets(shotStates, finalMp4Path, plan, timeline = null) {
  const tmpDir = path.join(artifactDir, 'cs-tmp');
  mkdirSync(tmpDir, { recursive: true });
  const sheets = { shots: null, final: null, seams: null, seamTargets: [] };

  const tiles = (frames, outFile) => {
    if (frames.length < 2) return null;
    frames.sort((a, b) => a.index - b.index);
    const inputs = frames.map((f) => `-i "${f.file}"`).join(' ');
    const scaled = frames.map((f, i) => `[${i}:v]scale=240:426,setsar=1[t${i}]`).join(';');
    const layout = frames
      .map((_, i) => {
        const col = i % 3;
        const row = Math.floor(i / 3);
        return `${col === 0 ? 0 : `${col}*w0`}_${row === 0 ? 0 : `${row}*h0`}`;
      })
      .join('|');
    try {
      execSync(
        `ffmpeg -y -v error ${inputs} -filter_complex "${scaled};[t0]${frames
          .slice(1)
          .map((_, i) => `[t${i + 1}]`)
          .join('')}xstack=inputs=${frames.length}:layout=${layout}" "${outFile}"`,
        { stdio: 'ignore', timeout: 120_000 }
      );
      return existsSync(outFile) ? outFile : null;
    } catch {
      return null;
    }
  };

  // 1) 每镜首帧（用已缓存到 uploads/renders 的镜头视频）
  const shotFrames = [];
  for (const s of shotStates) {
    if (s.status !== 'completed' || !s.videoUrl) continue;
    const local = s.videoUrl.startsWith('/uploads/')
      ? path.join(root, s.videoUrl.replace(/^\/?uploads\//, ''))
      : null;
    if (!local || !existsSync(local)) continue;
    const out = path.join(tmpDir, `shot${s.shotIndex}_frame.jpg`);
    try {
      execSync(`ffmpeg -y -v error -ss 0.8 -i "${local}" -frames:v 1 -q:v 2 "${out}"`, {
        stdio: 'ignore',
        timeout: 60_000,
      });
      if (existsSync(out)) shotFrames.push({ index: s.shotIndex, file: out });
    } catch {}
  }
  sheets.shots = tiles(shotFrames, path.join(artifactDir, `${sample.sampleId}-contact-sheet-shots.jpg`));

  // 2) 成片节点帧（按 full-video plan 每镜中点抽帧）
  if (finalMp4Path && existsSync(finalMp4Path) && plan) {
    const finalFrames = [];
    const nodeTimes = plan.shots.map((shot) => (shot.targetStartMs + shot.targetEndMs) / 2 / 1000);
    for (let i = 0; i < nodeTimes.length; i++) {
      const out = path.join(tmpDir, `final_node${i + 1}.jpg`);
      try {
        execSync(`ffmpeg -y -v error -ss ${nodeTimes[i].toFixed(2)} -i "${finalMp4Path}" -frames:v 1 -q:v 2 "${out}"`, {
          stdio: 'ignore',
          timeout: 60_000,
        });
        if (existsSync(out)) finalFrames.push({ index: i + 1, file: out });
      } catch {}
    }
    sheets.final = tiles(finalFrames, path.join(artifactDir, `${sample.sampleId}-contact-sheet-final.jpg`));

    // 3) Exact in/out evidence around every edit.  The ordering is deliberately
    // [shot 1 out, shot 2 in, shot 2 out, shot 3 in, ...], so each adjacent pair
    // is a single seam.  Keep the target manifest alongside the JPEG because a
    // contact sheet without time/role metadata is not auditable.
    const seamTargets = buildSequenceFrameTargets(plan, timeline || undefined)
      .filter((target) => target.role === 'boundary_out' || target.role === 'boundary_in');
    const seamFrames = [];
    for (let i = 0; i < seamTargets.length; i++) {
      const target = seamTargets[i];
      const direction = target.role === 'boundary_out' ? 'out' : 'in';
      const out = path.join(tmpDir, `seam_${String(i + 1).padStart(2, '0')}_shot${target.shotIndex}_${direction}_${target.timeSec.toFixed(2)}.jpg`);
      try {
        execSync(`ffmpeg -y -v error -ss ${target.timeSec.toFixed(3)} -i "${finalMp4Path}" -frames:v 1 -q:v 2 "${out}"`, {
          stdio: 'ignore',
          timeout: 60_000,
        });
        if (existsSync(out)) seamFrames.push({ index: i + 1, file: out });
      } catch {}
    }
    sheets.seams = tiles(seamFrames, path.join(artifactDir, `${sample.sampleId}-contact-sheet-seams.jpg`));
    sheets.seamTargets = seamTargets.map((target) => ({
      role: target.role,
      shotIndex: target.shotIndex,
      boundaryToShotIndex: target.boundaryToShotIndex ?? null,
      timeSec: target.timeSec,
    }));
  }
  return sheets;
}

/** 把真实运行记录写入 golden_runs（服务停止后直连 SQLite） */
async function recordGoldenRuns(sessionId, shotStates, generationDurationMs, kfUrls) {
  try {
    await stopServer();
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(dataDir, 'pipeline.db'));
    const gitCommit = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim();
    for (const s of shotStates) {
      const id = `golden-${sample.sampleId}-${Date.now()}-${s.shotIndex}`;
      db.prepare(
        `INSERT INTO golden_runs
           (id, sample_id, run_index, owner_id, started_at, completed_at, duration_ms,
            provider, model, model_code, seed, prompt, prompt_version, artifact_url,
            artifact_status, tech_qa_status, semantic_verdict, estimated_cost_micros,
            actual_cost_micros, failure_reason, retry_count, human_score, git_commit)
         VALUES (?, ?, 1, 'admin', ?, ?, ?, 'seedance-relay', 'Seedance 2.0 Fast',
                 'doubao-seedance-2-0-fast', NULL, ?, 'v1.0.0 (S3 真实样例)',
                 ?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?)`
      ).run(
        id,
        sample.sampleId,
        Date.now() - generationDurationMs,
        Date.now(),
        Math.round(generationDurationMs / Math.max(1, shotStates.length)),
        s.videoUrl ? `第${s.shotIndex}镜 prompt（样例 ${sample.sampleId}）` : null,
        s.videoUrl || null,
        s.status === 'completed' ? 'present' : 'missing',
        s.status === 'completed' ? 'verified' : null,
        s.semanticVerdict || null,
        s.status === 'completed' ? 100_000 : null,
        s.failureReason || null,
        s.autoFixCount || 0,
        gitCommit
      );
    }
    db.close();
    log('golden-runs', `${shotStates.length} 条真实运行记录已写入 golden_runs（人工评分待评审录入）`);
  } catch (e) {
    evidence.errors.push(`golden_runs 写入失败: ${e.message}`);
    console.warn('golden_runs 写入失败:', e.message);
  }
}

main().catch(async (e) => {
  console.error('Demo 失败:', e);
  writeFileSync(path.join(demoRoot, `${sample.sampleId}-evidence.json`), JSON.stringify(evidence, null, 2));
  await stopServer().catch(() => {});
  process.exit(1);
});
