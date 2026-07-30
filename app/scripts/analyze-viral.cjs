const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const dir = path.join(process.cwd(), '爆款视频');
if (!fs.existsSync(dir)) {
  console.log('Directory not found:', dir);
  process.exit(1);
}

const files = fs.readdirSync(dir).filter(f => f.match(/\.(mp4|mov)$/i));
console.log(`Found ${files.length} viral video files:\n`);

for (const f of files) {
  const full = path.join(dir, f);
  try {
    const out = execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration,format_name', '-show_streams', '-of', 'json', full],
      { encoding: 'utf8' }
    );
    const data = JSON.parse(out);
    const dur = parseFloat(data.format?.duration || 0).toFixed(1);
    const vStream = (data.streams || []).find(s => s.codec_type === 'video');
    const aStream = (data.streams || []).find(s => s.codec_type === 'audio');
    const res = vStream ? `${vStream.width}x${vStream.height}` : 'unknown';
    const fps = vStream?.r_frame_rate || '30/1';
    
    console.log(`📹 视频: ${f}`);
    console.log(`   - 时长: ${dur} 秒`);
    console.log(`   - 分辨率: ${res}`);
    console.log(`   - 帧率: ${fps}`);
    console.log(`   - 音频轨: ${aStream ? '有 (' + aStream.codec_name + ')' : '无'}`);
    console.log('--------------------------------------------------');
  } catch (e) {
    console.log(`📹 视频: ${f} | 错误: ${e.message}`);
  }
}
