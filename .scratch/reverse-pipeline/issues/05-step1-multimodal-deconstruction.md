# 05 — Step 1 多模态视觉拆解

**What to build:** 升级 Step 1 反推端点，通过 LLM Gateway 发送多模态请求（包含用户上传的图片），同时从 SQLite 读取当前选中产品的知识库信息注入 System Prompt。AI 实际"看到"用户上传的图片内容，返回准确的结构化拆解 JSON（scene、subject、style、palette 等 10 个字段）。纯文本作为回退方案。

**Blocked by:** 02 — LLM Gateway, 03 — 产品知识库

**Status:** completed

- [x] `POST /api/pipeline/step1` 改用 LLM Gateway 而非硬编码 `chatJson`
- [x] 请求中包含用户上传图片的 URL（通过 `image_url` content block 发送给 Vision 模型）
- [x] System Prompt 从 SQLite 读取产品名称、定位、品牌视觉偏好并注入
- [x] 未上传图片时自动退化为纯文本模式（基于 viralReason 等文字描述）
- [x] 返回的 JSON 严格符合 `Step1Output` Schema（10 个字段全填，不许空字符串）
- [x] 批量队列（Batch Queue）仍正常工作
- [x] LLM 调用失败时 graceful 降级到 mock 数据
