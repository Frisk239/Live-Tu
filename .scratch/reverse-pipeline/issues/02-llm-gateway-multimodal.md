# 02 — LLM Gateway 可切换网关 + 多模态 Vision

**What to build:** 创建 `server/lib/llm-gateway.ts` 模块，从 SQLite `model_config` 表读取当前选中模型的 `baseUrl` 和 `apiKey`，动态路由到对应 Provider（云雾代理 / DeepSeek / OpenAI / Google Gemini 等），所有 Provider 统一走 OpenAI 兼容 `chat/completions` 协议。支持多模态 Vision 输入：当传入图片 URL 时，构建 `{type: "image_url", image_url: {url: "..."}}` content block；无图时退化为纯文本。前端模型配置中心 UI 保存的设置写入 SQLite 并真实生效。

**Blocked by:** 01 — SQLite 基础设施 + Server 路由拆分

**Status:** ready-for-agent

- [ ] `llm-gateway.ts` 模块实现，接受 `{system, user, imageUrl?, modelId?}` 参数
- [ ] 从 SQLite `model_config` 表读取 baseUrl/apiKey 并动态构建请求
- [ ] 传入 imageUrl 时，请求 payload 包含 `image_url` 类型的 content block
- [ ] 未传入 imageUrl 时，退化为纯文本 messages
- [ ] 前端模型配置中心的保存操作写入 SQLite，下次 AI 调用使用新配置
- [ ] Provider 级别的错误处理与超时重试逻辑
- [ ] 测试：mock 上游 HTTP，验证请求格式（含多模态和纯文本两种场景）
