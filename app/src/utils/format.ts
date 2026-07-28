/**
 * Helper utilities for BUV Pipeline
 */

export function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).then(() => true).catch(() => false);
  } else {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
      document.execCommand('copy');
      textArea.remove();
      return Promise.resolve(true);
    } catch (error) {
      textArea.remove();
      return Promise.resolve(false);
    }
  }
}

export function downloadJsonFile(data: any, filename: string) {
  const jsonStr = JSON.stringify(data, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function downloadTextFile(text: string, filename: string) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function generateFFmpegCommand(timeline: any[], outputFilename: string = 'buv_output.mp4'): string {
  return `# BUV 小绿泥 爆款视频合成 FFmpeg 命令
# 输出文件: ${outputFilename}

ffmpeg -i input_video.mp4 -i bgm_audio.mp3 \\
  -filter_complex "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920[v]; [1:a]volume=0.3[a]" \\
  -map "[v]" -map "[a]" -c:v libx264 -preset fast -crf 22 -c:a aac -b:a 1920k -shortest ${outputFilename}
`;
}
