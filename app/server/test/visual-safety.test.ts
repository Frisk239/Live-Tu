import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

const tempRoot = mkdtempSync(path.join(tmpdir(), 'live-tu-visual-safety-'));
process.env.DATA_DIR = path.join(tempRoot, 'data');
process.env.UPLOADS_DIR = path.join(tempRoot, 'uploads');
process.env.YUNWU_BASE_URL = 'https://visual-safety.test';
process.env.YUNWU_API_KEY = 'visual-safety-test-key';

const { initDatabase, db } = await import('../lib/db.ts');
initDatabase();
const {
  evaluateVisualSafety,
  requireVisualSafetyPass,
  VisualSafetyViolationError,
} = await import('../lib/visual-safety.ts');

const OWNER = 'visual-safety-owner';
const URL = 'https://assets.example.test/derived/frame.png';
let originalFetch: typeof globalThis.fetch;

function responseFor(verdicts: unknown[]): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ verdicts }) } }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

before(() => {
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', 'operator')`).run(OWNER, OWNER);
  originalFetch = globalThis.fetch;
});

after(() => {
  globalThis.fetch = originalFetch;
  delete process.env.YUNWU_BASE_URL;
  delete process.env.YUNWU_API_KEY;
  try {
    db.close();
    rmSync(tempRoot, { recursive: true, force: true });
  } catch {}
});

test('visual safety treats incomplete or unknown verdict payloads as unverified', async () => {
  globalThis.fetch = async () => responseFor([
    { kind: 'unrecognized', present: false, confidence: 0.99 },
  ]);
  const assessment = await evaluateVisualSafety(URL, { sha256: 'd'.repeat(64) });
  assert.equal(assessment.status, 'unverified');
  assert.equal(assessment.verdicts.length, 0);
});

test('visual safety accepts only a complete five-category all-clear result bound to a hash', async () => {
  globalThis.fetch = async () => responseFor([
    { kind: 'face', present: false, confidence: 0.99 },
    { kind: 'person', present: false, confidence: 0.99 },
    { kind: 'subtitle_overlay', present: false, confidence: 0.99 },
    { kind: 'watermark', present: false, confidence: 0.99 },
    { kind: 'competitor_branding', present: false, confidence: 0.99 },
  ]);
  const assessment = await evaluateVisualSafety(URL, { sha256: 'd'.repeat(64) });
  assert.equal(assessment.status, 'pass');
  assert.equal(assessment.sha256, 'd'.repeat(64));
});

test('a pass without a digest, or with mutated local bytes, cannot cross the provider boundary', () => {
  const localPath = path.join(tempRoot, 'frame.png');
  writeFileSync(localPath, 'first version');
  const hash = createHash('sha256').update('first version').digest('hex');
  db.prepare(
    `INSERT INTO conditioned_first_frames
       (id, owner_id, conditioned_first_frame_url, product_asset_urls_json, local_path, provider, model, prompt_version, prompt,
        safety_status, safety_evidence, safety_version, sha256)
     VALUES ('safety-cff', ?, ?, '[]', ?, 'test', 'test', 'v2', 'x', 'pass', 'test', 'v2', NULL)`
  ).run(OWNER, URL, localPath);

  assert.throws(
    () => requireVisualSafetyPass(OWNER, URL, 'first-frame'),
    (error: unknown) => error instanceof VisualSafetyViolationError && error.safetyStatus === 'unverified'
  );

  db.prepare(`UPDATE conditioned_first_frames SET sha256 = ? WHERE id = 'safety-cff'`).run(hash);
  assert.doesNotThrow(() => requireVisualSafetyPass(OWNER, URL, 'first-frame'));

  writeFileSync(localPath, 'mutated version');
  assert.throws(
    () => requireVisualSafetyPass(OWNER, URL, 'first-frame'),
    (error: unknown) => error instanceof VisualSafetyViolationError && error.safetyStatus === 'unverified'
  );
});
