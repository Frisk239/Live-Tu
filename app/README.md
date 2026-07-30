# Live-Tu Demo 部署指南

这份文档给驻点运维同事使用。目标是在一台安装了 Docker 的电脑或服务器上快速启动一套客户体验 Demo，让客户可以登录、浏览工作台、素材库、模板库、任务中心和管理页面，并收集体验反馈。

Demo 使用独立 Docker 数据卷。MinIO 只在 Compose 内网提供对象存储，不需要占用宿主机的 9000/9001 端口。

## 1. 环境要求

- Git
- Docker Desktop 或 Docker Engine + Compose v2
- 至少 4 GB 可用内存、20 GB 可用磁盘
- 宿主机开放 Demo 端口，默认是 `3004`

如果服务器的 3004 已被占用，可以在环境文件中改成其他端口，例如 `DEMO_PORT=3304`。

## 2. 获取代码

```bash
git clone <GitHub仓库地址>
cd Live-Tu/app
```

Windows PowerShell 示例：

```powershell
git clone <GitHub仓库地址>
Set-Location Live-Tu\app
```

## 3. 配置 Demo

复制环境变量模板：

```bash
cp deploy/.env.demo.example deploy/.env.demo
```

Windows PowerShell：

```powershell
Copy-Item deploy\.env.demo.example deploy\.env.demo
```

编辑 `deploy/.env.demo`，至少修改这些值：

- `PUBLIC_BASE_URL`：客户实际访问的地址，例如 `http://203.0.113.10:3004`
- `ADMIN_USERNAME` / `ADMIN_PASSWORD`：客户演示管理员账号，必须修改默认占位值
- `MODEL_KEY_ENCRYPTION_SECRET`
- `MEDIA_URL_SIGNING_SECRET`
- `METRICS_TOKEN`
- `MINIO_ROOT_PASSWORD`
- `MINIO_SECRET_KEY`

### 两种演示模式

没有正式模型密钥时：

```dotenv
ALLOW_MOCK_FALLBACK=true
```

客户可以完整点击体验界面和流程，但生成的视频/图片是占位结果，不能当作真实效果演示。

要演示真实生成结果，需要填写：

```dotenv
YUNWU_API_KEY=真实密钥
SEEDANCE_BASE_URL=真实地址
SEEDANCE_ACCOUNT=真实账号
SEEDANCE_PASSWORD=真实密码
ALLOW_MOCK_FALLBACK=false
```

如果通过 HTTPS 反向代理访问：

```dotenv
COOKIE_SECURE=true
TRUST_PROXY=1
PUBLIC_BASE_URL=https://demo.example.com
```

不要把 `deploy/.env.demo` 提交到 GitHub，它包含密码和密钥。

## 4. 启动

先校验 Compose 配置：

```bash
docker compose --env-file deploy/.env.demo -f deploy/compose.demo.yml config --quiet
```

启动 Demo：

```bash
docker compose --env-file deploy/.env.demo -f deploy/compose.demo.yml up -d --build
```

查看容器状态：

```bash
docker compose --env-file deploy/.env.demo -f deploy/compose.demo.yml ps
```

首次启动会自动完成：

1. 构建应用镜像
2. 启动 MinIO
3. 创建 Demo bucket 和最小权限应用账号
4. 创建 SQLite 数据库和权限种子
5. 启动应用服务

## 5. 验证

浏览器打开 `PUBLIC_BASE_URL`，使用 `.env.demo` 中的管理员账号登录。

命令行检查服务：

```bash
curl --fail "$PUBLIC_BASE_URL/api/live"
```

预期返回：

```json
{"status":"alive","shuttingDown":false}
```

查看应用日志：

```bash
docker compose --env-file deploy/.env.demo -f deploy/compose.demo.yml logs --tail=100 app
```

查看 MinIO 初始化日志：

```bash
docker compose --env-file deploy/.env.demo -f deploy/compose.demo.yml logs minio-init
```

## 6. 客户演示重点

- 登录后进入工作台
- 浏览素材库、模板库、任务中心
- 使用管理员进入 BGM、模型配置和品牌知识库
- 验证刷新、退出登录、重新登录后的状态清理
- 如果使用 operator 账号，BGM、模型配置、品牌知识库入口应隐藏，直接调用对应 API 应返回 403

本地开发测试账号 `haini / 888` 是 operator，不要作为客户管理员账号使用。客户管理员必须使用 `.env.demo` 中配置的新账号和密码。

## 7. 停止、更新和清理

停止容器但保留数据卷：

```bash
docker compose --env-file deploy/.env.demo -f deploy/compose.demo.yml down
```

拉取新版本并更新：

```bash
git pull
docker compose --env-file deploy/.env.demo -f deploy/compose.demo.yml up -d --build
```

确认不再需要这套 Demo、连同数据一起清理：

```bash
docker compose --env-file deploy/.env.demo -f deploy/compose.demo.yml down -v
```

`down -v` 会删除 Demo 的数据库、上传素材、备份和 MinIO 数据，请确认客户反馈已经导出后再执行。

## 8. 备份

在删除或升级 Demo 前先备份：

```bash
docker compose --env-file deploy/.env.demo -f deploy/compose.demo.yml exec app \
  npm run backup -- /var/lib/live-tu/backups/$(date +%F-%H%M%S)
```

备份目录位于 `live-tu-demo-backups` Docker volume。重要客户素材不要只保留在同一台机器上，应额外复制到其他主机或对象存储。

## 9. 常见问题

### `required variable ... is missing`

说明 `.env.demo` 没有创建，或仍有必填项为空。重新检查：

```bash
docker compose --env-file deploy/.env.demo -f deploy/compose.demo.yml config --quiet
```

### 端口被占用

把 `.env.demo` 中的 `DEMO_PORT=3004` 改成例如 `DEMO_PORT=3304`，然后重新执行启动命令。

### 页面能打开但真实生成失败

检查是否配置了 YUNWU 和 Seedance 的真实密钥；如果只是做界面体验，将 `ALLOW_MOCK_FALLBACK` 保持为 `true`。

### 容器启动失败

```bash
docker compose --env-file deploy/.env.demo -f deploy/compose.demo.yml logs --tail=200 app minio minio-init
```

## 10. 生产环境提醒

这套 Compose 是客户体验 Demo，不是最终生产部署方案。正式上线必须使用 `deploy/compose.production.yml`，配置域名和 HTTPS，关闭 mock fallback，使用独立生产密钥，并建立异机备份。
