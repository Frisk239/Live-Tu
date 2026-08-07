import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { initDatabase } from '../lib/db';
import { createSequenceGateLlm } from '../adapters/sequence-gate-llm';
import { LlmSourceSemanticAnalyzer } from '../adapters/source-semantic-analyzer';

const here = path.dirname(fileURLToPath(import.meta.url));
const runnerPath = path.resolve(here, '../../scripts/run-p3-demo.mjs');

// llm-gateway 依赖 model_config 表（按 DATA_DIR 初始化）；与 llm-gateway.test.ts 同惯例。
initDatabase();

/**
 * 真实 wiring 契约测试：
 * 目标问题 A——run-p3-demo.mjs 调用 sequence gate 时不传真实 LLM，导致真实 demo
 * 必然 unverified 且退出码 3；现有 fake LLM 单测掩盖了问题。
 *
 * 本测试不打桩 LLM 函数，而是 stub 真实 gateway 的唯一 I/O（global fetch），
 * 让 createSequenceGateLlm 走真实 llm-gateway 代码路径（payload 构造、JSON 解析、
 * 错误归一化），证明 runner 的 wiring 是「真实 gateway 适配器」而非内联 fake。
 */

function stubFetchOnce(content: string, ok = true): { called: boolean; url: string } {
  const state = { called: false, url: '' };
  (globalThis as any).__p5WiringOriginalFetch = (globalThis as any).__p5WiringOriginalFetch ?? globalThis.fetch;
  (globalThis as any).fetch = async (url: any) => {
    state.called = true;
    state.url = String(url);
    if (!ok) {
      return {
        ok: false,
        status: 500,
        text: async () => 'model unavailable',
        json: async () => null,
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content } }],
      }),
    } as unknown as Response;
  };
  return state;
}

function restoreFetch(): void {
  const original = (globalThis as any).__p5WiringOriginalFetch;
  if (original) (globalThis as any).fetch = original;
}

test('wiring：createSequenceGateLlm 调用真实 llm-gateway（fetch 路径），JSON 解析走真实代码', async () => {
  const previousKey = process.env.YUNWU_API_KEY;
  process.env.YUNWU_API_KEY = 'test-dummy-key-for-mocked-fetch';
  const state = stubFetchOnce(
    '{"checks":[{"id":"story_order","verdict":"pass","evidence":["顺序一致"],"reason":"ok"}]}'
  );
  try {
    const llm = createSequenceGateLlm({ modelId: 'Gemini 3.6 Flash' });
    const result = await llm({
      system: 'system-prompt',
      user: 'user-prompt',
      imageUrls: ['https://example.com/frame.jpg'],
    });
    assert.equal(state.called, true, '必须真实调用 gateway（fetch 路径）');
    assert.match(state.url, /\/chat\/completions$/);
    assert.equal(result.success, true);
    assert.deepEqual(result.data?.checks?.[0]?.id, 'story_order');
  } finally {
    if (previousKey === undefined) delete process.env.YUNWU_API_KEY;
    else process.env.YUNWU_API_KEY = previousKey;
    restoreFetch();
  }
});

test('wiring：LLM 不可用（HTTP 失败）→ success:false（gate 据此如实 unverified，不伪造 pass）', async () => {
  // 全量套件会清空网关 Key（见 run-server-tests.mjs）；注入占位 Key 让 gateway
  // 走到真实 fetch 路径（与 llm-gateway.test.ts 同惯例），再由 mock 返回 HTTP 失败。
  const previousKey = process.env.YUNWU_API_KEY;
  process.env.YUNWU_API_KEY = 'test-dummy-key-for-mocked-fetch';
  const state = stubFetchOnce('', false);
  try {
    const llm = createSequenceGateLlm({ modelId: 'Gemini 3.6 Flash' });
    const result = await llm({
      system: 's',
      user: 'u',
      imageUrls: [],
    });
    assert.equal(state.called, true, '必须真实调用 gateway（fetch 路径）');
    assert.equal(result.success, false);
    assert.ok(result.error);
  } finally {
    if (previousKey === undefined) delete process.env.YUNWU_API_KEY;
    else process.env.YUNWU_API_KEY = previousKey;
    restoreFetch();
  }
});

test('wiring：LlmSourceSemanticAnalyzer 走真实 gateway；无效 raw 明确标记 fallback', async () => {
  // LLM 返回空对象（无效分析）→ 必须标 fallback，不得记录为已理解
  stubFetchOnce('{}');
  try {
    const analyzer = new LlmSourceSemanticAnalyzer();
    const result = await analyzer.analyzeSource({
      productName: 'BUV',
      segments: [
        { startSec: 0, endSec: 2 },
        { startSec: 2, endSec: 4 },
        { startSec: 4, endSec: 6 },
        { startSec: 6, endSec: 8 },
        { startSec: 8, endSec: 10 },
        { startSec: 10, endSec: 12 },
      ],
      keyframeUrls: ['https://example.com/kf-1.jpg'],
    });
    assert.equal(result.schemaValid, false);
    assert.equal(result.source, 'deterministic_fallback');
    assert.equal((result.storyboard as any).evidence.source, 'deterministic_fallback');
  } finally {
    restoreFetch();
  }
});

test('wiring（runner 文件级契约）：runner 必须经共享适配器接真实 LLM，且不再内联图床上传', () => {
  const source = readFileSync(runnerPath, 'utf8');
  // 1) 序列门禁必须显式注入 llm（经共享适配器）
  assert.match(source, /createSequenceGateLlm/, 'runner 必须 import 共享真实 LLM 适配器');
  assert.match(source, /runSequenceSemanticGate\(\{[\s\S]*?llm: createSequenceGateLlm/, 'runner 必须把真实 LLM 注入 sequence gate');
  // 2) 语义理解经共享 analyzer（不得自行拼装 provider 调用）
  assert.match(source, /LlmSourceSemanticAnalyzer/, 'runner 必须经共享语义分析适配器');
  assert.ok(!/buildSemanticStoryboardPrompt/.test(source), 'runner 不得再自行拼装 storyboard prompt');
  // 3) 资产发布经共享 port（不得内联第三方图床上传逻辑）
  assert.match(source, /publishLocalAsset/, 'runner 必须使用共享资产发布入口');
  assert.ok(!source.includes('api.imgur.com'), 'runner 不得内联 imgur 上传');
  assert.ok(!source.includes('litterbox.catbox.moe'), 'runner 不得内联 litterbox 上传');
  // 4) 发布通道默认不再自动开启第三方图床
  assert.ok(!/DEMO_ASSET_PUBLISHER.*\|\|\s*['"](auto|litterbox)['"]/.test(source), 'runner 不得默认/自动回退第三方图床');
});
