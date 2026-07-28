# 08 — BGM 库管理 + Step 4 语义匹配

**What to build:** BGM 库 REST CRUD API（`/api/bgm`），上传音频文件存入 `uploads/bgm/`，元数据存 SQLite `bgm_library`。Step 4 端点（`POST /api/pipeline/step4`）基于视频调性偏好 + 品牌风格，通过 LLM Gateway 从 SQLite `bgm_library` 候选库中语义匹配最佳 BGM，生成 BPM、推荐卡点点位（sync_point）与备选曲目。

**Blocked by:** 01 — SQLite 基础设施 + Server 路由拆分

**Status:** completed

- [x] BGM 库 REST CRUD API (`/api/bgm`) 实现
- [x] `POST /api/bgm/upload` 接收音频文件存入 `uploads/bgm/`，元数据存 SQLite `bgm_library`
- [x] `POST /api/pipeline/step4` 使用 LLM Gateway 基于视频调性 + 品牌风格，从 SQLite `bgm_library` 中语义匹配推荐最佳 BGM
- [x] 若本地 BGM 库匹配度低或未配置，Fallback 到 AI 音乐生成（预置乐库）
- [x] 前端 Step4Card 从 `/api/bgm` 异步加载 BGM 列表并渲染匹配得分
- [x] 支持在线试听 BGM 音频
