# Live-Tu 部署文档

本文档面向运维人员，涵盖从零开始在一台新服务器上部署 Live-Tu 的完整步骤。

---

## 目录

1. [系统要求](#系统要求)
2. [架构概览](#架构概览)
3. [凭据清单](#凭据清单)
4. [快速部署（Demo 模式）](#快速部署demo-模式)
5. [生产部署（HTTPS + Caddy）](#生产部署https--caddy)
6. [验证部署](#验证部署)
7. [备份与恢复](#备份与恢复)
8. [更新与回滚](#更新与回滚)
9. [故障排查](#故障排查)
10. [本地开发环境](#本地开发环境)

---

## 系统要求

| 组件 | 最低要求 |
|------|---------|
| OS | Linux (Ubuntu 22.04+ / Debian 12+ 推荐) |
| Docker Engine | 24.0+ |
| Docker Compose | v2.20+ (集成在 Docker CLI 中) |
| 内存 | 2 GB+ |
| 磁盘 | 20 GB+（视频素材较大时需更多） |
| 网络 | 公网 IP 或域名（Seedance 视频生成需要回调下载首帧图） |
| 端口 | Demo: 3004; 生产: 80, 443 |

> **ffmpeg**：已包含在 Docker 镜像中（`apt-get install ffmpeg`），无需宿主机安装。

---

## 架构概览

```
┌─────────────────────────────────────────────────────┐
│                    Docker Compose                     │
│                                                       │
│  ┌─────────┐   ┌─────────┐   ┌───────────────────┐  │
│  │  Caddy  │──▶│   App   │──▶│      MinIO        │  │
│  │ (HTTPS) │   │ (Node)  │   │ (对象存储/素材)    │  │
│  └─────────┘   └─────────┘   └───────────────────┘  │
│       │              │                                │
│       │              ├── SQLite (data volume)         │
│       │              ├── uploads (volume)             │
│       │              └── ffmpeg (容器内置)            │
│       │                                              │
│  外部端口: 80/443 (生产) 或 3004 (Demo)              │
└─────────────────────────────────────────────────────┘

外部依赖:
├── 云雾 API (LLM 文案生成) ─── YUNWU_API_KEY
├── Seedance (AI 视频生成) ─── SEEDANCE_ACCOUNT/PASSWORD 或 ARK_API_KEY
└── [可选] yunshu.hk (备用视频通道)
```

---

## 凭据清单

部署前需准备以下凭据，填入 `.env` 文件。**绝不要将真实凭据提交到 git。**

### 必需凭据

| 变量名 | 用途 | 获取方式 |
|--------|------|---------|
| `ADMIN_USERNAME` | 管理后台登录用户名 | 自定义（不要用 admin） |
| `ADMIN_PASSWORD` | 管理后台登录密码 | 自定义强密码 |
| `MODEL_KEY_ENCRYPTION_SECRET` | 加密存储的模型密钥 | `openssl rand -hex 32` |
| `MEDIA_URL_SIGNING_SECRET` | 媒体文件签名 URL | `openssl rand -hex 32` |
| `METRICS_TOKEN` | 监控接口鉴权 | `openssl rand -hex 32` |
| `YUNWU_API_KEY` | 云雾 LLM API 密钥 | 云雾平台申请 |
| `SEEDANCE_BASE_URL` | Seedance 中转服务地址 | 供应商提供 |
| `SEEDANCE_ACCOUNT` | Seedance 账号（relay 模式） | 供应商提供 |
| `SEEDANCE_PASSWORD` | Seedance 密码（relay 模式） | 供应商提供 |
| `MINIO_ROOT_USER` | MinIO 管理员用户 | 自定义 |
| `MINIO_ROOT_PASSWORD` | MinIO 管理员密码 | `openssl rand -base64 24` |
| `MINIO_ACCESS_KEY` | MinIO 应用账号 | 自定义 |
| `MINIO_SECRET_KEY` | MinIO 应用密码 | `openssl rand -base64 24` |

### 可选凭据

| 变量名 | 用途 | 说明 |
|--------|------|------|
| `ARK_API_KEY` | 火山方舟 Seedance 直连 | `SEEDANCE_PROVIDER=ark` 时使用 |
| `YUNSHU_API_KEY` | yunshu.hk 备用通道 | 留空则复用 YUNWU_API_KEY |
| `DEMO_PUBLIC_UPLOAD_URL` | 自建上传中继地址 | 无公网域名时的备选方案 |
| `DEMO_PUBLIC_UPLOAD_TOKEN` | 中继服务鉴权 token | 与中继服务端配置一致 |

### 生成密钥示例

```bash
# 在部署服务器上执行
openssl rand -hex 32   # 用于 MODEL_KEY_ENCRYPTION_SECRET, MEDIA_URL_SIGNING_SECRET, METRICS_TOKEN
openssl rand -base64 24  # 用于 MINIO 密码
```

---

## 快速部署（Demo 模式）

适用于客户演示、内部测试。HTTP 直连，无 HTTPS。

### 1. 克隆代码

```bash
git clone <仓库地址> /opt/live-tu
cd /opt/live-tu/app
```

### 2. 创建环境文件

```bash
cp deploy/.env.demo.example deploy/.env.demo
```

编辑 `deploy/.env.demo`，填写所有 `replace-with-*` 的值：

```bash
# 必须修改的项
PUBLIC_BASE_URL=http://YOUR_SERVER_IP:3004    # 改为服务器公网 IP
ADMIN_USERNAME=your-admin-name
ADMIN_PASSWORD=your-strong-password
MODEL_KEY_ENCRYPTION_SECRET=<openssl rand -hex 32 的输出>
MEDIA_URL_SIGNING_SECRET=<openssl rand -hex 32 的输出>
METRICS_TOKEN=<openssl rand -hex 32 的输出>

# AI 功能凭据（不填则 UX 可演示但生成结果为 mock 占位）
YUNWU_API_KEY=<云雾 API Key>
SEEDANCE_BASE_URL=https://ai.xmhaini.com
SEEDANCE_ACCOUNT=<Seedance 账号>
SEEDANCE_PASSWORD=<Seedance 密码>

# MinIO 凭据
MINIO_ROOT_USER=minio-admin
MINIO_ROOT_PASSWORD=<强密码>
MINIO_ACCESS_KEY=live-tu-app
MINIO_SECRET_KEY=<强密码>
```

### 3. 验证配置并启动

```bash
# 检查配置是否有语法错误
docker compose --env-file deploy/.env.demo -f deploy/compose.demo.yml config --quiet

# 构建并启动
docker compose --env-file deploy/.env.demo -f deploy/compose.demo.yml up -d --build

# 查看状态
docker compose --env-file deploy/.env.demo -f deploy/compose.demo.yml ps
```

### 4. 验证

```bash
# 健康检查
curl --fail http://YOUR_SERVER_IP:3004/api/live

# 就绪检查（所有外部服务连通才 200）
curl --fail http://YOUR_SERVER_IP:3004/api/ready

# 查看日志
docker compose --env-file deploy/.env.demo -f deploy/compose.demo.yml logs --tail=50 app
```

浏览器打开 `http://YOUR_SERVER_IP:3004`，使用配置的管理员账号登录。

### 5. 停止

```bash
docker compose --env-file deploy/.env.demo -f deploy/compose.demo.yml down
# 加 -v 会删除所有数据卷（慎用）
```

---

## 生产部署（HTTPS + Caddy）

适用于正式交付。自动 HTTPS（Let's Encrypt），Caddy 反代。

### 前置条件

- 域名 A 记录已指向服务器 IP
- 防火墙开放 TCP 80, 443

### 1. 创建环境文件

```bash
cd /opt/live-tu/app
cp deploy/.env.demo.example deploy/.env.production
```

编辑 `deploy/.env.production`，关键差异：

```bash
# 域名（Caddy 自动签发 HTTPS 证书）
APP_DOMAIN=your-domain.com
ACME_EMAIL=ops@your-domain.com

# HTTPS 安全设置
COOKIE_SECURE=true
TRUST_PROXY=1

# 关闭 mock 回退
ALLOW_MOCK_FALLBACK=false

# 其他凭据同 Demo，但必须使用独立的强密码
```

### 2. 启动

```bash
docker compose --env-file deploy/.env.production -f deploy/compose.production.yml config --quiet
docker compose --env-file deploy/.env.production -f deploy/compose.production.yml up -d --build
```

### 3. 验证

```bash
curl --fail https://your-domain.com/api/live
curl --fail https://your-domain.com/api/ready
```

---

## 验证部署

部署后完整验证清单：

- [ ] `/api/live` 返回 200
- [ ] `/api/ready` 返回 200（登录后查看有无缺失项）
- [ ] 管理员可登录
- [ ] 上传素材成功（测试 MinIO 连通性）
- [ ] 创建任务 → Step 1 文案生成成功（测试 YUNWU API）
- [ ] Step 2 视频生成提交成功（测试 Seedance 连通性）
- [ ] Step 5 合成下载成功（测试 ffmpeg）
- [ ] 未登录用户访问 `/uploads/*` 返回 401

---

## 备份与恢复

### 备份

```bash
# Demo 模式
docker compose --env-file deploy/.env.demo -f deploy/compose.demo.yml exec app \
  npm run backup -- /var/lib/live-tu/backups/$(date +%F-%H%M%S)

# 生产模式
docker compose --env-file deploy/.env.production -f deploy/compose.production.yml exec app \
  npm run backup -- /var/lib/live-tu/backups/$(date +%F-%H%M%S)
```

建议：
- 每日定时备份
- 备份文件同步到其他主机或对象存储
- 不要只保留在同一 Docker volume 中

### 恢复

```bash
# 停止应用
docker compose ... stop app

# 恢复
docker compose ... run --rm app \
  npm run restore -- /var/lib/live-tu/backups/<backup-dir> --confirm

# 重启
docker compose ... up -d app
```

---

## 更新与回滚

### 更新

```bash
cd /opt/live-tu
git pull origin main

cd app
# 先备份
docker compose ... exec app npm run backup -- /var/lib/live-tu/backups/pre-update-$(date +%F)

# 重建并重启
docker compose ... up -d --build
```

### 回滚

数据库迁移只向前，回滚必须同时恢复数据库备份：

```bash
git checkout <previous-tag>
docker compose ... stop app
docker compose ... run --rm app npm run restore -- /var/lib/live-tu/backups/<backup> --confirm
docker compose ... up -d --build
```

---

## 故障排查

### 常见问题

| 现象 | 可能原因 | 解决 |
|------|---------|------|
| `/api/ready` 503 | 外部服务未配置或不通 | 登录后查看 ready 详情，检查凭据 |
| Step 2 "首帧不可达" | `PUBLIC_BASE_URL` 不是公网地址 | 确保 Seedance 能从公网下载首帧图 |
| 视频合成失败 | ffmpeg 问题（极罕见） | 查看 app 容器日志 |
| MinIO 连接失败 | 容器网络问题 | 检查 `docker compose ps`，确认 minio healthy |
| 登录失败 | 密码错误或 COOKIE_SECURE 配置不匹配 | HTTP 下 COOKIE_SECURE 必须 false |

### 查看日志

```bash
# 应用日志
docker compose ... logs --tail=200 app

# MinIO 日志
docker compose ... logs --tail=50 minio

# Caddy 日志（生产）
docker compose ... logs --tail=50 caddy

# 实时跟踪
docker compose ... logs -f app
```

### 进入容器调试

```bash
docker compose ... exec app sh
# 容器内可用: node, ffmpeg, curl
```

---

## 本地开发环境

适用于开发者本地运行（非 Docker）。

### 前置条件

- Node.js 24+
- npm 或 bun
- ffmpeg（需要手动安装）
- [可选] MinIO（Docker 单独运行，或留空跳过 MinIO 功能）

### 步骤

```bash
cd app

# 安装依赖
npm install

# 创建 .env
cp .env.example .env
# 编辑 .env，至少填写 YUNWU_API_KEY

# [可选] 启动 MinIO
docker run -d -p 9000:9000 -p 9001:9001 --name minio \
  minio/minio server /data --console-address ":9001"

# 启动开发服务器
npm run dev
# 访问 http://localhost:3004
```

### 本地 ffmpeg 安装

```bash
# Ubuntu/Debian
sudo apt-get install ffmpeg

# macOS
brew install ffmpeg

# Windows
# 下载 https://ffmpeg.org/download.html 并加入 PATH
```

---

## 文件结构说明

```
app/
├── deploy/                    # 部署配置
│   ├── compose.demo.yml       # Demo 模式 Compose
│   ├── compose.production.yml # 生产模式 Compose (含 Caddy HTTPS)
│   ├── .env.demo.example      # Demo 环境变量模板
│   ├── Caddyfile              # Caddy 反代配置
│   ├── DEMO_RUNBOOK.md        # Demo 运行手册
│   └── RUNBOOK.md             # 生产运行手册
├── .env.example               # 完整环境变量参考（含详细注释）
├── Dockerfile                 # 多阶段构建（含 ffmpeg）
├── compose.yml                # 简化版 Compose（单机不含 MinIO）
└── ...
```

---

## 安全注意事项

1. **绝不提交 `.env` 文件**：仓库中只有 `.env.example` 和 `deploy/.env.*.example`
2. **密钥独立生成**：每个环境使用独立的随机密钥，不要复用
3. **MinIO 桶保持私有**：应用通过签名 URL 提供限时访问
4. **生产必须 HTTPS**：`COOKIE_SECURE=true` + Caddy 自动证书
5. **定期轮换凭据**：特别是 AI 服务的 API Key
6. **监控 `/api/metrics`**：使用 METRICS_TOKEN 鉴权抓取
