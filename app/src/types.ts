export type StepId = 1 | 2 | 3 | 4 | 5;

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'needs_review';

export interface Step1Inputs {
  mediaUrl: string;
  platform: 'douyin' | 'xiaohongshu' | 'shipinhao' | 'general';
  bloggerType: 'skincare_expert' | 'daily_seeding' | 'ingredient_geek' | 'review_beauty';
  viralReason: string;
  /** 多模态视觉拆解用文本模型（默认 Gemini 3.6 Flash） */
  textModel?: string;
  /** 文生图模型（默认 GPT Image 2） */
  imageModel?: string;
}

export interface ShotItem {
  shotIndex: number;
  startTime: string;
  endTime: string;
  shotType: string;
  cameraMovement: string;
  description: string;
  keyframeUrl?: string;
  mood: string;
}

export interface VideoStructure {
  totalShots: number;
  avgShotDuration: string;
  pacing: 'fast' | 'medium' | 'slow';
  narrativeArc: string;
  hookTiming: string;
}

export interface OriginalScriptAnalysis {
  hasVoiceover: boolean;
  estimatedScript: string;
  sellingPoints: string[];
}

export interface AudioAnalysis {
  hasBgm: boolean;
  estimatedBpm: string;
  musicStyle: string;
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
  /** 视频拆解引擎扩展字段 (由多模态 LLM 拆解镜头表时填充) */
  shotList?: ShotItem[];
  videoStructure?: VideoStructure;
  originalScript?: OriginalScriptAnalysis;
  audioAnalysis?: AudioAnalysis;
}

export interface VideoDeconstructionOutput extends Step1Output {
  shotList: ShotItem[];
  videoStructure: VideoStructure;
  originalScript: OriginalScriptAnalysis;
  audioAnalysis: AudioAnalysis;
}

export interface CandidateImageItem {
  id: string;
  url: string;
  promptUsed: string;
  createdAt: number;
}

export interface Step2Inputs {
  static_image_prompt: string;
  imageUrl: string;
  videoTone: 'douyin_beat' | 'xiaohongshu_healing' | 'brand_tvc';
  durationSec: number;
  /** 图生视频模型（默认 Seedance 2.0 Fast） */
  videoModel?: string;
  /** 运镜 Prompt 生成用文本模型（默认 Gemini 3.6 Flash） */
  textModel?: string;
  /** 生图模型（默认 GPT Image 2 / 云雾） */
  imageModel?: string;
  /** 工作模式：text2image (AI 文生图素材集模式) | direct_image (已有首帧图/Step1 模式) */
  tabMode?: 'text2image' | 'direct_image';
  /** AI 生图大模型生成的多个素材图候选池 */
  candidateImages?: CandidateImageItem[];
  /** 当前选中的素材图 ID */
  selectedImageId?: string;
}

export interface MultiShotItemTask {
  id?: string;
  shotIndex: number;
  shotType?: string;
  cameraMovement?: string;
  description?: string;
  keyframeUrl?: string;
  video_prompt?: string;
  seedanceTaskId?: string;
  status: 'pending' | 'generating' | 'completed' | 'failed';
  video_url?: string;
  error_message?: string;
}

export interface MultiShotGenerationResult {
  sessionId: string;
  totalShots: number;
  estimatedCompletionTimeSec: number;
  shots: MultiShotItemTask[];
  concatenatedVideoUrl?: string;
  concatStatus?: 'pending' | 'processing' | 'completed' | 'failed';
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
  /** 多镜头分段生成扩展 */
  isMultiShot?: boolean;
  multiShotResult?: MultiShotGenerationResult;
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
  /** 文案 LLM（默认 Gemini 3.6 Flash） */
  textModel?: string;
}

export interface ProhibitedWordWarning {
  word: string;
  field: string;
  suggestion: string;
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
  warnings?: ProhibitedWordWarning[];
}

export interface Step4Inputs {
  copywritingTitle: string;
  tonePreference: '治愈' | '卡点' | '高级' | '反差';
  commercialScenario: '个人' | '抖音/小红书商业化';
  /** BGM 匹配用文本模型（默认 Gemini 3.6 Flash） */
  textModel?: string;
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
  subtitlePosition?: 'bottom' | 'center' | 'top';
  brandStampText?: string;
  brandStampPosition?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
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
    videoUrl?: string;
    downloadUrl?: string;
  };
  qa_checklist: string[];
  renderEngine?: string;
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
  tags?: string[];
}

export interface WorkspaceSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt?: string;
  status: 'completed' | 'generating' | 'failed' | 'queued' | 'draft';
  currentStep: StepId;
  pipelineData: PipelineData;
  productId?: string;
  thumbnailUrl?: string;
  version?: number;
  notes?: string;
}

export type TaskItem = WorkspaceSession;
export type SessionItem = WorkspaceSession;

export type ProductAssetRole =
  | 'hero'
  | 'angle'
  | 'detail'
  | 'texture'
  | 'in_use'
  | 'packaging_text';

export interface ProductAsset {
  id: string;
  url: string;
  role?: ProductAssetRole | string;
  sortOrder?: number;
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
  /** Product visual identity pack for viral direct-out */
  assets?: ProductAsset[];
}

export type SellingPointsAiModel = 'gemini-3.6-flash' | 'gpt-4o' | 'deepseek-v3';

export interface PresetTemplate {
  id: string;
  title: string;
  tag: string;
  description: string;
  coverImage: string;
  category?: string;
  formula?: string;
  /** Full 5-step snapshot; aligned with backend `/api/presets` field name */
  pipelineData: PipelineData;
  createdAt?: string;
}
