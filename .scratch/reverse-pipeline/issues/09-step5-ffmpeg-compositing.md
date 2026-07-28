# 09 — Step 5 服务端 FFmpeg 视频合成

**What to build:** 服务端视频合成引擎与接口（`POST /api/pipeline/step5` 与 `POST /api/render/ffmpeg`）。判断系统 PATH 是否含有 FFmpeg 可执行文件，若存在则执行真实的 FFmpeg 视频拼接、音频合轨与水印压制；若系统未安装 FFmpeg，优雅降级为 BUV 服务端渲染引擎，将导出的成片 MP4 保存至 `uploads/renders/v_{timestamp}.mp4`，并返回可播放的 `videoUrl` 与 `downloadUrl`。前端 Step5Card 实时呈现成片预览、下载 Brief 及导出命令行。

**Blocked by:** 06, 07, 08 — 上游 Step 2、Step 3、Step 4 产物

**Status:** completed

- [x] 服务端安装/确认 FFmpeg 可用性与降级引擎
- [x] `POST /api/pipeline/step5` 接收 Timeline JSON，在服务端执行视频合成
- [x] 导出 MP4 文件存入 `uploads/renders/` 目录
- [x] 生成可访问的播放 URL (`/uploads/renders/v_xxx.mp4`)
- [x] 优雅降级为服务端高保真成片渲染
- [x] 前端 Step5Card 包含播放器、时间轴与 QA 质检清单
- [x] 提供成片与 Brief 下载功能
