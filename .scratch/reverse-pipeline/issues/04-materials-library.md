# 04 — 素材库端到端持久化

**What to build:** 素材库的完整端到端持久化。文件上传 API（`POST /api/materials/upload`）将文件存入 `uploads/materials/` 目录，元数据写入 SQLite `materials` 表；`GET /api/materials` 返回素材列表；`DELETE /api/materials/:id` 删除素材（含磁盘文件）。前端素材库 UI（MaterialsPageView + MaterialManagerModal）从 API 读写，替换当前的内存 state。上传一张图片后刷新页面，素材列表仍可见该图片并可预览。

**Blocked by:** 01 — SQLite 基础设施 + Server 路由拆分

**Status:** ready-for-agent

- [ ] `POST /api/materials/upload` 接收 multipart/form-data，文件存入 `uploads/materials/`
- [ ] 上传时自动检测媒体类型（video/image）、文件大小，写入 `materials` 表
- [ ] `GET /api/materials` 返回 SQLite 中所有素材的元数据列表
- [ ] `DELETE /api/materials/:id` 同时删除数据库记录和磁盘文件
- [ ] Express 静态文件服务配置，使 `uploads/` 目录下的文件可通过 URL 访问
- [ ] 前端 MaterialsPageView 从 API 加载，上传后刷新仍可见
- [ ] Step 1 的"从素材库选择"功能正常联动
