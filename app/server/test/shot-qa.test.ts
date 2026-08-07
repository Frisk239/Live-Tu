/**
 * S1 shot-qa 假确定性修复测试：
 * - 黑帧时长统计必须是 black_end - black_start（旧实现累加 black_end 是启发式误差）；
 * - 无法探测（远端 URL / 本地文件缺失 / 时长未知）→ status=unverified 且 ok=false，不得默认 ok=true；
 * - 纯解析函数可离线单测，不依赖 ffmpeg。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseBlackDetectOutput,
  parseDurationFromOutput,
  qaShotVideo,
} from '../lib/shot-qa';

test('黑帧解析：黑帧时长 = black_end - black_start（回归：旧实现累加 black_end）', () => {
  // 两段黑帧：0.5→2.5（2s）和 4.0→5.0（1s），总黑帧 3s；总时长 10s
  const output = [
    'Duration: 00:00:10.00, start: 0.000000, bitrate: 1000 kb/s',
    'black_start:0.5 black_end:2.5 black_duration:2.0',
    'black_start:4 black_end:5 black_duration:1',
  ].join('\n');
  const parsed = parseBlackDetectOutput(output);
  assert.equal(parsed.totalSec, 10);
  assert.equal(parsed.blackSec, 3, '黑帧总时长必须按 end-start 计算，不能累加 black_end（2.5+5=7.5 是错的）');
  assert.equal(parsed.ratio, 0.3);
  assert.equal(parsed.segments.length, 2);
  assert.equal(parsed.segments[0].duration, 2);
  assert.equal(parsed.segments[1].duration, 1);
});

test('黑帧解析：无黑帧 → blackSec=0，ratio=0', () => {
  const parsed = parseBlackDetectOutput('Duration: 00:00:05.00, start: 0.000000');
  assert.equal(parsed.totalSec, 5);
  assert.equal(parsed.blackSec, 0);
  assert.equal(parsed.ratio, 0);
});

test('黑帧解析：时长未知 → totalSec=0，ratio=0（调用方必须 unverified 而不是 ok）', () => {
  const parsed = parseBlackDetectOutput('black_start:0.5 black_end:1.5');
  assert.equal(parsed.totalSec, 0);
  assert.equal(parsed.blackSec, 1);
  assert.equal(parsed.ratio, 0);
});

test('时长解析：HH:MM:SS.xx 格式', () => {
  assert.equal(parseDurationFromOutput('Duration: 00:01:02.50, start: 0'), 62.5);
  assert.equal(parseDurationFromOutput('no duration here'), 0);
});

test('远端 URL 无法探测：status=unverified 且 ok=false（不得默认 ok=true）', async () => {
  const result = await qaShotVideo('https://example.com/remote/video.mp4');
  assert.equal(result.status, 'unverified');
  assert.equal(result.ok, false);
  assert.ok(result.reason);
  assert.ok(result.checks.some((c) => c.status === 'unverified'));
});

test('本地产物不存在：status=unverified 且 ok=false', async () => {
  const result = await qaShotVideo('/uploads/renders/does-not-exist-xyz.mp4');
  assert.equal(result.status, 'unverified');
  assert.equal(result.ok, false);
});

test('空 URL：status=unverified 且 ok=false', async () => {
  const result = await qaShotVideo('');
  assert.equal(result.status, 'unverified');
  assert.equal(result.ok, false);
});
