import { Router } from 'express';
import { db } from '../lib/db';
import { callLlmGateway } from '../lib/llm-gateway';
import { createSeedanceVideo, normalizeSeedanceTask, hasSeedanceConfig } from './seedance';

export const pipelineRouter = Router();

// Helper to fetch active product from DB or fallback
function getProductContext(productId?: string, bodyProductInfo?: any) {
  if (productId) {
    const stmt = db.prepare('SELECT * FROM products WHERE id = ?');
    const r = stmt.get(productId) as any;
    if (r) {
      return {
        name: r.name,
        category: r.category,
        positioning: r.positioning,
        model343: `${r.model343_clays} | ${r.model343_extracts} | ${r.model343_surfactants}`,
        sgsData: `${r.sgs_oil_8h}, ${r.sgs_oil_14d}`,
        customSellingPoints: r.custom_selling_points,
      };
    }
  }
  return {
    name: bodyProductInfo?.name || 'BUV 笔薇 小绿泥洁面',
    category: bodyProductInfo?.category || '美妆护肤/洁面',
    positioning: bodyProductInfo?.positioning || '油皮专研 · 温和净澈 · 植萃护肤',
    model343: bodyProductInfo?.model343
      ? `${bodyProductInfo.model343.clays} | ${bodyProductInfo.model343.extracts}`
      : '3重天然泥+4重植萃',
    sgsData: bodyProductInfo?.sgsData
      ? `${bodyProductInfo.sgsData.oil8h}, ${bodyProductInfo.sgsData.oil14d}`
      : 'SGS权威实测: 8h控油-66.87%',
    customSellingPoints: bodyProductInfo?.customSellingPoints || '一润二修三控油，膏体薄荷绿质感拉丝',
  };
}

