# 07 — Step 3 爆款文案 + 违禁词合规扫描

**What to build:** 升级 Step 3 端点：通过 LLM Gateway 生成爆款文案，从 SQLite 读取产品知识库的 3:4:3 模型数据、SGS 实证数据与自定义卖点注入 System Prompt。生成后自动从 SQLite 读取该产品的违禁词列表进行扫描，命中则在响应中附加 warning 标记。前端 Step3Card 显示违禁词命中提示。

**Blocked by:** 02 — LLM Gateway, 03 — 产品知识库

**Status:** ready-for-agent

- [ ] `POST /api/pipeline/step3` 改用 LLM Gateway
- [ ] System Prompt 包含从 SQLite 读取的 3:4:3 模型、SGS 数据、自定义卖点
- [ ] 生成后扫描 SQLite 中产品的 `prohibited_words` 列表
- [ ] 命中违禁词时响应包含 `warnings` 字段，列出命中的词与建议替换
- [ ] 前端 Step3Card 收到 warnings 时高亮显示违禁词提示
- [ ] 平台微调版（douyin / xiaohongshu）差异化调性生成正常
- [ ] LLM 调用失败时 graceful 降级到 mock 文案
