import { Router } from 'express';
import { createSeedanceVideo, normalizeSeedanceTask, hasSeedanceConfig } from './seedance';

export const pipelineRouter = Router();

// YUNWU API helper (retained for backward compatibility until LLM Gateway ticket 02)
const YUNWU_API_KEY = process.env.YUNWU_API_KEY || (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY' ? process.env.GEMINI_API_KEY : '');
const YUNWU_BASE_URL = (process.env.YUNWU_BASE_URL || 'https://api3.wlai.vip/v1').replace(/\/$/, '');
const TEXT_MODEL = process.env.TEXT_MODEL || 'gpt-4o-mini';

function extractJsonObject(text: string): any {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) return JSON.parse(fenced[1].trim());
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error('Model response is not valid JSON');
  }
}

async function chatJson(params: { system: string; user: string; model?: string }): Promise<any | null> {
  if (!YUNWU_API_KEY) return null;
  const response = await fetch(`${YUNWU_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${YUNWU_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: params.model || TEXT_MODEL,
      temperature: 0.7,
      messages: [
        { role: 'system', content: `${params.system}\n\n你必须只返回合法 JSON 对象，不要 Markdown，不要代码块。` },
        { role: 'user', content: params.user },
      ],
    }),
  });
  if (!response.ok) throw new Error(`Yunwu API error ${response.status}`);
  const payload: any = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  return content ? extractJsonObject(content) : null;
}

// Step 1
pipelineRouter.post('/step1', async (req, res) => {
  const { platform = 'douyin', bloggerType = 'daily_seeding', viralReason = '', productInfo } = req.body;
  const productName = productInfo?.name || 'BUV 笔薇 小绿泥洁面';
  const productPos = productInfo?.positioning || '油皮专研 · 温和净澈';

  try {
    const data = await chatJson({
      system: `你是一个电商爆款视觉拆解专家。针对产品【${productName}】，生成静态图 prompt。必须返回 JSON，字段：scene, subject, style, palette, lighting, composition, mood, camera, static_image_prompt, rationale`,
      user: `针对产品【${productName}】（定位：${productPos}），平台【${platform}】、博主【${bloggerType}】、爆款原因【${viralReason}】，拆解首帧静态视觉画面，输出结构化JSON。`,
    });
    if (data) return res.json({ success: true, data, source: 'yunwu' });
  } catch (err: any) {
    console.warn('Step1 fallback:', err.message);
  }

  const mockResult = {
    scene: platform === 'xiaohongshu' ? `晨间阳光浴室镜前，自然光照射在 ${productName} 瓶身上` : `高质感极简展台，背景微距呈现 ${productName} 核心质感`,
    subject: `女性纤手展示 ${productName}，特写精致管身与膏体质感`,
    style: platform === 'xiaohongshu' ? '小红书治愈生活风' : '抖音硬核测评风',
    palette: ['#A8D5BA 薄荷绿', '#FFFFFF 纯白', '#F5F5F0 柔光白'],
    lighting: '自然柔光，高光润泽，透光感十足',
    composition: '三分法构图，主体居中偏右下，层次感分明',
    mood: '清爽高质感晨间仪式感',
    camera: '45度俯拍特写 + 微距大光圈虚化',
    static_image_prompt: `a high-end product photography shot of ${productName} in a bright minimalist aesthetic setting, soft morning sunlight, natural textures, 8k resolution`,
    rationale: `针对【${productName}】的特色，通过真实高光质感与纯净配色，强化【${productPos}】的心理暗示与爆款点击率。`,
  };
  return res.json({ success: true, data: mockResult, source: 'mock' });
});

// Step 2
pipelineRouter.post('/step2', async (req, res) => {
  const { static_image_prompt = '', videoTone = 'douyin_beat', durationSec = 4, videoModel, productInfo } = req.body;
  const productName = productInfo?.name || 'BUV 笔薇 小绿泥洁面';

  let data: any = null;
  try {
    data = await chatJson({
      system: `你是一个 AI 视频生成专家。必须返回 JSON，字段：motion_type, motion_intensity, motion_description, duration_sec, video_prompt, audio_layer, negative_prompt`,
      user: `针对产品【${productName}】，静态图 Prompt【${static_image_prompt}】，调性【${videoTone}】，时长【${durationSec}s】，生成运镜 Prompt 结构化 JSON。`,
    });
  } catch (err: any) {
    console.warn('Step2 fallback:', err.message);
  }

  if (!data) {
    data = {
      motion_type: videoTone === 'douyin_beat' ? 'pan_left' : 'zoom_in',
      motion_intensity: videoTone === 'douyin_beat' ? 'strong' : 'subtle',
      motion_description: `镜头由中景平滑推进至 ${productName} 瓶身特写`,
      duration_sec: String(durationSec),
      video_prompt: `A smooth slow zoom-in camera motion focusing on ${productName}, 60fps cinematic quality`,
      audio_layer: '晨间水滴声与轻柔环境音',
      negative_prompt: '避免无意义旋转、变形、抖动、花式转场',
    };
  }

  data.seedanceConfigured = hasSeedanceConfig();
  return res.json({ success: true, data, source: 'mock' });
});

// Step 3
pipelineRouter.post('/step3', async (req, res) => {
  const { videoPrompt = '', targetPlatform = 'douyin', scriptPersona = '成分党', productInfo } = req.body;
  const productName = productInfo?.name || 'BUV 笔薇 小绿泥洁面';

  const mockStep3 = {
    title: targetPlatform === 'douyin' ? `搞定问题肌！${productName} SGS实测强效体验！🔥` : `早晨的快乐是它给的！${productName} 沉浸使用感🍃`,
    hook: `你还在为了皮肤烦恼？试试【${productName}】的核心爆款配方！`,
    body: `来看 SGS 权威报告！【${productName}】凭什么口碑风靡全网？\n\n核心就在它的科学配方体系！体验感直接拉满！`,
    hashtags: [`#${productName.split(' ')[0] || 'BUV'}`, `#${productName}`, '#美妆爆款', '#SGS实测'],
    cta: '点击下方链接，领专属限时体验福利！',
    platform_fit: {
      douyin: `宝藏好物推荐！【${productName}】实测效果直接拉满！点击下方小黄车领专属优惠～`,
      xiaohongshu: `沉浸式种草！【${productName}】质地超级治愈🍃 强烈推荐给所有宝子们～`,
    },
  };
  return res.json({ success: true, data: mockStep3, source: 'mock' });
});

