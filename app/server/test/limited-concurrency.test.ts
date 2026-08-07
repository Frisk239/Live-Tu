/**
 * S3 limited-concurrency + real-demo-sample（manifest 校验）测试：
 * - 受限并发：并发上限、allSettled 语义（单元素失败不中断）、顺序稳定、独立超时；
 * - 真实样例 fixture：真实 URL 断言（无 loremflickr）、manifest 校验确定性（注入 fetchFn）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mapWithConcurrency } from '../lib/limited-concurrency';
import {
  REAL_DEMO_SAMPLE,
  verifyRealDemoManifest,
} from '../../shared/real-demo-sample';

test('mapWithConcurrency: 受限并发不超限，结果顺序稳定', async () => {
  let active = 0;
  let maxActive = 0;
  const items = [1, 2, 3, 4, 5];
  const results = await mapWithConcurrency(items, 2, async (n) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 20));
    active -= 1;
    return n * 2;
  });
  assert.equal(maxActive, 2, `并发不得超过 2，实际 ${maxActive}`);
  assert.deepEqual(
    results.map((r) => (r.status === 'fulfilled' ? r.value : null)),
    [2, 4, 6, 8, 10],
    '结果必须按输入顺序返回'
  );
  assert.ok(results.every((r) => r.status === 'fulfilled'));
});

test('mapWithConcurrency: allSettled 语义——单元素失败不中断其他元素', async () => {
  const results = await mapWithConcurrency([1, 2, 3, 4], 2, async (n) => {
    await new Promise((r) => setTimeout(r, 10));
    if (n === 2) throw new Error('boom-2');
    return n;
  });
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3);
  assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
  const rejected = results.find((r) => r.status === 'rejected') as any;
  assert.match(String(rejected.reason?.message || rejected.reason), /boom-2/);
});

test('mapWithConcurrency: 单元素独立超时（timedOut 标记，不影响其他元素）', async () => {
  const results = await mapWithConcurrency(
    [1, 2, 3],
    2,
    async (n) => {
      await new Promise((r) => setTimeout(r, n === 2 ? 200 : 5));
      return n;
    },
    { timeoutMs: 50 }
  );
  const slow = results[1];
  assert.equal(slow.status, 'rejected');
  assert.equal((slow as any).timedOut, true);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[2].status, 'fulfilled');
});

test('真实样例 fixture：使用目标真实 URL，不包含 loremflickr/unsplash', () => {
  assert.equal(
    REAL_DEMO_SAMPLE.referenceVideoUrl,
    'http://64.83.1.104/live-tu-assets/viral/viral-reference-01.mp4'
  );
  assert.deepEqual(REAL_DEMO_SAMPLE.productAssetUrls, [
    'http://64.83.1.104/live-tu-assets/products/buv-product-front.png',
  ]);
  const json = JSON.stringify(REAL_DEMO_SAMPLE).toLowerCase();
  assert.ok(!json.includes('loremflickr'), '禁止 loremflickr');
  assert.ok(!json.includes('unsplash'), '禁止 unsplash');
  // manifest 期望条目（大小 + SHA-256）
  assert.equal(REAL_DEMO_SAMPLE.manifestExpectations.length, 2);
  assert.equal(REAL_DEMO_SAMPLE.manifestExpectations[0].size, 98155935);
  assert.equal(REAL_DEMO_SAMPLE.manifestExpectations[1].size, 1264120);
});

test('manifest 校验：注入 fetchFn 确定性验证（匹配/缺失/大小不符）', async () => {
  // 匹配场景
  const okResult = await verifyRealDemoManifest({
    fetchFn: async () =>
      new Response(
        JSON.stringify({
          files: [
            { path: 'viral/viral-reference-01.mp4', size: 98155935, sha256: '913fcc39bafc5192e11a84c263f4f68cd5a0df941c196f48d2553a0ee05564cf' },
            { path: 'products/buv-product-front.png', size: 1264120, sha256: 'eeb218699c3c40a8f0f9f86a34706a7cffcdcb1e761004188f419ef2c9fb518f' },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      ),
  });
  assert.equal(okResult.ok, true, JSON.stringify(okResult.errors));

  // 大小不符场景
  const badResult = await verifyRealDemoManifest({
    fetchFn: async () =>
      new Response(
        JSON.stringify({
          files: [
            { path: 'viral/viral-reference-01.mp4', size: 123, sha256: '913fcc39bafc5192e11a84c263f4f68cd5a0df941c196f48d2553a0ee05564cf' },
            { path: 'products/buv-product-front.png', size: 1264120, sha256: 'eeb218699c3c40a8f0f9f86a34706a7cffcdcb1e761004188f419ef2c9fb518f' },
          ],
        }),
        { status: 200 }
      ),
  });
  assert.equal(badResult.ok, false);
  assert.ok(badResult.errors.some((e) => e.includes('大小不符')));

  // manifest 不可达
  const unreachable = await verifyRealDemoManifest({
    fetchFn: async () => new Response('nope', { status: 404 }),
  });
  assert.equal(unreachable.ok, false);
  assert.ok(unreachable.errors.some((e) => e.includes('HTTP 404')));
});
