import { LlmQualityScorer } from '../server/lib/viral-probe-runner.ts';
import path from "node:path";
import { publishAsset } from '../server/lib/asset-publisher.ts';

async function main() {
  const scorer = new LlmQualityScorer();
  const frameUrls: string[] = [];
  const dir = path.resolve(process.cwd(), "../p0-evidence/final-qa");
  for (const t of [1, 5, 10, 15, 20, 25, 29]) {
    const p = `${dir}/frame_${t}s.png`;
    try {
      const pub = await publishAsset({ localPath: p, ownerId: 'admin', purpose: 'qa-frame' });
      frameUrls.push(pub.url);
    } catch (e: any) {
      console.log('publish fail', t, String(e?.message || e).slice(0, 90));
    }
  }
  console.log('published frames:', frameUrls.length);
  if (frameUrls.length === 0) { console.log('无可用帧 URL'); return; }
  const score = await scorer.scoreResult({
    condition: 'video+control-image',
    frameUrls,
    productName: 'BUV 小绿泥洁面',
  });
  console.log('FINAL SCORE:', JSON.stringify(score, null, 2));
}
main().catch((e) => console.error('ERR', e.message));