// Step 4
pipelineRouter.post('/step4', async (req, res) => {
  const { tonePreference = '治愈', productInfo } = req.body;
  const productName = productInfo?.name || 'BUV 笔薇 小绿泥洁面';

  const mockStep4 = {
    bgm_recommendation: {
      track_name: tonePreference === '卡点' ? 'Trap Tech Beat 128BPM' : `Morning Breeze - ${productName} Theme`,
      artist: tonePreference === '卡点' ? 'Phonk Master' : 'Chillout SoundLab',
      style: tonePreference === '卡点' ? ['卡点Electronic', '重低音Trap'] : ['治愈Lofi', '晨间轻音乐'],
      bpm: tonePreference === '卡点' ? '128' : '82',
      mood_match: `契合【${productName}】的演示场景`,
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
  const { aspectRatio = '9:16', productInfo } = req.body;
  const productName = productInfo?.name || 'BUV 笔薇 小绿泥洁面';

  const mockStep5 = {
    timeline: [
      { at: '0.0s', action: 'video_in', source: `${productName}_video.mp4` },
      { at: '0.0s', action: 'audio_in', source: 'ambient_bgm.mp3', volume: 0.3 },
      { at: '0.2s', action: 'subtitle_in', text: `体验 ${productName}！`, position: 'bottom_center' },
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
