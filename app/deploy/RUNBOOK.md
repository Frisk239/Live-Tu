# Live-Tu 生产部署运行手册

## 前置条件

- 一个公网 DNS A/AAAA 记录指向部署主机：
  - `APP_DOMAIN`：应用与限时签名素材入口。
- 防火墙仅开放 TCP 80/443 和 UDP 443。
- 生产 Compose 自带固定镜像摘要的私有 MinIO；9000/9001 不映射到宿主机。
- MinIO 桶保持私有。供应商所需素材由应用的限时 HMAC URL 提供。
- Docker Engine 与 Compose v2 可用。

## 首次部署

1. 将 `.env.production.example` 复制为 `.env.production`，填写所有空值并使用独立随机密钥。
2. 分别配置非默认、高强度且互不复用的 `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`
   和 `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY`。一次性 `minio-init` 服务会创建目标
   bucket、应用服务账号和仅限该 bucket 的读写删除策略；应用容器不持有 root 凭据。
3. 验证配置：

   ```bash
   docker compose --env-file .env.production -f compose.production.yml config --quiet
   ```

4. 构建并启动：

   ```bash
   docker compose --env-file .env.production -f compose.production.yml up -d --build
   ```

5. 验证：

   ```bash
   curl --fail "https://${APP_DOMAIN}/api/live"
   curl --fail "https://${APP_DOMAIN}/api/ready"
   docker compose --env-file .env.production -f compose.production.yml exec app \
     node -e "fetch('http://minio:9000/minio/health/ready').then(r=>process.exit(r.ok?0:1))"
   ```

## 发布前门禁

- `docker compose ps` 中 `app` 为 healthy，`caddy` 为 running。
- 匿名 `/api/health` 不暴露供应商地址。
- 管理员登录、操作员权限隔离、任务取消和失败步骤恢复均正常。
- 已登录用户可读取本人素材；未登录 `/uploads/*` 返回 401。
- MinIO bucket policy 不包含匿名 `s3:GetObject`。
- 完整五步真实任务完成，成片可鉴权下载。
- 备份与恢复回演成功。

## 备份

建议每天在维护窗口执行，并将备份目录同步到另一台主机或对象存储：

```bash
docker compose --env-file .env.production -f compose.production.yml exec app \
  npm run backup -- /var/lib/live-tu/backups/$(date +%F-%H%M%S)
```

生产备份不能只保留在同一个 Docker volume。

恢复前停止应用并先保留当前数据。确认备份路径后执行：

```bash
docker compose --env-file .env.production -f compose.production.yml stop app
docker compose --env-file .env.production -f compose.production.yml run --rm app \
  npm run restore -- /var/lib/live-tu/backups/<backup-directory> --confirm
docker compose --env-file .env.production -f compose.production.yml up -d app
```

恢复后必须重新检查 `/api/ready`、管理员登录、任务历史和一条成片下载。

## 数据保留

先做 dry-run：

```bash
docker compose --env-file .env.production -f compose.production.yml exec app npm run prune
```

确认清单后执行：

```bash
docker compose --env-file .env.production -f compose.production.yml exec app \
  npm run prune -- --confirm
```

## 更新和回滚

更新前先备份，然后：

```bash
docker compose --env-file .env.production -f compose.production.yml build app
docker compose --env-file .env.production -f compose.production.yml up -d app
```

数据库迁移只向前执行。回滚应用前必须同时使用对应版本的数据库备份进行恢复，不能仅回退镜像。

## 监控与告警

- 抓取 `/api/metrics` 时使用 `Authorization: Bearer <METRICS_TOKEN>`。
- 至少配置：
  - `/api/ready` 连续失败。
  - HTTP 5xx 比例。
  - 流水线失败率。
  - 数据卷剩余容量。
  - Seedance 等待超时。
  - 备份任务失败。
