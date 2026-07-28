# 09 — Step 5 服务端 FFmpeg 视频合成

**What to build:** 新建 `POST /api/render/ffmpeg` 端点，接收 ArtificialVideoEditor 前端提交的 Timeline JSON 载荷，在服务端调用原生 FFmpeg 执行多轨道合成：视频切片、BGM 音频混入（含音量控制）、字幕压制（drawtext filter）、品牌 Stamp 水印叠加。合成完成后返回 MP4 文件下载链接。用户在 ArtificialVideoEditor 中编辑完点"导出"，几秒后下载到一个真实可播放的 MP4 文件。

**Blocked by:** 06 — Step 2 Seedance 视频, 08 — BGM 库 + Step 4 匹配

**Status:** ready-for-agent

- [ ] `POST /api/render/ffmpeg` 端点实现，接收 Timeline JSON
- [ ] FFmpeg 命令构建：视频输入 + 音频混入（volume filter）+ drawtext 字幕 + overlay Stamp
- [ ] 支持 3 种画面比例输出：9:16 (1080×1920) / 3:4 (1080×1440) / 1:1 (1080×1080)
- [ ] 合成产物写入 `uploads/renders/`，返回下载 URL
- [ ] 前端 ArtificialVideoEditor 的"导出"按钮连接到该端点
- [ ] 合成耗时在 3-6 秒短视频场景下不超过 10 秒
- [ ] FFmpeg 不可用时返回明确错误提示
