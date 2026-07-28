# 10 — 任务历史 + 预设模版端到端持久化

**What to build:** 任务历史表 `tasks` 与预设模版表 `presets` 的完整端到端 SQLite 持久化。提供 `GET/POST/DELETE /api/tasks` 端点与 `GET/POST/DELETE /api/presets` 端点。在前端 TasksPageView 与 PresetsPageView 中异步加载后端 SQLite 数据，支持将历史任务或选定爆款模版一键套用/恢复至主工作台。

**Blocked by:** 01 — SQLite 基础设施 + Server 路由拆分

**Status:** completed

- [x] SQLite `tasks` 表 CRUD API (`GET/POST/DELETE /api/tasks`)
- [x] SQLite `presets` 表 CRUD API (`GET/POST/DELETE /api/presets`)
- [x] 执行流水线时自动向 `tasks` 表保存/更新当前任务状态与产物快照
- [x] 任务中心 UI (TasksPageView) 从 `/api/tasks` 读取列表，支持恢复任务、查看详情、删除任务
- [x] 模版库 UI (PresetsPageView) 从 `/api/presets` 读取列表，支持一键套用模版到工作台
- [x] 前端应用重新加载后，历史任务与保存的模版依然保留