// Step 1: 多模态视觉拆解与静态图 Prompt 生成
pipelineRouter.post('/step1', async (req, res) => {
  const inputs = req.body.inputs || req.body;
  const {
    mediaUrl = '',
    imageUrl = '',
    platform = 'douyin',
    bloggerType = 'daily_seeding',
    viralReason = '',
    imageModel,
    productId,
    productInfo,
  } = inputs;

  const targetMediaUrl = mediaUrl || imageUrl || req.body.mediaUrl || req.body.imageUrl || '';
  const product = getProductContext(productId, productInfo);

  const systemPrompt = `你是一个抖音/小红书顶级美妆电商爆款视觉拆解专家。
针对品牌产品【${product.name}】（定位：${product.positioning}，卖点特色：${product.customSellingPoints}），
你需要对用户提供的首帧图片/爆款视频画面进行多模态视觉反推与拆解。

必须返回合法 JSON 对象，包含以下 10 个字段：
1. scene (场景描述, 15-30字)
2. subject (主体与产品动作, 15-30字)
3. style (视觉风格, 5-15字)
4. palette (颜色数组 Hex/中文, 3-4项字符串数组)
5. lighting (光线描述)
6. composition (构图方式)
7. mood (情绪基调)
8. camera (镜头语言与角度)
9. static_image_prompt (详细高保真英文 Prompt，适合 Midjourney/Imagen 生成同款高清图)
10. rationale (爆款归因拆解说明)`;

  const userPrompt = `【拆解任务】
- 目标产品：${product.name} (${product.positioning})
- 目标平台：${platform}
- 博主类型：${bloggerType}
- 爆款原因描述：${viralReason || '膏体质感高清拉丝，光影透润极具治愈种草力'}
${targetMediaUrl ? '- 请结合所上传的画面素材进行深度视觉解析。' : '- 当前无画面素材，请基于文本上下文进行构想拆解。'}
请输出结构化 JSON。`;

  try {
    const gatewayRes = await callLlmGateway({
      system: systemPrompt,
      user: userPrompt,
      imageUrl: targetMediaUrl || undefined,
      modelId: imageModel,
    });

    if (gatewayRes.success && gatewayRes.data) {
      const d = gatewayRes.data;
      const normalizedData = {
        scene: d.scene || `${product.name} 极简清爽场景`,
        subject: d.subject || `展示 ${product.name} 膏体细腻拉丝质感`,
        style: d.style || (platform === 'xiaohongshu' ? '小红书治愈生活风' : '抖音硬核测评风'),
        palette: Array.isArray(d.palette) && d.palette.length > 0 ? d.palette : ['#A8D5BA 薄荷绿', '#FFFFFF 纯白', '#F5F5F0 柔光白'],
        lighting: d.lighting || '自然柔光，高光润泽，透光感十足',
        composition: d.composition || '三分法构图，主体居中偏右下，层次感分明',
        mood: d.mood || '清爽高质感晨间仪式感',
        camera: d.camera || '45度俯拍特写 + 微距大光圈虚化',
        static_image_prompt: d.static_image_prompt || `A high-end product photography shot of ${product.name} in a bright minimalist aesthetic setting, soft morning sunlight, 8k resolution`,
        rationale: d.rationale || `针对【${product.name}】的特色，通过真实高光质感与纯净配色，强化点击转化率。`,
      };

      return res.json({
        success: true,
        data: normalizedData,
        source: gatewayRes.source,
        modelUsed: gatewayRes.modelUsed,
      });
    }
  } catch (err: any) {
    console.warn('Step 1 LLM Gateway error, falling back to smart mock:', err.message);
  }

  // Fallback mock
  const mockResult = {
    scene: platform === 'xiaohongshu' ? `晨间阳光浴室镜前，自然光照射在 ${product.name} 瓶身上` : `高质感极简展台，背景微距呈现 ${product.name} 核心质感`,
    subject: `女性纤手展示 ${product.name}，特写精致管身与膏体质感`,
    style: platform === 'xiaohongshu' ? '小红书治愈生活风' : '抖音硬核测评风',
    palette: ['#A8D5BA 薄荷绿', '#FFFFFF 纯白', '#F5F5F0 柔光白'],
    lighting: '自然柔光，高光润泽，透光感十足',
    composition: '三分法构图，主体居中偏右下，层次感分明',
    mood: '清爽高质感晨间仪式感',
    camera: '45度俯拍特写 + 微距大光圈虚化',
    static_image_prompt: `A high-end product photography shot of ${product.name} in a bright minimalist aesthetic setting, soft morning sunlight, natural textures, 8k resolution`,
    rationale: `针对【${product.name}】的特色，通过真实高光质感与纯净配色，强化【${product.positioning}】的心理暗示与爆款点击率。`,
  };

  return res.json({ success: true, data: mockResult, source: 'mock' });
});

// Step 2
pipelineRouter.post('/step2', async (req, res) => {
  const inputs = req.body.inputs || req.body;
  const { static_image_prompt = '', videoTone = 'douyin_beat', durationSec = 4, videoModel, productId, productInfo } = inputs;
  const product = getProductContext(productId, productInfo);

  let data: any = null;
  try {
    const gatewayRes = await callLlmGateway({
      system: `你是一个 AI 视频运镜专家。必须返回 JSON，字段：motion_type, motion_intensity, motion_description, duration_sec, video_prompt, audio_layer, negative_prompt`,
      user: `针对产品【${product.name}】，静态图 Prompt【${static_image_prompt}】，调性【${videoTone}】，时长【${durationSec}s】，生成运镜 Prompt 结构化 JSON。`,
    });
    if (gatewayRes.success && gatewayRes.data) {
      data = gatewayRes.data;
    }
  } catch (err: any) {
    console.warn('Step2 fallback:', err.message);
  }

  if (!data) {
    data = {
      motion_type: videoTone === 'douyin_beat' ? 'pan_left' : 'zoom_in',
      motion_intensity: videoTone === 'douyin_beat' ? 'strong' : 'subtle',
      motion_description: `镜头由中景平滑推进至 ${product.name} 瓶身特写`,
      duration_sec: String(durationSec),
      video_prompt: `A smooth slow zoom-in camera motion focusing on ${product.name}, 60fps cinematic quality`,
      audio_layer: '晨间水滴声与轻柔环境音',
      negative_prompt: '避免无意义旋转、变形、抖动、花式转场',
    };
  }

  data.seedanceConfigured = hasSeedanceConfig();
  return res.json({ success: true, data, source: 'mock' });
});

