# Live-Tu 生产准入状态

更新时间：2026-07-29

## 最终目标

以多用户、可恢复、可追踪、成本受控的方式运行五步视频生产流水线。依赖故障、服务重启、页面关闭或单步失败后，任务状态和产物保持一致，最终视频可由授权用户访问。

## 已具备的硬门槛

| 领域 | 当前证据 |
|---|---|
| 生产构建与启动 | `npm run test:production` 会先构建，再验证静态前端、鉴权、权限、上传、备份恢复、限流与审计 |
| 身份与权限 | scrypt 密码、哈希会话、Secure/HttpOnly/SameSite Cookie、管理员/操作员隔离、至少保留一名管理员 |
| 数据库 | SQLite WAL、迁移 1–10、旧库带数据升级测试、业务所有权、媒体注册与外键 |
| 持久化编排 | 五步运行、幂等、取消、失败步骤恢复、外部任务等待与进程重启恢复 |
| 外部调用安全 | API 密钥 AES-256-GCM 加密；SSRF 防护；付费 POST 不在不确定错误后自动重提 |
| 成本控制 | 登录限流；高成本接口按用户限流；内部编排调用豁免 |
| 文件上传 | 图片、视频、BGM 均使用 multipart 流式上传；大小、MIME 和文件头校验 |
| 媒体安全 | `/uploads` 需要登录；供应商使用 HMAC 限时 URL；远程媒体仅 HTTPS 且禁止内网地址 |
| 对象存储 | MinIO 9000 宿主机/容器连通；生产桶默认私有；root 与应用服务账号分离；应用策略仅限目标 bucket |
| FFmpeg | 容器内真实合成通过；唯一输出文件名；路径、时长、片段数和滤镜文本边界 |
| 生命周期 | 素材/BGM 删除同步清理文件；上传失败补偿；产物、运行和审计保留脚本；备份 SHA-256 完整性校验 |
| 可观测性 | 请求 ID、结构化日志、Prometheus 指标、存活/就绪探针、优雅停机 |
| 前端 UX | 持久化任务中心、进度、错误、取消、失败恢复；通知中心；全局错误边界；核心弹窗焦点锁定、Escape 关闭和焦点恢复 |
| 容器 | 最新 `live-tu:production-audit` 镜像构建成功；非 root；最小运维脚本集；动态端口健康检查；SIGTERM 退出码 0 |
| CI | 类型、安全、迁移、编排、多镜头、生产启动、Docker、Compose/Caddy、Playwright |

## 已验证命令

```text
npm run lint
npm run test:security
npm run test:orchestrator
npm run test:migrations
npm run test:multi-shot
npm run test:production
npm run test:e2e:all
docker build -t live-tu:production-audit .
docker compose -f deploy/compose.production.yml config --quiet
caddy validate --config deploy/Caddyfile
```

真实 MinIO 验证：

- 容器访问 `host.docker.internal:9000/minio/health/ready` 返回 200。
- 私有对象匿名读取返回 403。
- 全新 Compose 卷可重复执行 `minio-init`；应用服务账号只能读写删除目标 bucket，
  `mc admin info` 返回 `Access Denied`。
- 应用素材 URL 保持 `/uploads/...`，匿名读取返回 401。
- 删除素材后数据库记录、本地文件与 MinIO 私有副本同步删除。
- 应用容器使用命名卷成功创建备份，独立新卷恢复成功。
- 故意篡改备份数据库后，恢复被 SHA-256 校验拒绝。
- 容器 SIGTERM 退出码为 0，重启后用户数据保持一致。

## 尚未完成的外部准入门槛

代码和本机容器不能替代以下真实环境证据：

1. 将 `APP_DOMAIN` 的 DNS 指向目标服务器。
2. 由 Caddy 成功签发真实 TLS 证书。
3. 在目标服务器配置独立生产密钥、供应商凭据和私有 MinIO 凭据。
4. 配置异机/异账号备份，并实际做一次恢复演练。
5. 接入指标抓取和告警通知。
6. 执行 10–20 个真实小流量任务，记录成功率、P95、成本、恢复率和成片可访问性。

## 上线阻断规则

出现任意一项时不得放量：

- `/api/ready` 非 200。
- `ALLOW_MOCK_FALLBACK=true`。
- 生产密钥缺失、过短或复用。
- MinIO bucket 存在匿名 `s3:GetObject`。
- 数据卷不可写或剩余空间低于 `MIN_FREE_STORAGE_BYTES`。
- 备份恢复演练失败。
- 五步真实任务不能完成，或最终视频无法由授权用户读取。
- 操作员可跨用户访问任务、素材、关键帧或管理全局配置。
- 监控、告警、DNS/TLS 或小流量试运行没有证据。
