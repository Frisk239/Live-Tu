/**
 * 运行/步骤状态契约（单一来源）
 *
 * S0 目标：用单一状态定义生成 TS 类型与数据库 CHECK 约束，API/UI 映射从同一契约派生。
 * - 数据库约束（迁移 DDL）从这里生成，杜绝「编排器写 needs_review、CHECK 却不允许」的漂移；
 * - 服务端类型从这里导入，前端 PipelineRunSnapshot 与之逐字段对齐（见 app/src/services/api.ts）。
 */

export const RUN_STATUSES = [
  'queued',
  'running',
  'waiting_external',
  'completed',
  'failed',
  'cancelled',
  'needs_review',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const STEP_STATUSES = [
  'pending',
  'running',
  'waiting_external',
  'completed',
  'failed',
  'cancelled',
  'stale',
  'needs_review',
] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const isRunStatus = (value: unknown): value is RunStatus =>
  typeof value === 'string' && (RUN_STATUSES as readonly string[]).includes(value);

export const isStepStatus = (value: unknown): value is StepStatus =>
  typeof value === 'string' && (STEP_STATUSES as readonly string[]).includes(value);

/** 生成 SQL CHECK 表达式文本（供表重建迁移使用） */
export const RUN_STATUS_CHECK_SQL = `status TEXT NOT NULL CHECK (status IN (${RUN_STATUSES.map((s) => `'${s}'`).join(', ')}))`;
export const STEP_STATUS_CHECK_SQL = `status TEXT NOT NULL CHECK (status IN (${STEP_STATUSES.map((s) => `'${s}'`).join(', ')}))`;

/** S2 镜头任务状态（含 submitting 原子占位；migration v26 重建表时使用） */
export const SHOT_STATUS_CHECK_SQL = `status TEXT NOT NULL CHECK (status IN ('pending', 'submitting', 'generating', 'completed', 'failed', 'cancelled'))`;
