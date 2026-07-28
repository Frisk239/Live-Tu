# 08 — BGM 库管理 + Step 4 语义匹配

**What to build:** BGM 库的完整端到端实现。`bgm_library` 表 CRUD API + BGM 管理 UI（在模型中心或独立视图中管理曲目元数据与音频文件上传至 `uploads/bgm/`）。Step 4 端点升级：从 SQLite 读取 BGM 库全量元数据，连同 Step 3 的文案标题与调性偏好发送给 LLM Gateway，LLM 从库中选择最匹配的曲目返回。推荐结果的 track_name 必须来自库中已有曲目。

**Blocked by:** 02 — LLM Gateway, 01 — SQLite 基础设施

**Status:** ready-for-agent

- [ ] `POST /api/bgm/upload` 上传音频文件到 `uploads/bgm/`，元数据写入 `bgm_library` 表
- [ ] `GET /api/bgm` 返回 BGM 库列表（含试听 URL）
- [ ] `DELETE /api/bgm/:id` 删除记录与音频文件
- [ ] BGM 管理 UI 可添加/删除/预览曲目
- [ ] `POST /api/pipeline/step4` 从 SQLite 读取 BGM 库元数据作为 LLM 上下文
- [ ] LLM 返回的推荐 track_name 出自库中已有曲目（非编造）
- [ ] BGM 库为空时返回提示信息（提醒运营先添加曲目，或标注 AI 生成回退路径）
