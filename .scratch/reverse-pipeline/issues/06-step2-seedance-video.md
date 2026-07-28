# 06 — Step 2 图生视频（Seedance 接续）

**What to build:** 将 Seedance 中转逻辑从单体 server.ts 重构至独立路由模块 `server/routes/seedance.ts`，保留完整的 Token 鉴权 + 异步任务轮询机制。Step 2 端点升级：通过 LLM Gateway 生成视频运镜 Prompt（注入产品信息），然后将 Step 1 生成的静态图作为 First Frame 提交给 Seedance 生成真实视频。前端可追踪 Seedance 任务状态并在完成后预览视频。

**Blocked by:** 05 — Step 1 多模态视觉拆解

**Status:** completed

- [x] Seedance 中转逻辑完整迁移至 `server/routes/seedance.ts`，功能不破坏
- [x] `POST /api/pipeline/step2` 改用 LLM Gateway 生成视频运镜 Prompt
- [x] 产品信息从 SQLite 注入 Step 2 的 System Prompt
- [x] Seedance 任务创建、状态轮询、Token 自动刷新全部正常
- [x] 前端 Step2Card 正确显示 Seedance 任务状态与运镜类型
- [x] 一键全自动模式下 Step 1 → Step 2 自动级联运行
