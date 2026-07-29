import { z } from 'zod';

export const Step1OutputSchema = z.object({
  scene: z.string().min(2, "场景描述过短"),
  subject: z.string().min(2, "主体描述过短"),
  style: z.string().min(2, "风格描述过短"),
  palette: z.array(z.string()).min(1, "色板必须包含至少一种颜色"),
  lighting: z.string().min(2, "光线描述过短"),
  composition: z.string().min(2, "构图描述过短"),
  mood: z.string().min(2, "情绪描述过短"),
  camera: z.string().min(2, "镜头描述过短"),
  static_image_prompt: z.string().min(10, "静态图 Prompt 过短"),
  rationale: z.string().optional().default("已基于爆款参考图自动完成视觉拆解"),
});

export type Step1Output = z.infer<typeof Step1OutputSchema>;

export const Step2OutputSchema = z.object({
  motion_type: z.string().min(2, "运镜类型过短"),
  motion_intensity: z.string().min(1, "运镜强度不能为空"),
  video_prompt: z.string().min(10, "视频 Prompt 过短"),
  negative_prompt: z.string().optional().default("模糊，畸变，卡顿，低质量"),
  camera_description: z.string().optional().default(""),
});

export type Step2Output = z.infer<typeof Step2OutputSchema>;

export const Step3OutputSchema = z.object({
  title: z.string().min(2, "文案标题不能为空"),
  hook: z.string().min(3, "黄金3秒钩子不能为空"),
  body: z.string().min(10, "正文文案不能为空"),
  hashtags: z.array(z.string()).optional().default([]),
  cta: z.string().optional().default(""),
  platform_fit: z.string().optional().default("适用于各大短视频平台"),
  warnings: z.array(z.string()).optional().default([]),
});

export type Step3Output = z.infer<typeof Step3OutputSchema>;

export const Step4BgmItemSchema = z.object({
  track_id: z.string().optional(),
  track_name: z.string().min(1, "曲目名称不能为空"),
  artist: z.string().optional().default("未知艺人"),
  rationale: z.string().min(3, "推荐理由不能为空"),
  sync_point: z.string().optional().default("建议从 00:00 处播放与画面卡点匹配"),
});

export const Step4OutputSchema = z.object({
  bgm_recommendation: Step4BgmItemSchema,
  alternatives: z.array(Step4BgmItemSchema).optional().default([]),
});

export type Step4Output = z.infer<typeof Step4OutputSchema>;

/**
 * 结构校验辅助函数
 */
export function validateStepOutput<T>(schema: z.ZodSchema<T>, data: unknown): { success: true; data: T } | { success: false; error: string } {
  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  const formattedErrors = result.error.issues.map(e => `${e.path.join('.')}: ${e.message}`).join('; ');
  return { success: false, error: formattedErrors };
}
