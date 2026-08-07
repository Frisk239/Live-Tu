import { initDatabase, db } from '../lib/db';
import { callLlmGateway, extractJsonObject } from '../lib/llm-gateway';

async function runTests() {
  console.log('--- Starting Ticket 02 LLM Gateway Tests ---');
  initDatabase();

  // Test 3 用 mock fetch 验证 payload 结构，不产生真实网络调用；
  // 但网关在「无 API Key」时会提前抛错，故注入占位 Key 让逻辑走到 fetch（被 mock 拦截）
  process.env.YUNWU_API_KEY = process.env.YUNWU_API_KEY || 'test-dummy-key-for-mocked-fetch';

  // Test 1: extractJsonObject helper
  const jsonResult = extractJsonObject('```json\n{"foo": "bar"}\n```');
  console.assert(jsonResult.foo === 'bar', 'Test 1 Failed: extractJsonObject fenced JSON');
  console.log('✓ Test 1 Passed: extractJsonObject parses markdown fenced JSON correctly');

  // Test 2: Verify model_config table has seed rows
  const modelsCount = (db.prepare('SELECT COUNT(*) as count FROM model_config').get() as any).count;
  console.assert(modelsCount > 0, 'Test 2 Failed: model_config has no seed rows');
  console.log(`✓ Test 2 Passed: SQLite model_config populated with ${modelsCount} rows`);

  // Test 3: Mock fetch to verify Multimodal payload vs Text-only payload
  const originalFetch = global.fetch;
  let capturedPayload: any = null;
  let capturedHeaders: any = null;
  let capturedUrl: string = '';

  (global as any).fetch = async (url: string, init: any) => {
    capturedUrl = url;
    capturedHeaders = init?.headers;
    capturedPayload = JSON.parse(init?.body || '{}');

    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: '{"result": "mock_vision_success", "analyzed": true}',
            },
          },
        ],
      }),
    };
  };

  try {
    // 3a. Call Gateway WITH imageUrl (Multimodal Vision)
    const visionRes = await callLlmGateway({
      system: '你是一个视觉拆解专家',
      user: '分析图片',
      imageUrl: 'https://example.com/demo.jpg',
      modelId: 'Gemini 3.6 Flash',
    });

    console.assert(visionRes.success === true, 'Test 3a Failed: Gateway response success is false');
    console.assert(Array.isArray(capturedPayload.messages[1].content), 'Test 3a Failed: User message is not array');
    console.assert(capturedPayload.messages[1].content[1].type === 'image_url', 'Test 3a Failed: Missing image_url payload');
    console.assert(capturedPayload.messages[1].content[1].image_url.url === 'https://example.com/demo.jpg', 'Test 3a Failed: Incorrect image URL');
    console.log('✓ Test 3a Passed: Multimodal Vision payload correctly formatted with image_url');

    // 3b. Call Gateway WITHOUT imageUrl (Text-only fallback)
    const textRes = await callLlmGateway({
      system: '你是一个文案专家',
      user: '生成文案',
      modelId: 'DeepSeek V3',
    });

    console.assert(textRes.success === true, 'Test 3b Failed: Gateway text response success is false');
    console.assert(typeof capturedPayload.messages[1].content === 'string', 'Test 3b Failed: User message should be text string');
    console.assert(capturedPayload.messages[1].content === '生成文案', 'Test 3b Failed: Text user content mismatch');
    console.log('✓ Test 3b Passed: Text-only payload correctly falls back to string content');

  } finally {
    global.fetch = originalFetch;
  }

  console.log('--- ALL TICKET 02 LLM GATEWAY TESTS PASSED! ---');
}

runTests().catch((err) => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});
