/**
 * S1 黄金集评测命令（一条命令生成黄金集报告）：
 *
 *   npm run eval:golden                      # 评测 + 与基线对比 + 输出 JSON/Markdown/HTML
 *   npm run eval:golden -- --write-baseline  # 把本次结果固化为基线（评审确认后执行）
 *   npm run eval:golden -- --baseline <path> # 指定对比基线
 *   npm run eval:golden -- --runs 5          # 每次样本运行 5 次（默认 3）
 *   npm run eval:golden -- --sample skincare-hero-1   # 只跑指定样本
 *   npm run eval:golden -- --manual skincare-hero-1:product_consistency:0.9:评审人A
 *   npm run eval:golden -- --inject=degrade          # 失败注入：加权质量下降 >5% → 退出码 1
 *   npm run eval:golden -- --inject=hard-gate        # 失败注入：hard gate 回归 → 退出码 1
 *   npm run eval:golden -- --inject=missing-sample   # 失败注入：样本缺失 → 退出码 1
 *   npm run eval:golden -- --strict-unverified       # 未验证样本也视为阻断
 *
 * 退出码：0 = 通过；1 = 回归阻断/门禁失败；2 = 用法错误。
 * 全部使用 synthetic scorer + fixture，不触发任何真实付费 provider 调用。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  GOLDEN_EVAL_VERSION,
  compareToBaseline,
  currentGitCommit,
  runGoldenEval,
  type GoldenReport,
  type ManualScoreInput,
} from '../server/lib/golden-eval';
import { GOLDEN_SET_VERSION, loadGoldenSamples } from '../shared/golden-sample';
import { DIMENSION_LABELS, type ScoreDimensionId } from '../shared/scorecard';

const DEFAULT_RUNS = 3;
const OUT_DIR = path.join(process.cwd(), 'test-results', 'golden-report');
const DEFAULT_BASELINE = path.join(OUT_DIR, 'baseline.json');
const FIXTURE_BASELINE = path.join(process.cwd(), 'server', 'test', 'fixtures', 'golden-baseline.json');

interface CliOptions {
  runs: number;
  baselinePath?: string;
  writeBaseline: boolean;
  inject?: 'degrade' | 'hard-gate' | 'missing-sample';
  manual: ManualScoreInput[];
  sampleIds?: string[];
  strictUnverified: boolean;
  outDir: string;
}

function usage(): never {
  console.error(`用法: npm run eval:golden -- [选项]
  --runs N                  每个样本运行次数（默认 ${DEFAULT_RUNS}）
  --sample <id>             只评测指定样本（可重复）
  --baseline <path>         对比指定基线 JSON（显式传参；不传时使用仓库 fixture）
  --write-baseline          把本次结果写入 ${DEFAULT_BASELINE}（评审通过后手动固化到 fixture）
  --inject=degrade          失败注入：加权质量下降（演示回归阻断）
  --inject=hard-gate        失败注入：hard gate 回归（演示阻断）
  --inject=missing-sample   失败注入：样本缺失（演示阻断）
  --manual <sample:dim:value:reviewer>   人工评分合并（评审人直接录入，非匿名盲测；可重复）
  --strict-unverified       未验证样本视为阻断（严苛模式）
  --out <dir>               报告输出目录（默认 ${OUT_DIR}）`);
  process.exit(2);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    runs: DEFAULT_RUNS,
    writeBaseline: false,
    manual: [],
    strictUnverified: false,
    outDir: OUT_DIR,
  };
  const samples: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--runs') {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 1) usage();
      options.runs = Math.min(20, Math.floor(n));
    } else if (arg === '--sample') {
      samples.push(argv[++i]);
    } else if (arg === '--baseline') {
      options.baselinePath = argv[++i];
    } else if (arg === '--write-baseline') {
      options.writeBaseline = true;
    } else if (arg === '--strict-unverified') {
      options.strictUnverified = true;
    } else if (arg === '--out') {
      options.outDir = argv[++i];
    } else if (arg.startsWith('--inject=')) {
      const kind = arg.slice('--inject='.length);
      if (kind !== 'degrade' && kind !== 'hard-gate' && kind !== 'missing-sample') usage();
      options.inject = kind;
    } else if (arg === '--manual') {
      const spec = argv[++i];
      const parts = spec.split(':');
      if (parts.length < 3 || parts.length > 4) usage();
      const [sampleId, dimId, valueStr] = parts;
      const reviewer = parts[3] ?? 'anonymous';
      const value = Number(valueStr);
      if (!(dimId in DIMENSION_LABELS) || !Number.isFinite(value)) usage();
      options.manual.push({
        sampleId,
        id: dimId as ScoreDimensionId,
        value: Math.max(0, Math.min(1, value)),
        reviewer,
      });
    } else if (arg === '--help' || arg === '-h') {
      usage();
    } else {
      usage();
    }
  }
  if (samples.length > 0) options.sampleIds = samples;
  return options;
}

// ---------------------------------------------------------------- markdown

function fmtPct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

/**
 * 时间戳展示（审查 P2-4：评测结果默认确定性，timestamp=0 表示确定性 epoch；
 * 真实生成时间只在控制台输出，不进 JSON/MD/HTML）。
 */
