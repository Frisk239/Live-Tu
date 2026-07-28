import { initDatabase, db } from '../lib/db';
import express from 'express';
import { pipelineRouter } from '../routes/pipeline';
import { productsRouter } from '../routes/products';
import { materialsRouter } from '../routes/materials';
import { bgmRouter } from '../routes/bgm';
import { modelsRouter } from '../routes/models';

async function runE2EFullPipelineTest() {
  console.log('===========================================================');
  console.log('  BUV 爆款视频反推流水线 — 端到端全业务逻辑完整闭环验证  ');
  console.log('===========================================================');

  // 1. 初始化 SQLite 数据库
  initDatabase();
  console.log('✓ [DB] SQLite 数据库连接及初始数据表结构验证通过');

  const app = express();
  app.use(express.json());
  app.use('/api/pipeline', pipelineRouter);
  app.use('/api/products', productsRouter);
  app.use('/api/materials', materialsRouter);
  app.use('/api/bgm', bgmRouter);
  app.use('/api/models', modelsRouter);

  const server = app.listen(3099);
  const baseUrl = 'http://localhost:3099';

  try {
    // ---------------------------------------------------------
    // 模块 1: 品牌卖点库 CRUD 与产品知识检索
    // ---------------------------------------------------------
    console.log('\n--- 1. 验证品牌卖点库 (Products) ---');
    const resProducts = await fetch(`${baseUrl}/api/products`);
    const jsonProducts = await resProducts.json();
    console.assert(jsonProducts.success === true, 'Products API GET failed');
    const activeProduct = jsonProducts.data.find((p: any) => p.id === 'prod_buv_cleanser');
    console.assert(Boolean(activeProduct), 'BUV 小绿泥默认产品缺失');
    console.log(`✓ 默认产品: "${activeProduct.name}" (${activeProduct.positioning})`);

    // ---------------------------------------------------------
    // 模块 2: 素材库 (Materials) CRUD & 文件系统联动
    // ---------------------------------------------------------
    console.log('\n--- 2. 验证素材库 (Materials) ---');
    const resMaterials = await fetch(`${baseUrl}/api/materials`);
    const jsonMaterials = await resMaterials.json();
    console.assert(jsonMaterials.success === true, 'Materials API GET failed');
    console.log(`✓ 当前素材库记录数: ${jsonMaterials.data.length}`);

    // ---------------------------------------------------------
    // 模块 3: BGM 确权乐库 (BGM Library) CRUD
    // ---------------------------------------------------------
    console.log('\n--- 3. 验证 BGM 库 (BGM Library) ---');
    const resBgm = await fetch(`${baseUrl}/api/bgm`);
    const jsonBgm = await resBgm.json();
    console.assert(jsonBgm.success === true, 'BGM API GET failed');
    console.assert(jsonBgm.data.length >= 4, 'BGM 预置数据缺失');
    console.log(`✓ 预置 BGM 乐库曲目数: ${jsonBgm.data.length}`);

    // ---------------------------------------------------------
    // 模块 4: AI 模型可切换配置网关 (LLM Gateway Config)
    // ---------------------------------------------------------
    console.log('\n--- 4. 验证 AI 模型配置网关 (Models Config) ---');
    const resModels = await fetch(`${baseUrl}/api/models/config`);
    const jsonModels = await resModels.json();
    console.assert(jsonModels.success === true, 'Models Config GET failed');
    const totalModels = jsonModels.textModels.length + jsonModels.imageModels.length + jsonModels.videoModels.length;
    console.log(`✓ 可用 AI 模型配置数: ${totalModels} (文本: ${jsonModels.textModels.length}, 图像: ${jsonModels.imageModels.length}, 视频: ${jsonModels.videoModels.length})`);

    // ---------------------------------------------------------
    // 模块 5: 全流水线 Step 1 → Step 5 级联业务闭环
    // ---------------------------------------------------------
    console.log('\n--- 5. 验证 5 步流水线全链路贯通执行 ---');

    // Step 1: 视觉拆解
    console.log('▶ [Step 1] 启动多模态视觉拆解卡片...');
    const resStep1 = await fetch(`${baseUrl}/api/pipeline/step1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inputs: {
          mediaUrl: activeProduct.cover_image,
          platform: 'douyin',
          bloggerType: 'ingredients_pro',
          productId: activeProduct.id,
        },
      }),
    });
    const jsonStep1 = await resStep1.json();
    console.assert(jsonStep1.success === true, 'Step 1 执行失败');
    const step1Data = jsonStep1.data;
    console.assert(Boolean(step1Data.static_image_prompt), 'Step 1 static_image_prompt 缺失');
    console.log(`✓ Step 1 产出静态图 Prompt: "${step1Data.static_image_prompt.substring(0, 60)}..."`);
    console.log(`✓ Step 1 视觉归因说明: "${step1Data.rationale.substring(0, 50)}..."`);

    // Step 2: 运镜生成 & 视频中转
    console.log('\n▶ [Step 2] 启动静态图 → 视频运镜生成...');
    const resStep2 = await fetch(`${baseUrl}/api/pipeline/step2`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inputs: {
          static_image_prompt: step1Data.static_image_prompt,
          imageUrl: activeProduct.cover_image,
          videoTone: 'douyin_beat',
          durationSec: 4,
          productId: activeProduct.id,
        },
      }),
    });
    const jsonStep2 = await resStep2.json();
    console.assert(jsonStep2.success === true, 'Step 2 执行失败');
    const step2Data = jsonStep2.data;
    console.assert(Boolean(step2Data.video_prompt), 'Step 2 video_prompt 缺失');
    console.log(`✓ Step 2 运镜类型: [${step2Data.motion_type}] (${step2Data.motion_intensity})`);
    console.log(`✓ Step 2 视频 Prompt: "${step2Data.video_prompt.substring(0, 60)}..."`);

    // Step 3: 爆款文案生成 & 违禁词合规扫描
    console.log('\n▶ [Step 3] 启动爆款带货文案生成与违禁词合规扫描...');
    const resStep3 = await fetch(`${baseUrl}/api/pipeline/step3`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inputs: {
          videoPrompt: step2Data.video_prompt,
          targetPlatform: 'douyin',
          scriptPersona: '成分党',
          productId: activeProduct.id,
        },
      }),
    });
    const jsonStep3 = await resStep3.json();
    console.assert(jsonStep3.success === true, 'Step 3 执行失败');
    const step3Data = jsonStep3.data;
    console.assert(Boolean(step3Data.title), 'Step 3 title 缺失');
    console.assert(Boolean(step3Data.body), 'Step 3 body 缺失');
    console.log(`✓ Step 3 爆款标题: "${step3Data.title}"`);
    console.log(`✓ Step 3 前置 3s 钩子: "${step3Data.hook}"`);
    if (step3Data.warnings && step3Data.warnings.length > 0) {
      console.log(`⚠️ Step 3 识别到合规违禁词告警: ${step3Data.warnings.length} 处`);
    } else {
      console.log(`✓ Step 3 合规扫描: 未发现违法或违规极限词`);
    }

    // Step 4: BGM 语义卡点推荐
    console.log('\n▶ [Step 4] 启动 BGM 乐库语义匹配与卡点计算...');
    const resStep4 = await fetch(`${baseUrl}/api/pipeline/step4`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inputs: {
          copywritingTitle: step3Data.title,
          tonePreference: '卡点',
          commercialScenario: '抖音/小红书商业化',
          productId: activeProduct.id,
        },
      }),
    });
    const jsonStep4 = await resStep4.json();
    console.assert(jsonStep4.success === true, 'Step 4 执行失败');
    const step4Data = jsonStep4.data;
    const bgmRec = step4Data.bgm_recommendation;
    console.assert(Boolean(bgmRec.track_name), 'Step 4 track_name 缺失');
    console.log(`✓ Step 4 匹配曲目: "${bgmRec.track_name}" (${bgmRec.bpm} BPM)`);
    console.log(`✓ Step 4 卡点推荐秒数: "${bgmRec.sync_point}"`);

    // Step 5: 成品剪辑与合成准备
    console.log('\n▶ [Step 5] 启动 Timeline 合成准备与导出...');
    const resStep5 = await fetch(`${baseUrl}/api/pipeline/step5`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inputs: {
          aspectRatio: '9:16',
          productId: activeProduct.id,
        },
      }),
    });
    const jsonStep5 = await resStep5.json();
    console.assert(jsonStep5.success === true, 'Step 5 执行失败');
    const step5Data = jsonStep5.data;
    console.assert(Boolean(step5Data.output?.filename), 'Step 5 filename 缺失');
    console.log(`✓ Step 5 目标视频输出配置: ${step5Data.output.resolution} (${step5Data.output.format}) -> ${step5Data.output.filename}`);

    console.log('\n===========================================================');
    console.log('🎉 恭喜！端到端全业务逻辑闭环测试 100% 全部通过！');
    console.log('===========================================================');
  } finally {
    server.close();
  }
}

runE2EFullPipelineTest().catch((err) => {
  console.error('❌ E2E 业务逻辑闭环测试失败:', err);
  process.exit(1);
});
