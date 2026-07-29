import { initDatabase } from '../server/lib/db';
import { callLlmGateway, callImageGenerationGateway } from '../server/lib/llm-gateway';
import { getSeedanceToken, hasSeedanceConfig } from '../server/routes/seedance';

async function main() {
  console.log('=====================================================');
  console.log('  开始测试模型连通性 (Model Connectivity Test)');
  console.log('=====================================================\n');

  initDatabase();

  // 1. 测试多模态文本模型：gemini3.6flash (gemini-3.6-flash)
  console.log('[1/3] 测试多模态文本模型: gemini-3.6-flash ...');
  try {
    const t0 = Date.now();
    const resLlm = await callLlmGateway({
      system: '你是一个专业的短视频拆解助手。请只返回 JSON 对象：{"status": "ok", "message": "hello"}',
      user: '测试模型连通性，请返回状态',
      modelId: 'Gemini 3.6 Flash',
      temperature: 0.1,
    });
    const elapsed = Date.now() - t0;
    console.log(`✓ [LLM] gemini-3.6-flash 连通成功! (${elapsed}ms)`);
    console.log(`  使用模型: ${resLlm.modelUsed}`);
    console.log(`  接口地址: ${resLlm.baseUrl}`);
    console.log(`  响应结果:`, JSON.stringify(resLlm.data));
  } catch (err: any) {
    console.error(`✗ [LLM] gemini-3.6-flash 连通异常: ${err.message}`);
  }

  console.log('\n-----------------------------------------------------\n');

  // 2. 测试文生图模型：gpt-image-1
  console.log('[2/3] 测试文生图模型: gpt-image-1 ...');
  try {
    const t0 = Date.now();
    const resImg = await callImageGenerationGateway({
      prompt: 'A minimalist futuristic studio background with glowing neon light, 8k',
      size: '1024x1024',
      modelId: 'GPT Image 1',
    });
    const elapsed = Date.now() - t0;
    if (resImg.success) {
      console.log(`✓ [Image] gpt-image-1 连通成功! (${elapsed}ms)`);
      console.log(`  使用模型: ${resImg.modelUsed}`);
      console.log(`  产物形式: ${resImg.imageUrl.startsWith('data:') ? 'base64 data (长度 ' + resImg.imageUrl.length + ')' : resImg.imageUrl}`);
    } else {
      console.error(`✗ [Image] gpt-image-1 响应失败: ${resImg.error}`);
    }
  } catch (err: any) {
    console.error(`✗ [Image] gpt-image-1 连通异常: ${err.message}`);
  }

  console.log('\n-----------------------------------------------------\n');

  // 3. 测试图生视频模型：seedance (doubao-seedance-2-0-fast)
  console.log('[3/3] 测试图生视频模型中转: seedance (doubao-seedance-2-0-fast) ...');
  try {
    const configured = hasSeedanceConfig();
    console.log(`  Seedance 中转配置检测: ${configured ? '已配置' : '未配置'}`);
    if (configured) {
      const t0 = Date.now();
      const token = await getSeedanceToken(true);
      const elapsed = Date.now() - t0;
      console.log(`✓ [Video] Seedance 中转鉴权 Token 获取成功! (${elapsed}ms)`);
      console.log(`  Token 长度: ${token.length} chars, 前缀: ${token.slice(0, 15)}...`);
    } else {
      console.warn(`! [Video] Seedance 中转未配置完全，请检查环境变量`);
    }
  } catch (err: any) {
    console.error(`✗ [Video] Seedance 连通异常: ${err.message}`);
  }

  console.log('\n=====================================================');
  console.log('  模型连通性测试完成');
  console.log('=====================================================');
}

main().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
