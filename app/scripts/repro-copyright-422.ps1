# =============================================================================
# P0 probe 复现脚本：Seedance 中转 422 "copyright restrictions" 错误复现
#
# 用途：给同事/中转方提供最小可复现用例。素材 URL 是 P0 真实 probe 中被中转
#       422 拒绝的同一批素材（仍公网可达，可独立验证）。
#
# 复现链路：
#   1) 读 .env（SEEDANCE_BASE_URL / SEEDANCE_ACCOUNT / SEEDANCE_PASSWORD）
#   2) POST /api/v1/auth/token 拿 accessToken
#   3) 提交 ①带视频素材 ②带图片素材 ③纯文本对照 三个请求
#   4) 打印每个请求的完整响应（含 Request ID），供同事定位
#
# 用法（在 app 目录下）：
#   powershell -ExecutionPolicy Bypass -File scripts/repro-copyright-422.ps1
# 或带参数（同事机器无 .env 时）：
#   powershell -ExecutionPolicy Bypass -File scripts/repro-copyright-422.ps1 `
#     -BaseUrl "https://your-relay" -Account "user" -Password "pass"
# =============================================================================

param(
    [string]$BaseUrl = "",
    [string]$Account = "",
    [string]$Password = ""
)

$ErrorActionPreference = "Stop"

# ---- 1. 配置：优先参数，其次 app/.env ----
if (-not $BaseUrl -or -not $Account -or -not $Password) {
    $envFile = Join-Path $PSScriptRoot "..\.env"
    if (-not (Test-Path $envFile)) {
        Write-Host "[FAIL] 未提供 -BaseUrl/-Account/-Password，且未找到 $envFile" -ForegroundColor Red
        exit 1
    }
    $envMap = @{}
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') {
            $envMap[$matches[1]] = $matches[2]
        }
    }
    if (-not $BaseUrl)  { $BaseUrl  = $envMap["SEEDANCE_BASE_URL"] }
    if (-not $Account)  { $Account  = $envMap["SEEDANCE_ACCOUNT"] }
    if (-not $Password) { $Password = $envMap["SEEDANCE_PASSWORD"] }
}
$BaseUrl = $BaseUrl.TrimEnd('/')
if (-not $BaseUrl -or -not $Account -or -not $Password) {
    Write-Host "[FAIL] SEEDANCE_BASE_URL / SEEDANCE_ACCOUNT / SEEDANCE_PASSWORD 不完整" -ForegroundColor Red
    exit 1
}
Write-Host "[1/4] 中转: $BaseUrl  账号: $Account"

# ---- 2. 拿 accessToken ----
Write-Host "[2/4] 获取 accessToken ..."
$tokenBody = @{ account = $Account; password = $Password } | ConvertTo-Json
try {
    $tokenRes = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/v1/auth/token" `
        -ContentType "application/json" -Body $tokenBody -TimeoutSec 30
} catch {
    Write-Host "[FAIL] token 获取失败: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
$accessToken = $tokenRes.data.accessToken
if (-not $accessToken) {
    Write-Host "[FAIL] 响应无 accessToken: $($tokenRes | ConvertTo-Json -Depth 5)" -ForegroundColor Red
    exit 1
}
Write-Host "[2/4] token 获取成功（长度 $($accessToken.Length)）"

# ---- 3. 四个请求体（素材 URL 为 P0 真实被拒素材，仍公网可达）----
$videoUrl = "http://64.83.1.104/live-tu-assets/derived/1786068657932_882879e5.mp4"
$imageUrl = "http://64.83.1.104/live-tu-assets/derived/1786068698142_174e10b6.png"
# ④ 对照：无人物产品图（P3 成功路径使用的同类素材——产品主图，无人物/无字幕）
$productImageUrl = "http://64.83.1.104/live-tu-assets/derived/1786067060787_d3664092.png"

$commonPrompt = "复刻参考视频的镜头与动作，BUV 小绿泥洁面 产品清晰可见。 The source video contains burned-in subtitles and watermarks. Do NOT copy, reproduce, or render any text, subtitle, caption, watermark, logo, or character from the source."

$requests = @(
    @{ name = "① 带视频素材 (kind=video)";
       body = @{ model = "doubao-seedance-2-0-fast"; prompt = $commonPrompt;
                 params = @{ duration = 5; resolution = "720p"; aspectRatio = "9:16"; generateAudio = $true };
                 materials = @(@{ url = $videoUrl; kind = "video"; label = "reference_subclip" }) } },
    @{ name = "② 带图片素材（含人物控制图，kind=image, role=first_frame）";
       body = @{ model = "doubao-seedance-2-0-fast"; prompt = $commonPrompt;
                 params = @{ duration = 5; resolution = "720p"; aspectRatio = "9:16"; generateAudio = $true };
                 materials = @(@{ url = $imageUrl; kind = "image"; role = "first_frame"; label = "product_control_image" }) } },
    @{ name = "③ 纯文本对照（无 materials）";
       body = @{ model = "doubao-seedance-2-0-fast"; prompt = "一个 5 秒竖屏带货短视频：绿色洗面奶产品特写，产品清晰可见，无文字。";
                 params = @{ duration = 5; resolution = "720p"; aspectRatio = "9:16"; generateAudio = $true } } },
    @{ name = "④ 无人物产品图对照（kind=image, role=first_frame）——用于验证「人像检测」假设";
       body = @{ model = "doubao-seedance-2-0-fast"; prompt = "产品特写短视频：绿色洗面奶包装清晰可见，无文字。";
                 params = @{ duration = 5; resolution = "720p"; aspectRatio = "9:16"; generateAudio = $true };
                 materials = @(@{ url = $productImageUrl; kind = "image"; role = "first_frame"; label = "product_shot" }) } }
)

# ---- 4. 逐个提交并打印完整响应 ----
Write-Host "[3/4] 开始提交 4 个请求（③区分账号/通道问题，④区分人像检测）..."
$i = 0
foreach ($req in $requests) {
    $i++
    Write-Host "`n[4/4] === $($req.name) ===" -ForegroundColor Cyan
    Write-Host "  POST $BaseUrl/api/v1/videos/generations"
    Write-Host "  body: $($req.body | ConvertTo-Json -Depth 6 -Compress)"
    try {
        $resp = Invoke-WebRequest -Method Post -Uri "$BaseUrl/api/v1/videos/generations" `
            -Headers @{ Authorization = "Bearer $accessToken" } `
            -ContentType "application/json" `
            -Body ($req.body | ConvertTo-Json -Depth 6) -TimeoutSec 120
        Write-Host "  → HTTP $($resp.StatusCode)" -ForegroundColor Green
        Write-Host "  → $($resp.Content)"
    } catch {
        # PowerShell 5.1 对非 2xx 抛 WebException；422 的响应体在异常流里
        $status = 0
        $respBody = ""
        if ($_.Exception.Response) {
            try {
                $status = [int]$_.Exception.Response.StatusCode
                $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
                $respBody = $reader.ReadToEnd()
            } catch {}
        } elseif ($_.Exception -is [System.Net.Http.HttpRequestException]) {
            # PowerShell 7+：HttpRequestException，响应在 inner 或消息中
            $status = "n/a"
            $respBody = $_.Exception.Message
        }
        Write-Host "  → HTTP $status" -ForegroundColor Yellow
        Write-Host "  → $respBody"
    }
}

Write-Host "`n=== 复现完成：请把以上输出（含 Request ID）发给中转方/同事 ===" -ForegroundColor Green
