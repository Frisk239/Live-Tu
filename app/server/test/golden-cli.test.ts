/**
 * S1 CLI 级回归阻断测试：直接执行 scripts/eval-golden.ts，验证命令退出码契约。
 * - 正常评测（对比仓库 fixture 基线）→ exit 0；
 * - 加权下降 >5% 注入 → exit 1（非零）；
 * - hard gate 回归注入 → exit 1（非零）；
 * - 样本缺失注入 → exit 1（非零）；
 * - 生成 JSON/Markdown/HTML 三种格式。
 * 全程 synthetic，无真实 provider 调用；报告输出到临时目录，不污染仓库。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();
const FIXTURE_BASELINE = path.join(root, 'server', 'test', 'fixtures', 'golden-baseline.json');

function runCli(args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--no-warnings', '--import', 'tsx', path.join(root, 'scripts', 'eval-golden.ts'), ...args],
      { cwd: root, env: { ...process.env, GOLDEN_TEST: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, output }));
  });
}

test('CLI：正常评测对比 fixture 基线 → exit 0，且三种报告格式齐全', async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), 'golden-cli-ok-'));
  const { code, output } = await runCli(['--baseline', FIXTURE_BASELINE, '--out', outDir]);
  assert.equal(code, 0, `应退出 0：\n${output}`);
  for (const f of ['golden-report.json', 'golden-report.md', 'golden-report.html']) {
    assert.ok(existsSync(path.join(outDir, f)), `${f} 必须生成`);
  }
  const json = JSON.parse(readFileSync(path.join(outDir, 'golden-report.json'), 'utf8'));
  assert.equal(json.stats.sampleCount, 11, '8 synthetic + 3 真实样例');
  assert.equal(json.stats.runCount, 33);
  assert.ok(json.costSummary.actualUsd === 'unknown', '实际成本必须 unknown');
  const files = readdirSync(outDir);
  assert.ok(files.some((f) => f.endsWith('.md')));
});

test('CLI：加权下降 >5% 注入 → exit 1（回归阻断）', async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), 'golden-cli-degrade-'));
  const { code, output } = await runCli(['--baseline', FIXTURE_BASELINE, '--out', outDir, '--inject=degrade']);
  assert.equal(code, 1, `加权下降必须非零退出：\n${output}`);
  assert.ok(output.includes('加权质量下降'), '输出必须说明阻断原因');
});

test('CLI：hard gate 回归注入 → exit 1（回归阻断）', async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), 'golden-cli-gate-'));
  const { code, output } = await runCli(['--baseline', FIXTURE_BASELINE, '--out', outDir, '--inject=hard-gate']);
  assert.equal(code, 1, `hard gate 回归必须非零退出：\n${output}`);
  assert.ok(output.includes('hard gate 回归'), '输出必须说明 hard gate 回归');
});

test('CLI：样本缺失注入 → exit 1（不得静默通过）', async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), 'golden-cli-missing-'));
  const { code, output } = await runCli(['--baseline', FIXTURE_BASELINE, '--out', outDir, '--inject=missing-sample']);
  assert.equal(code, 1, `样本缺失必须非零退出：\n${output}`);
  assert.ok(output.includes('样本缺失'), '输出必须说明样本缺失');
});
