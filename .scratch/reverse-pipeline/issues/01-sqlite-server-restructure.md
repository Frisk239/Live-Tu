# 01 — SQLite 基础设施 + Server 路由拆分

**What to build:** 引入 Node.js 原生 `node:sqlite` (DatabaseSync) 嵌入式数据库，创建 `server/lib/db.ts` 模块完成建库建表（products、materials、bgm_library、tasks、model_config、presets 六张表）；将单体 856 行 `server.ts` 拆分为独立路由模块（`server/lib/db.ts`、`server/routes/pipeline.ts`、`server/routes/seedance.ts`、`server/routes/models.ts`、`server/routes/materials.ts`、`server/routes/tasks.ts`、`server/routes/products.ts`、`server/routes/bgm.ts`、`server/routes/render.ts`）。Health 端点返回 `{ status: "ok", db: "connected" }`，服务器启动正常且所有现有功能不破坏。

**Blocked by:** None — can start immediately.

**Status:** completed

- [x] Node.js 24 原生 `node:sqlite` (DatabaseSync) 正常连接，数据库文件创建在 `app/data/pipeline.db`
- [x] 六张 SQLite 表全部建立，含 BUV 小绿泥种子数据（products 表）
- [x] `server.ts` 拆分为 9 个独立路由与工具模块文件
- [x] `GET /api/health` 返回 `{ status: "ok", db: "connected" }`
- [x] `npx tsc --noEmit` 0 报错通过，启动后所有原有端点仍正常响应
- [x] `uploads/materials/` 和 `uploads/bgm/` 目录自动创建
