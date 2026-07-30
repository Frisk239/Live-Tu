export const PERMISSION_KEYS = [
  'module.pipeline.read',
  'module.pipeline.write',
  'module.materials.read',
  'module.materials.write',
  'module.tasks.read',
  'module.tasks.write',
  'module.presets.read',
  'module.presets.write',
  'module.knowledge.read',
  'module.knowledge.write',
  'module.bgm.read',
  'module.bgm.write',
  'module.models.read',
  'module.models.write',
  'admin.users.manage',
  'admin.metrics.read',
  'admin.audit.read',
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

export const PERMISSION_NAMES: Record<PermissionKey, string> = {
  'module.pipeline.read': '工作台读取',
  'module.pipeline.write': '工作台编辑',
  'module.materials.read': '素材库读取',
  'module.materials.write': '素材库编辑',
  'module.tasks.read': '任务读取',
  'module.tasks.write': '任务编辑',
  'module.presets.read': '模板库读取',
  'module.presets.write': '模板库编辑',
  'module.knowledge.read': '品牌知识库读取',
  'module.knowledge.write': '品牌知识库编辑',
  'module.bgm.read': 'BGM 库读取',
  'module.bgm.write': 'BGM 库编辑',
  'module.models.read': '模型配置读取',
  'module.models.write': '模型配置编辑',
  'admin.users.manage': '用户管理',
  'admin.metrics.read': '指标读取',
  'admin.audit.read': '审计日志读取',
};

export const OPERATOR_PERMISSION_KEYS: PermissionKey[] = [
  'module.pipeline.read',
  'module.pipeline.write',
  'module.materials.read',
  'module.materials.write',
  'module.tasks.read',
  'module.tasks.write',
  'module.presets.read',
];