function fmtClock(ts: number): string {
  return ts === 0 ? '确定性 epoch（评测结果可逐字节复现）' : new Date(ts).toISOString();
}

function fmtDelta(pct: number | null): string {
  if (pct === null) return '—';
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
}

function renderMarkdown(report: GoldenReport, baselineCompare: ReturnType<typeof compareToBaseline> | null): string {
  const L: string[] = [];
  L.push(`# 黄金样本集评测报告 v1`);
  L.push('');
  L.push(`> 生成时间：${fmtClock(report.timestamp)}`);
  L.push(`> 评测引擎：${report.generator} ${report.generatorVersion} · 黄金集 ${GOLDEN_SET_VERSION}`);
  L.push(`> prompt ${report.promptVersion} · pipeline ${report.pipelineVersion} · git ${report.gitCommit} · 评分卡 ${report.scorecardVersion} · 账本 ${report.ledgerVersion}`);
  L.push(`> 样本 ${report.stats.sampleCount} · 运行 ${report.stats.runCount} 次（每次 ${report.runsPerSample} 次/样本）`);
  L.push('');
  L.push(`> ⚠️ ${report.note}`);
  L.push('');
  L.push(`## 0. 结论`);
  L.push('');
  if (baselineCompare) {
    L.push(`对比基线：\`${baselineCompare.baselinePath}\`（版本 ${baselineCompare.baselineVersion}）`);
    L.push('');
    if (baselineCompare.ok) {
      L.push(`**✅ 通过** — 无加权质量下降（>${baselineCompare.weightedDeclinePct === null ? 5 : Math.abs(baselineCompare.weightedDeclinePct).toFixed(2)}%）、无 hard gate 回归、无样本缺失。`);
    } else {
      L.push(`**❌ 阻断** — 以下原因：`);
      for (const r of baselineCompare.reasons) L.push(`- ${r}`);
    }
    L.push('');
    L.push(`- 加权分总体变化：${fmtDelta(baselineCompare.weightedDeclinePct)}`);
    L.push(`- 样本缺失：${baselineCompare.missingSamples.join(', ') || '无'}`);
    L.push(`- 评分缺失：${baselineCompare.scoreMissing.join(', ') || '无'}`);
    L.push(`- 未验证样本（不静默）：${baselineCompare.unverifiedSamples.join(', ') || '无'}`);
    L.push(`- hard gate 回归：${baselineCompare.hardGateRegressions.length} 项`);
    L.push(`- 逐维度下降（>5%）：${baselineCompare.declines.length} 项`);
    L.push('');
    for (const d of baselineCompare.declines) {
      L.push(`  - ${d.sampleId}/${DIMENSION_LABELS[d.dimension]}：${fmtPct(d.baseline)} → ${fmtPct(d.current)}（${d.deltaPct.toFixed(2)}%）`);
    }
  } else {
    L.push(`**未对比基线**（首次运行或未提供基线）；` +
      `使用 \`--write-baseline\` 固化基线后，后续运行将执行回归阻断。`);
    L.push('');
  }
  if (report.warnings.length > 0) {
    L.push(`⚠️ 报告级警告：`);
    for (const w of report.warnings) L.push(`- ${w}`);
    L.push('');
  }

  L.push(`## 1. 样本摘要`);
  L.push('');
  L.push(`| 样本 | 产品 | 类型 | 加权均值 | 方差 | 状态 | 人工基准 |`);
  L.push(`|---|---|---|---|---|---|---|`);
  for (const s of report.samples) {
    const status = s.runs.every((r) => r.status === 'unverified')
      ? 'unverified'
      : s.runs.some((r) => r.status === 'failed')
        ? 'failed'
        : 'measured';
    L.push(`| ${s.name}（${s.id}） | ${s.product} | ${s.synthetic ? 'synthetic/placeholder' : 'real'} | ${s.stats.mean.toFixed(3)} | ${s.stats.variance.toFixed(5)} | ${status} | ${s.manualBaseline} |`);
  }
  L.push('');

  L.push(`## 2. 成本与耗时账本`);
  L.push('');
  L.push(`- 账本条目：${report.costSummary.entries}`);
  L.push(`- 估算成本合计：${report.costSummary.estimatedUsd === 'unknown' ? 'unknown' : `$${report.costSummary.estimatedUsd.toFixed(2)}`}`);
  L.push(`- 实际成本合计：${report.costSummary.actualUsd === 'unknown' ? 'unknown（无真实付费调用，一律不写 0）' : `$${report.costSummary.actualUsd.toFixed(2)}`}`);
  L.push(`- 未知成本条目：${report.costSummary.unknownCount}`);
  L.push(`- 按 provider：${report.costSummary.byProvider.map((p) => `${p.provider} × ${p.runs}（实际 ${p.actualUsd === 'unknown' ? 'unknown' : `$${p.actualUsd}`}）`).join('；') || '无'}`);
  L.push(`- 按模型：${report.costSummary.byModel.map((m) => `${m.model}@${m.modelVersion} × ${m.runs}`).join('；') || '无'}`);
  L.push('');

  for (const s of report.samples) {
    L.push(`### ${s.name}（${s.id}）`);
    L.push('');
    L.push(`- 产品素材：\`${s.productAssetUrl}\``);
    L.push(`- 原始爆款参考：\`${s.referenceUrl}\``);
    L.push(`- 替换目标：\`${s.targetUrl || 'N/A'}\``);
    L.push(`- 允许保留项：${s.allowedItems ? s.allowedItems.join('、') : '—'} · 禁止项：${s.prohibitedItems ? s.prohibitedItems.join('、') : '—'}`);
    L.push(`- provider/model/version/seed：${s.provider} / ${s.model} / ${s.version} / seed=${s.seed}`);
    L.push(`- prompt 版本：${s.promptVersion}`);
    L.push(`- provenance：${s.provenance.source}（${s.provenance.note}）`);
    L.push(`- 运行 ${s.stats.runs} 次 · 加权均值 ${s.stats.mean.toFixed(3)} · 方差 ${s.stats.variance.toFixed(5)} · min ${s.stats.min.toFixed(3)} / max ${s.stats.max.toFixed(3)}`);
    if (s.warnings.length > 0) {
      L.push(`- ⚠️ 样本警告：${s.warnings.join('；')}`);
    }
    L.push('');
    L.push(`**每次运行结果**`);
    L.push('');
    L.push(`| 运行 | seed | 加权分 | 状态 | 产物 | 耗时 ms | 估算成本 | 实际成本 |`);
    L.push(`|---|---|---|---|---|---|---|---|`);
    for (const r of s.runs) {
      L.push(`| ${r.id} | ${r.seed} | ${r.scorecard.weighted.value.toFixed(3)} | ${r.status} | \`${r.artifactUrl}\`（${r.artifactStatus}） | ${r.durationMs} | ${r.cost.estimatedUsd === 'unknown' ? 'unknown' : `$${r.cost.estimatedUsd}`} | ${r.cost.actualUsd === 'unknown' ? 'unknown' : `$${r.cost.actualUsd}`} |`);
    }
    L.push('');
    L.push(`**逐项评分（均值）与 evidence/confidence**`);
    L.push('');
    L.push(`| 维度 | 层 | 均值 | 状态 | confidence | scorer | evidence |`);
    L.push(`|---|---|---|---|---|---|---|`);
    for (const dim of s.runs[0]?.scorecard.dimensions ?? []) {
      const run0 = s.runs[0].scorecard.dimensions.find((d) => d.id === dim.id);
      const mean = s.stats.perDimensionMean[dim.id];
      const evidenceText = run0?.evidence.map((e) => `${e.source}: ${e.detail}`).join('<br>') || '—';
      L.push(`| ${DIMENSION_LABELS[dim.id]}（${dim.id}） | ${dim.layer} | ${(mean ?? 0).toFixed(3)} | ${run0?.status} | ${run0?.confidence} | ${run0?.scorer}@${run0?.scorerVersion} | ${evidenceText} |`);
    }
    L.push('');
    L.push(`**Blockers / Warnings / Unverified**`);
    L.push('');
    if (s.gateSummary.blockers.length === 0 && s.gateSummary.warnings.length === 0 && s.gateSummary.hardGatesUnverified.length === 0) {
      L.push('（无）');
    } else {
      for (const b of s.gateSummary.blockers) {
        const ev = s.runs[0]?.gate?.blockerEvidence?.[b.code];
        L.push(`- ✗ **${b.code}**：${b.detail}${ev ? `（证据：${ev.source} — ${ev.detail}）` : ''}`);
      }
      for (const w of s.gateSummary.warnings) {
        const ev = s.runs[0]?.gate?.warningEvidence?.[w.code];
        L.push(`- ○ ${w.code}：${w.detail}${ev ? `（证据：${ev.source} — ${ev.detail}）` : ''}`);
      }
      // hardGatesUnverified 已在 hard_gate_unverified:* warning 中逐项列出（含证据），不重复
    }
    L.push('');
  }

  L.push(`## 3. 总体统计`);
  L.push('');
  L.push(`- 总体加权均值：${report.stats.overallMean === null ? '—' : report.stats.overallMean.toFixed(4)}`);
  L.push(`- 总体方差：${report.stats.overallVariance === null ? '—' : report.stats.overallVariance.toFixed(6)}`);
  L.push(`- measured runs：${report.stats.measuredRuns} · unverified runs：${report.stats.unverifiedRuns} · failed runs：${report.stats.failedRuns}`);
  L.push('');
  L.push(`## 4. 版本信息`);
  L.push('');
  L.push(`- 黄金集：${GOLDEN_SET_VERSION} · 评测引擎：${GOLDEN_EVAL_VERSION} · 评分卡：${report.scorecardVersion} · 账本：${report.ledgerVersion}`);
  L.push(`- prompt：${report.promptVersion} · pipeline：${report.pipelineVersion} · git commit：${report.gitCommit}`);
  L.push('');
  return L.join('\n');
}

