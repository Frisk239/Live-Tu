import { runFfmpegRender, resolveDrawtextFontFile, resolveFfmpegBinary } from '../server/routes/render.ts';

console.log('FFMPEG=', resolveFfmpegBinary());
console.log('FONT=', resolveDrawtextFontFile());

const r = await runFfmpegRender({
  aspectRatio: '9:16',
  videoSourceUrl: '/uploads/renders/e2e_valid_source.mp4',
  subtitles: [{ text: 'e2e hello 小绿泥' }, { text: 'SGS 8h 控油' }],
  brandStamp: 'BUV 笔薇 小绿泥洁面',
  outputFilename: 'e2e_step5_fixed.mp4',
  durationSec: 3,
});

console.log(JSON.stringify(r, null, 2));
if (!r.success) process.exit(1);
