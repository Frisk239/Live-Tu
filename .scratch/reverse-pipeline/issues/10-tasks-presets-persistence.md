# 10 — 任务历史 + 预设模版端到端持久化

**What to build:** 任务中心与预设模版库的完整端到端持久化。`tasks` 表 + `presets` 表的 CRUD REST API；前端 TasksPageView 从 API 加载任务列表（替换内存 state），完成一条反推流程后自动保存；前端 PresetsPageView 从 API 加载预设模版，支持保存当前 pipeline 配置为新预设、从预设加载参数。刷新页面后任务历史和预设模版均保留。

**Blocked by:** 01 — SQLite 基础设施 + Server 路由拆分

**Status:** ready-for-agent

- [ ] `GET/POST /api/tasks` 任务列表与创建
- [ ] `GET /api/tasks/:id` 获取单个任务完整 pipeline_data
- [ ] 完成反推流程后前端自动调用 `POST /api/tasks` 保存任务
- [ ] `GET/POST /api/presets` 预设模版列表与创建
- [ ] "保存为预设"按钮将当前 pipeline 配置写入 SQLite
- [ ] "使用此模版"按钮从 SQLite 加载预设参数注入 pipeline
- [ ] 刷新页面后任务历史列表和预设模版列表仍完整显示