// ---------------------------------------------------------------- html

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function renderHtml(report: GoldenReport, baselineCompare: ReturnType<typeof compareToBaseline> | null): string {
  const statusColor = (status: string) =>
    status === 'measured' || status === 'passed' ? '#10b981' :
    status === 'unverified' ? '#f59e0b' :
    status === 'failed' ? '#ef4444' : '#94a3b8';

  const rows: string[] = [];
  for (const s of report.samples) {
    const dimRows = (s.runs[0]?.scorecard.dimensions ?? [])
      .map((dim) => {
        const mean = s.stats.perDimensionMean[dim.id];
        return `<tr>
          <td>${esc(DIMENSION_LABELS[dim.id])}<br><code>${esc(dim.id)}</code></td>
          <td>${esc(dim.layer)}</td>
          <td style="color:${statusColor(dim.status)}">${(mean ?? 0).toFixed(3)}</td>
          <td style="color:${statusColor(dim.status)}">${esc(dim.status)}</td>
          <td>${esc(dim.confidence)}</td>
          <td>${esc(dim.scorer)}@${esc(dim.scorerVersion)}</td>
          <td class="small">${dim.evidence.map((e) => esc(`${e.source}: ${e.detail}`)).join('<br>')}</td>
        </tr>`;
      })
      .join('');

    const runRows = s.runs
      .map((r) => `<tr>
        <td>${esc(r.id)}</td>
        <td>${esc(r.seed)}</td>
        <td>${r.scorecard.weighted.value.toFixed(3)}</td>
        <td style="color:${statusColor(r.status)}">${esc(r.status)}</td>
        <td class="small"><code>${esc(r.artifactUrl)}</code> (${esc(r.artifactStatus)})</td>
        <td>${esc(r.durationMs)}</td>
        <td>${r.cost.estimatedUsd === 'unknown' ? 'unknown' : `$${r.cost.estimatedUsd}`}</td>
        <td>${r.cost.actualUsd === 'unknown' ? 'unknown' : `$${r.cost.actualUsd}`}</td>
      </tr>`)
      .join('');

    const blockerHtml = s.gateSummary.blockers.length === 0 && s.gateSummary.warnings.length === 0 && s.gateSummary.hardGatesUnverified.length === 0
      ? '<span class="small">（无）</span>'
      : [
          ...s.gateSummary.blockers.map((b) => {
            const ev = s.runs[0]?.gate?.blockerEvidence?.[b.code];
            return `<div class="badge bad">✗ <b>${esc(b.code)}</b>：${esc(b.detail)}<div class="small muted">证据：${esc(ev?.source ?? '')} — ${esc(ev?.detail ?? b.code)}</div></div>`;
          }),
          ...s.gateSummary.warnings.map((w) => {
            const ev = s.runs[0]?.gate?.warningEvidence?.[w.code];
            return `<div class="badge warn">○ <b>${esc(w.code)}</b>：${esc(w.detail)}<div class="small muted">证据：${esc(ev?.source ?? '')} — ${esc(ev?.detail ?? w.code)}</div></div>`;
          }),
        ].join('');

    rows.push(`
    <h2>${esc(s.name)} <code>${esc(s.id)}</code>
      <span class="pill" style="background:${s.synthetic ? '#f59e0b' : '#10b981'}">${s.synthetic ? 'synthetic/placeholder' : 'real'}</span>
    </h2>
    <p class="small muted">产品：${esc(s.product)} · provider/model/version/seed：${esc(s.provider)} / ${esc(s.model)} / ${esc(s.version)} / seed=${esc(s.seed)} · prompt ${esc(s.promptVersion)}<br>
    参考：<code>${esc(s.referenceUrl)}</code> · 目标：<code>${esc(s.targetUrl ?? 'N/A')}</code><br>
    允许保留：${esc(s.allowedItems?.join('、') ?? '—')} · 禁止：${esc(s.prohibitedItems?.join('、') ?? '—')}<br>
    人工基准：${esc(s.manualBaseline)}<br>
    provenance：${esc(s.provenance.source)} — ${esc(s.provenance.note)}</p>
    ${s.warnings.map((w) => `<div class="badge warn">⚠ ${esc(w)}</div>`).join('')}
    <h3>每次运行</h3>
    <table><tr><th>运行</th><th>seed</th><th>加权分</th><th>状态</th><th>产物</th><th>耗时 ms</th><th>估算成本</th><th>实际成本</th></tr>${runRows}</table>
    <h3>逐项评分（均值）· evidence · confidence</h3>
    <table><tr><th>维度</th><th>层</th><th>均值</th><th>状态</th><th>confidence</th><th>scorer/version</th><th>evidence</th></tr>${dimRows}</table>
    <h3>Blockers / Warnings / Unverified</h3>
    ${blockerHtml}
    <p class="small muted">加权均值 ${s.stats.mean.toFixed(3)} · 方差 ${s.stats.variance.toFixed(5)} · min ${s.stats.min.toFixed(3)} / max ${s.stats.max.toFixed(3)} · 运行 ${s.stats.runs} 次</p>
    `);
  }

  let baselineHtml = '<p class="small muted">未对比基线（首次运行或未提供基线）；使用 <code>--write-baseline</code> 固化基线后执行回归阻断。</p>';
  if (baselineCompare) {
    const verdict = baselineCompare.ok
      ? '<div class="badge ok">✅ 通过：无加权下降（&gt;5%）、无 hard gate 回归、无样本缺失</div>'
      : `<div class="badge bad">❌ 阻断</div><ul>${baselineCompare.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`;
    baselineHtml = `<p class="small muted">基线：<code>${esc(baselineCompare.baselinePath)}</code>（${esc(baselineCompare.baselineVersion)}，${esc(fmtClock(baselineCompare.baselineTimestamp))}）</p>
    ${verdict}
    <p class="small">加权分总体变化：<b>${esc(fmtDelta(baselineCompare.weightedDeclinePct))}</b> · 样本缺失：${esc(baselineCompare.missingSamples.join(', ') || '无')} · 评分缺失：${esc(baselineCompare.scoreMissing.join(', ') || '无')} · 未验证样本：${esc(baselineCompare.unverifiedSamples.join(', ') || '无')} · hard gate 回归：${baselineCompare.hardGateRegressions.length} · 维度下降：${baselineCompare.declines.length}</p>`;
  }

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>黄金样本集评测报告</title>
<style>
  body { font-family: system-ui, -apple-system, "PingFang SC", sans-serif; background:#0f172a; color:#e2e8f0; margin:0; padding:24px; }
  h1 { color:#a78bfa; } h2 { color:#c4b5fd; border-bottom:1px solid #334155; padding-bottom:6px; margin-top:32px; } h3 { color:#94a3b8; font-size:14px; }
  table { border-collapse: collapse; width:100%; margin:8px 0 16px; font-size:12px; }
  th { background:#1e293b; text-align:left; padding:6px 8px; color:#94a3b8; }
  td { border-bottom:1px solid #1e293b; padding:6px 8px; vertical-align: top; }
  code { background:#1e293b; padding:1px 5px; border-radius:4px; color:#fbbf24; font-size:11px; }
  .badge { display:inline-block; margin:2px 4px 2px 0; padding:4px 8px; border-radius:6px; font-size:12px; }
  .ok { background:#064e3b; color:#6ee7b7; } .bad { background:#7f1d1d; color:#fecaca; }
  .warn { background:#78350f; color:#fde68a; }
  .pill { display:inline-block; padding:2px 8px; border-radius:999px; color:#0f172a; font-size:11px; vertical-align:middle; }
  .small { font-size:11px; } .muted { color:#64748b; }
  .notice { background:#78350f; color:#fde68a; padding:10px 14px; border-radius:8px; margin:12px 0; }
</style></head><body>
<h1>黄金样本集评测报告 v1</h1>
<p class="small muted">生成：${esc(fmtClock(report.timestamp))} · 引擎 ${report.generator} ${report.generatorVersion} · 黄金集 ${GOLDEN_SET_VERSION} · 评分卡 ${report.scorecardVersion} · 账本 ${report.ledgerVersion}<br>
prompt ${esc(report.promptVersion)} · pipeline ${report.pipelineVersion} · git ${esc(report.gitCommit)} · 样本 ${report.stats.sampleCount} · 运行 ${report.stats.runCount} 次</p>
<div class="notice">⚠ ${esc(report.note)}</div>
<h2>结论</h2>
${baselineHtml}
<h2>样本</h2>
${rows.join('')}
<h2>成本与耗时</h2>
<p class="small">条目 ${report.costSummary.entries} · 估算合计 ${report.costSummary.estimatedUsd === 'unknown' ? 'unknown' : `$${report.costSummary.estimatedUsd}`} · 实际合计 ${report.costSummary.actualUsd === 'unknown' ? 'unknown（无真实付费调用，不写 0）' : `$${report.costSummary.actualUsd}`} · 未知条目 ${report.costSummary.unknownCount}<br>
按 provider：${report.costSummary.byProvider.map((p) => `${esc(p.provider)} × ${p.runs}`).join('；') || '无'}</p>
<h2>总体统计</h2>
<p class="small">均值 ${report.stats.overallMean === null ? '—' : report.stats.overallMean.toFixed(4)} · 方差 ${report.stats.overallVariance === null ? '—' : report.stats.overallVariance.toFixed(6)} · measured ${report.stats.measuredRuns} / unverified ${report.stats.unverifiedRuns} / failed ${report.stats.failedRuns}</p>
</body></html>`;
}

// ---------------------------------------------------------------- main

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  const injectConfig = {
    degradeWeightedBy: options.inject === 'degrade' ? 0.1 : undefined,
    failHardGate: options.inject === 'hard-gate' ? ('black_frame' as ScoreDimensionId) : undefined,
    dropSampleId: options.inject === 'missing-sample' ? loadGoldenSamples()[0].id : undefined,
  };

  const report = await runGoldenEval({
    runsPerSample: options.runs,
    sampleIds: options.sampleIds,
    manualScores: options.manual,
    pipelineVersion: 'v1.0.0',
    gitCommit: currentGitCommit(),
    ...injectConfig,
  });

  // 基线解析（审查 P1-7）：--baseline 显式传参 > 仓库 fixture（版本库内，可复现）。
  // 本机 test-results 残留的 ignored baseline 绝不在默认路径自动读取——
  // 「一条默认命令可复现」必须不受开发者本机隐藏状态影响；本地覆盖必须显式传参。
  let baselinePath: string | undefined = options.baselinePath;
  if (!baselinePath && fs.existsSync(FIXTURE_BASELINE)) baselinePath = FIXTURE_BASELINE;

  let baseline: GoldenReport | undefined;
  if (baselinePath) {
    baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as GoldenReport;
  }

  const baselineCompare = baseline ? compareToBaseline(report, baseline, { baselinePath, strictUnverified: options.strictUnverified }) : null;

  // 机器可读报告内嵌基线对比结果（与基线差异必须进 JSON，不能只在人读格式里）
  const reportWithBaseline: GoldenReport = {
    ...report,
    baseline: baselineCompare ?? undefined,
  };

  fs.mkdirSync(options.outDir, { recursive: true });
  const jsonPath = path.join(options.outDir, 'golden-report.json');
  const mdPath = path.join(options.outDir, 'golden-report.md');
  const htmlPath = path.join(options.outDir, 'golden-report.html');
  fs.writeFileSync(jsonPath, JSON.stringify(reportWithBaseline, null, 2));
  fs.writeFileSync(mdPath, renderMarkdown(report, baselineCompare));
  fs.writeFileSync(htmlPath, renderHtml(report, baselineCompare));

  if (options.writeBaseline) {
    const target = options.baselinePath ?? DEFAULT_BASELINE;
    fs.writeFileSync(target, JSON.stringify(report, null, 2));
    console.log(`✔ 基线已写入 ${target}`);
  }

  // 控制台摘要（真实时钟只进控制台，不进 JSON/MD/HTML —— 保持评测结果确定性，审查 P2-4）
  console.log(`黄金集评测完成（真实时钟 ${new Date().toISOString()}）：${report.stats.sampleCount} 样本 × ${report.runsPerSample} 次 = ${report.stats.runCount} 次运行`);
  console.log(`  总体加权均值 ${report.stats.overallMean === null ? '—' : report.stats.overallMean.toFixed(4)} · 方差 ${report.stats.overallVariance === null ? '—' : report.stats.overallVariance.toFixed(6)}`);
  console.log(`  成本：估算 ${report.costSummary.estimatedUsd === 'unknown' ? 'unknown' : `$${report.costSummary.estimatedUsd}`} · 实际 ${report.costSummary.actualUsd === 'unknown' ? 'unknown' : `$${report.costSummary.actualUsd}`}（未知条目 ${report.costSummary.unknownCount}）`);
  if (report.stats.unverifiedRuns > 0) {
    console.log(`  ⚠ ${report.stats.unverifiedRuns} 次运行未验证（synthetic fixture），不构成真实质量结论`);
  }
  console.log(`报告：`);
  console.log(`  ${jsonPath}`);
  console.log(`  ${mdPath}`);
  console.log(`  ${htmlPath}`);

  if (baselineCompare) {
    console.log('');
    console.log(`基线对比（${baselineCompare.baselinePath}）：`);
    console.log(`  加权分变化 ${fmtDelta(baselineCompare.weightedDeclinePct)} · 样本缺失 ${baselineCompare.missingSamples.length} · 评分缺失 ${baselineCompare.scoreMissing.length} · hard gate 回归 ${baselineCompare.hardGateRegressions.length} · 维度下降 ${baselineCompare.declines.length}`);
    if (baselineCompare.unverifiedSamples.length > 0) {
      console.log(`  ⚠ 未验证样本（不静默）：${baselineCompare.unverifiedSamples.join(', ')}`);
    }
    if (!baselineCompare.ok) {
      console.log('');
      console.log('❌ 回归阻断，原因：');
      for (const r of baselineCompare.reasons) console.log(`  - ${r}`);
    }
  } else {
    console.log('');
    console.log(`提示：首次运行未对比基线。评审通过后用 --write-baseline 固化基线，此后自动回归阻断。`);
    console.log(`      仓库自带基线 fixture：${FIXTURE_BASELINE}`);
  }

  return baselineCompare && !baselineCompare.ok ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error('黄金集评测失败：', error);
    process.exitCode = 2;
  });
