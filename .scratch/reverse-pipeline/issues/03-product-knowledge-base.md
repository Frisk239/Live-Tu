# 03 — 产品知识库端到端持久化

**What to build:** 产品知识库的完整端到端持久化。`products` 表的 CRUD REST API（`/api/products` GET/POST/PUT/DELETE）+ 前端品牌知识库 UI（KnowledgePageView + BrandKnowledgeModal）从 SQLite 读写数据，替换当前的内存硬编码 `INITIAL_PRODUCTS`。运营在 UI 新增/编辑产品（名称、定位、3:4:3 模型、SGS 数据、违禁词列表、自定义卖点），刷新页面后数据仍在。

**Blocked by:** 01 — SQLite 基础设施 + Server 路由拆分

**Status:** ready-for-agent

- [ ] `GET /api/products` 返回 SQLite 中所有产品列表
- [ ] `POST /api/products` 创建新产品记录
- [ ] `PUT /api/products/:id` 更新产品（含 3:4:3 模型、SGS 数据、违禁词）
- [ ] `DELETE /api/products/:id` 删除产品
- [ ] 前端 KnowledgePageView 从 API 加载数据，不再使用 `INITIAL_PRODUCTS` 硬编码
- [ ] 编辑产品后刷新页面，修改后的数据仍然保留
- [ ] 种子数据：BUV 小绿泥洁面完整记录在数据库初始化时自动插入
