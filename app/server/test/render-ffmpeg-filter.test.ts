import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildFFmpegCommand } from '../routes/render';

describe('Ticket 12 — FFmpeg 多轨字幕与品牌水印 Filter Chain 测试', () => {
  it('buildFFmpegCommand 应正确包含 scale, crop, drawtext(字幕) 与 drawtext(水印)', () => {
    const cmd = buildFFmpegCommand({
      videoSourceUrl: '/uploads/materials/sample_v.mp4',
      audioSourceUrl: '/uploads/bgm/sample_a.mp3',
      targetPath: '/uploads/renders/output.mp4',
      aspectRatio: '9:16',
      subtitles: [
        { text: 'SGS实测强效控油' },
        { text: '自然清爽不紧绷' },
      ],
      brandStamp: 'BUV 沙利文国货榜首',
    });

    // ffmpeg 二进制路径因机器而异（PATH / WinGet / 自定义），断言从 -y 开始
    assert.ok(cmd.includes('-y -i "/uploads/materials/sample_v.mp4" -i "/uploads/bgm/sample_a.mp3"'));
    assert.ok(cmd.includes('scale=1080:1920'));
    assert.ok(cmd.includes('crop=1080:1920'));
    assert.ok(cmd.includes('drawtext=text=\'SGS实测强效控油\''));
    assert.ok(cmd.includes('drawtext=text=\'自然清爽不紧绷\''));
    assert.ok(cmd.includes('drawtext=text=\'BUV 沙利文国货榜首\''));
    assert.ok(cmd.includes('-c:v libx264'));
  });
});
