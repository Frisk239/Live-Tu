# 07 — Step 3 爆款文案 + 违禁词合规扫描

**What to build:** Step 3 文案生成 API（`POST /api/pipeline/step3`）接通 LLM Gateway，将 SQLite 中产品的 3:4:3 配方架构、SGS 实测数据与核心卖点注入 System Prompt；根据选定的平台（douyin / xiaohongshu）与人设调性生成带货脚本（title, hook, body, hashtags, cta, platform_fit）。生成后自动扫描 SQLite 中的 `prohibited_words` 列表，命中时在响应中追加 `warnings` 数组。前端 Step3Card 实时渲染合规警告 Alert，支持在"手机渲染"与"JSON 代码"间切换 preview。

**Blocked by:** 03 — 产品知识库持久化

**Status:** completed

- [x] `POST /api/pipeline/step3` 改用 LLM Gateway
- [x] System Prompt 包含从 SQLite 读取的 3:4:3 模型、SGS 数据、自定义卖点
- [x] 生成后扫描 SQLite 中产品的 `prohibited_words` 列表
- [x] 命中违禁词时响应包含 `warnings` 字段，列出命中的词与建议替换
- [x] 前端 Step3Card 收到 warnings 时高亮显示违禁词提示 Banner
- [x] 平台微调版（douyin / xiaohongshu）差异化调性生成正常
- [x] LLM 调用失败时 graceful 降级到 mock 文案（附带合规扫描）
