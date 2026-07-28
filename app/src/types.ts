export type StepId = 1 | 2 | 3 | 4 | 5;

export type StepStatus = 'pending' | 'running' | 'completed';

export interface Step1Inputs {
  mediaUrl: string;
  platform: 'douyin' | 'xiaohongshu' | 'shipinhao' | 'general';
  bloggerType: 'skincare_expert' | 'daily_seeding' | 'ingredient_geek' | 'review_beauty';
  viralReason: string;
  imageModel?: 'Nano Banana 2 Lite' | 'Nano Banana Pro' | 'Imagen 4' | 'Imagen 4 Ultra' | 'Imagen 4 Fast' | 'GPT Image 2';
}

export interface Step1Output {
  scene: string;
  subject: string;
  style: string;
  palette: string[];
  lighting: string;
  composition: string;
  mood: string;
  camera: string;
  static_image_prompt: string;
  rationale: string;
}

export interface Step2Inputs {
  static_image_prompt: string;
  imageUrl: string;
  videoTone: 'douyin_beat' | 'xiaohongshu_healing' | 'brand_tvc';
  durationSec: number;
  videoModel?: 'Omni Flash' | 'Veo 3.1 Preview' | 'Veo 3.1 Fast Preview' | 'Seedance 2.0' | 'Seedance 2.0 Fast';
}

export interface Step2Output {
  motion_type: 'zoom_in' | 'zoom_out' | 'pan_left' | 'pan_right' | 'tilt_up' | 'tilt_down' | 'rotate' | 'static_micro_motion';
  motion_intensity: 'subtle' | 'medium' | 'strong';
  motion_description: string;
  duration_sec: string;
  video_prompt: string;
  audio_layer: string;
  negative_prompt: string;
  previewVideoUrl?: string;
  /** 星河 Seedance 中转任务字段 */
  videoProvider?: string;
  seedanceConfigured?: boolean;
  seedanceModel?: string;
  seedanceTaskId?: string;
  seedanceStatus?: string;
  seedanceInferenceId?: string;
  seedanceError?: string;
  seedanceHint?: string;
  seedanceMaterialWarning?: string;
}

export interface Step3Inputs {
  videoPrompt: string;
  targetPlatform: 'douyin' | 'xiaohongshu' | 'shipinhao' | 'general';
  scriptPersona: '成分党' | '油皮亲妈' | '学生党平价' | '高级感沉浸';
}

export interface Step3Output {
  title: string;
  hook: string;
  body: string;
  hashtags: string[];
  cta: string;
  platform_fit: {
    douyin: string;
    xiaohongshu: string;
  };
}

export interface Step4Inputs {
  copywritingTitle: string;
  tonePreference: '治愈' | '卡点' | '高级' | '反差';
  commercialScenario: '个人' | '抖音/小红书商业化';
}

export interface Step4Output {
  bgm_recommendation: {
    track_name: string;
    artist: string;
    style: string[];
    bpm: string;
    mood_match: string;
    sync_point: string;
    license_note: string;
    audioSampleUrl?: string;
  };
  alternatives: Array<{
    track_name: string;
    style: string;
    when_to_use: string;
  }>;
}

export interface Step5Inputs {
  aspectRatio: '9:16' | '3:4' | '1:1';
  subtitleStyle: '黄字黑边' | '白字柔影' | '极简小绿红书体' | '极速黑卡';
}

export interface TimelineItem {
  at: string;
  action: 'video_in' | 'audio_in' | 'subtitle_in' | 'brand_stamp';
  source?: string;
  text?: string;
  volume?: number;
  position?: string;
}

export interface Step5Output {
  timeline: TimelineItem[];
  output: {
    filename: string;
    resolution: string;
    format: string;
    duration_sec: number;
  };
  qa_checklist: string[];
}

export interface PipelineData {
  step1: { inputs: Step1Inputs; output?: Step1Output; status: StepStatus };
  step2: { inputs: Step2Inputs; output?: Step2Output; status: StepStatus };
  step3: { inputs: Step3Inputs; output?: Step3Output; status: StepStatus };
  step4: { inputs: Step4Inputs; output?: Step4Output; status: StepStatus };
  step5: { inputs: Step5Inputs; output?: Step5Output; status: StepStatus };
}

export interface MaterialItem {
  id: string;
  name: string;
  url: string;
  type: 'video' | 'image';
  size: string;
  duration?: string;
  createdAt: string;
  dimensions?: string;
}

export interface TaskItem {
  id: string;
  title: string;
  createdAt: string;
  status: 'completed' | 'generating' | 'failed' | 'queued';
  currentStep: StepId;
  pipelineData: PipelineData;
  thumbnailUrl?: string;
}

export interface ProductItem {
  id: string;
  name: string;
  category: string;
  positioning: string;
  price: string;
  salesRecord: string;
  coverImage?: string;
  model343: {
    clays: string;
    extracts: string;
    surfactants: string;
  };
  sgsData: {
    oil8h: string;
    oil14d: string;
    blackhead14d: string;
  };
  prohibitedWords: string[];
  customSellingPoints?: string;
  targetAudience?: string;
  updatedAt?: string;
}

export type SellingPointsAiModel = 'deepseek-v3' | 'deepseek-r1' | 'gpt-4o' | 'gemini-3.6-flash' | 'claude-3.5-sonnet';

export interface PresetTemplate {
  id: string;
  title: string;
  tag: string;
  description: string;
  coverImage: string;
  data: PipelineData;
}