// Step 3
pipelineRouter.post('/step3', async (req, res) => {
  const inputs = req.body.inputs || req.body;
  const { videoPrompt = '', targetPlatform = 'douyin', scriptPersona = '成分党', productId, productInfo } = inputs;
  const product = getProductContext(productId, productInfo);

  const mockStep3 = {
    title: targetPlatform === 'douyin' ? `搞定问题肌！${product.name} SGS实测强效体验！🔥` : `早晨的快乐是它给的！${product.name} 沉浸使用感🍃`,
    hook: `你还在为了皮肤烦恼？试试【${product.name}】的核心爆款配方！`,
    body: `来看 SGS 权威报告！【${product.name}】凭什么口碑风靡全网？\n\n核心就在它的科学配方体系：${product.model343}！实测数据：${product.sgsData}。体验感直接拉满！`,
    hashtags: [`#${product.name.split(' ')[0] || 'BUV'}`, `#${product.name}`, '#美妆爆款', '#SGS实测'],
    cta: '点击下方链接，领专属限时体验福利！',
    platform_fit: {
      douyin: `宝藏好物推荐！【${product.name}】实测效果直接拉满！点击下方小黄车领专属优惠～`,
      xiaohongshu: `沉浸式种草！【${product.name}】质地超级治愈🍃 强烈推荐给所有宝子们～`,
    },
  };
  return res.json({ success: true, data: mockStep3, source: 'mock' });
});

// Step 4
pipelineRouter.post('/step4', async (req, res) => {
  const inputs = req.body.inputs || req.body;
  const { tonePreference = '治愈', productId, productInfo } = inputs;
  const product = getProductContext(productId, productInfo);

  const mockStep4 = {
    bgm_recommendation: {
      track_name: tonePreference === '卡点' ? 'Trap Tech Beat 128BPM' : `Morning Breeze - ${product.name} Theme`,
      artist: tonePreference === '卡点' ? 'Phonk Master' : 'Chillout SoundLab',
      style: tonePreference === '卡点' ? ['卡点Electronic', '重低音Trap'] : ['治愈Lofi', '晨间轻音乐'],
      bpm: tonePreference === '卡点' ? '128' : '82',
      mood_match: `契合【${product.name}】的演示场景`,
      sync_point: '1.2s（产品特写）、2.8s（成分展示）',
      license_note: '抖音/小红书曲库已商业授权',
    },
    alternatives: [
      { track_name: 'Soft Ambient Glow', style: '纯水声+轻音乐', when_to_use: '适合小红书Vlog' },
    ],
  };
  return res.json({ success: true, data: mockStep4, source: 'mock' });
});

// Step 5
pipelineRouter.post('/step5', async (req, res) => {
  const inputs = req.body.inputs || req.body;
  const { aspectRatio = '9:16', productId, productInfo } = inputs;
  const product = getProductContext(productId, productInfo);

  const mockStep5 = {
    timeline: [
      { at: '0.0s', action: 'video_in', source: `${product.name}_video.mp4` },
      { at: '0.0s', action: 'audio_in', source: 'ambient_bgm.mp3', volume: 0.3 },
      { at: '0.2s', action: 'subtitle_in', text: `体验 ${product.name}！`, position: 'bottom_center' },
    ],
    output: {
      filename: `v_${Date.now()}.mp4`,
      resolution: aspectRatio === '9:16' ? '1080x1920' : '1080x1080',
      format: 'mp4_h264',
      duration_sec: 4,
    },
    qa_checklist: [
      '✓ 音画精准卡点',
      '✓ 字幕位于下方20%区域',
    ],
  };
  return res.json({ success: true, data: mockStep5, source: 'mock' });
});
