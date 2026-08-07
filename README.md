# Live-Tu 部署教程

AI 短视频反推与生成工作台，一键 Docker 部署。

---

## 系统要求

- Docker Engine 24.0+
- Docker Compose v2.20+
- 公网 IP 或域名（Seedance 视频生成需回调下载首帧图）
- 内存 2GB+，磁盘 20GB+

> ffmpeg 已包含在 Docker 镜像中，无需宿主机单独安装。

---

## 快速部署（Demo 模式）

以下是实际验证过的完整流程。

### 1. 克隆代码

```bash
git clone https://github.com/Frisk239/Live-Tu.git /opt/live-tu
cd /opt/live-tu/app
```

### 2. 创建环境文件

```bash
cp deploy/.env.demo.example deploy/.env.demo
```

### 3. 编辑 `deploy/.env.demo`

填写以下内容（可直接复制修改 IP 和 AI 凭据）：

```bash
# 服务地址（改为你的服务器公网 IP）
DEMO_PORT=3004
PUBLIC_BASE_URL=http://YOUR_SERVER_IP:3004

# 管理员账号（默认测试账号）
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin123456!

# 安全密钥（用 openssl rand -hex 32 生成）
MODEL_KEY_ENCRYPTION_SECRET=a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4
MEDIA_URL_SIGNING_SECRET=f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1
METRICS_TOKEN=test-metrics-token-local-deployment-2026

# AI 服务（不填则启用 mock 模式，UI 可点击但生成内容为占位）
ALLOW_MOCK_FALLBACK=true
YUNWU_API_KEY=<你的云雾 API Key>
SEEDANCE_BASE_URL=https://ai.xmhaini.com
SEEDANCE_ACCOUNT=<Seedance 账号>
SEEDANCE_PASSWORD=<Seedance 密码>

# MinIO 对象存储（compose 自动启动，只需设置密码）
MINIO_ROOT_USER=demo-minio-root
MINIO_ROOT_PASSWORD=DemoMinioRoot2026!
MINIO_ACCESS_KEY=demo-minio-app
MINIO_SECRET_KEY=DemoMinioApp2026!!
MINIO_BUCKET=buv-materials-demo

# HTTP 模式（无 HTTPS 时必须这样配置）
COOKIE_SECURE=false
TRUST_PROXY=0
```

### 4. 国内网络：修改 Dockerfile npm 源（可选）

如果服务器在国内，Docker 构建时 npm 可能超时。编辑 `Dockerfile`，将两处 `RUN npm ci` 改为：

```dockerfile
# 构建阶段（第4行左右）
RUN npm config set registry https://registry.npmmirror.com && npm ci

# 运行时阶段（第15行左右）
RUN npm config set registry https://registry.npmmirror.com && npm ci --omit=dev && npm cache clean --force
```

同时将 `RUN npm run lint && npm run build` 改为 `RUN npm run build`（跳过 lint 加快构建）。

### 5. 构建并启动

```bash
docker compose --env-file deploy/.env.demo -f deploy/compose.demo.yml up -d --build
```

首次构建约需 1-2 分钟。启动后等待约 20 秒，所有服务 healthy。

### 6. 验证

```bash
# 查看容器状态（app 和 minio 都应为 healthy）
docker compose --env-file deploy/.env.demo -f deploy/compose.demo.yml ps

# 健康检查
curl http://YOUR_SERVER_IP:3004/api/live
# 应返回: {"status":"alive","shuttingDown":false}
```

### 7. 登录

浏览器打开 `http://YOUR_SERVER_IP:3004`

| 用户名 | 密码 | 角色 |
|--------|------|------|
| `admin` | `admin123456!` | 管理员 |

---

## 默认测试账号

| 环境 | 用户名 | 密码 | 角色 |
|------|--------|------|------|
| Demo/开发 | `admin` | `admin123456!` | 管理员 |
| Demo/开发 | `operator` | `admin123456!` | 操作员 |

> 生产环境必须通过环境变量配置独立强密码（≥12位）。

---

## 停止服务

```bash
docker compose --env-file deploy/.env.demo -f deploy/compose.demo.yml down
```

加 `-v` 会删除所有数据卷（包括数据库和上传文件），慎用。

---

## 凭据说明

| 凭据 | 用途 | 获取方式 |
|------|------|---------|
| `YUNWU_API_KEY` | 云雾 LLM API（文案生成） | 云雾平台申请 |
| `SEEDANCE_ACCOUNT/PASSWORD` | Seedance 视频生成 | 供应商提供 |
| `MODEL_KEY_ENCRYPTION_SECRET` | 加密存储的模型密钥 | `openssl rand -hex 32` |
| `MEDIA_URL_SIGNING_SECRET` | 媒体签名 URL | `openssl rand -hex 32` |
| `METRICS_TOKEN` | 监控接口鉴权 | `openssl rand -hex 32` |
| `MINIO_*` | MinIO 对象存储 | 自定义强密码 |

---

## 更多文档

- [完整部署文档](./DEPLOYMENT.md) — 生产 HTTPS 部署、备份恢复、更新回滚、故障排查
- [Demo 运行手册](./app/deploy/DEMO_RUNBOOK.md)
- [生产运行手册](./app/deploy/RUNBOOK.md)
- [环境变量完整参考](./app/.env.example)

---

## 项目结构

```
app/
├── deploy/                    # 部署配置
│   ├── compose.demo.yml       # Demo Compose（本教程使用）
│   ├── compose.production.yml # 生产 Compose（含 Caddy HTTPS）
│   ├── .env.demo.example      # Demo 环境变量模板
│   ├── Caddyfile              # Caddy 反代配置
│   └── RUNBOOK.md             # 运行手册
├── .env.example               # 完整环境变量参考
├── Dockerfile                 # 多阶段构建（含 ffmpeg）
└── ...                        # 应用源码
```
