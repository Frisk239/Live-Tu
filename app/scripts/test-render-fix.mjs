import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { register } from 'node:module';

// Use dynamic import via tsx by spawning is easier - pure node call via child
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const result = spawnSync(
  'npx',
  [
    'tsx',
    '--import',
    './load-env.ts',
    '-e',
    `
import { runFfmpegRender, resolveDrawtextFontFile } from './server/routes/render.ts';
console.log('FONT=' + resolveDrawtextFontFile());
const r = await runFfmpegRender({
  aspectRatio: '9:16',
  videoSourceUrl: '/uploads/renders/e2e_valid_source.mp4',
  subtitles: [{ text: 'e2e hello green mud' }, { text: 'SGS oil control' }],
  brandStamp: 'BUV cleanser',
  outputFilename: 'e2e_step5_fixed.mp4',
  durationSec: 3,
});
console.log('RESULT=' + JSON.stringify(r));
`,
  ],
  { cwd: process.cwd(), encoding: 'utf8', shell: true, timeout: 120000 }
);

console.log('stdout:', result.stdout);
console.log('stderr:', result.stderr?.slice?.(0, 800));
console.log('status:', result.status);

const out = path.join(process.cwd(), 'uploads', 'renders', 'e2e_step5_fixed.mp4');
if (fs.existsSync(out)) console.log('file size', fs.statSync(out).size);
