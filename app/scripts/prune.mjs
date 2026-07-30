import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { resolve, join, relative, isAbsolute, parse } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const confirmed = process.argv.includes('--confirm');
const cwd = process.cwd();
const dataDir = resolve(process.env.DATA_DIR || join(cwd, 'data'));
const uploadsDir = resolve(process.env.UPLOADS_DIR || join(cwd, 'uploads'));
const databasePath = join(dataDir, 'pipeline.db');
const artifactDays = Math.max(1, Number(process.env.ARTIFACT_RETENTION_DAYS || 30));
const runDays = Math.max(1, Number(process.env.RUN_RETENTION_DAYS || 90));
const auditDays = Math.max(1, Number(process.env.AUDIT_RETENTION_DAYS || 365));

if (!existsSync(databasePath)) throw new Error(`Database not found: ${databasePath}`);
if (uploadsDir === parse(uploadsDir).root || uploadsDir === dataDir) {
  throw new Error(`Unsafe uploads directory: ${uploadsDir}`);
}

const db = new DatabaseSync(databasePath);
const references = new Set();
for (const row of db.prepare(
  `SELECT url AS value FROM materials
   UNION SELECT file_path AS value FROM materials
   UNION SELECT uri AS value FROM artifacts
   UNION SELECT audio_url AS value FROM bgm_library
   UNION SELECT audio_path AS value FROM bgm_library`
).all()) {
  const value = String(row.value || '').replaceAll('\\', '/');
  if (!value) continue;
  const marker = '/uploads/';
  const index = value.indexOf(marker);
  const relativeValue = index >= 0 ? value.slice(index + marker.length) : value.replace(/^uploads\//, '');
  if (relativeValue && !relativeValue.startsWith('http')) references.add(relativeValue);
}

const artifactCutoff = Date.now() - artifactDays * 24 * 60 * 60 * 1000;
const candidates = [];
if (existsSync(uploadsDir)) {
  for (const entry of readdirSync(uploadsDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const absolutePath = resolve(entry.parentPath, entry.name);
    const relativePath = relative(uploadsDir, absolutePath).replaceAll('\\', '/');
    if (
      !relativePath ||
      relativePath.startsWith('../') ||
      isAbsolute(relativePath) ||
      references.has(relativePath)
    ) {
      continue;
    }
    if (statSync(absolutePath).mtimeMs < artifactCutoff) candidates.push(absolutePath);
  }
}

const oldRuns = db.prepare(
  `SELECT COUNT(*) AS count
     FROM pipeline_runs
    WHERE status IN ('completed', 'failed', 'cancelled')
      AND updated_at < datetime('now', ?)`
).get(`-${runDays} days`).count;
const oldAudits = db.prepare(
  `SELECT COUNT(*) AS count
     FROM audit_logs
    WHERE created_at < datetime('now', ?)`
).get(`-${auditDays} days`).count;

if (confirmed) {
  for (const candidate of candidates) {
    const resolved = resolve(candidate);
    const relativeTarget = relative(uploadsDir, resolved);
    if (!relativeTarget || relativeTarget.startsWith('..') || isAbsolute(relativeTarget)) {
      throw new Error(`Refusing unsafe deletion target: ${resolved}`);
    }
    unlinkSync(resolved);
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `DELETE FROM pipeline_runs
        WHERE status IN ('completed', 'failed', 'cancelled')
          AND updated_at < datetime('now', ?)`
    ).run(`-${runDays} days`);
    db.prepare(`DELETE FROM audit_logs WHERE created_at < datetime('now', ?)`).run(
      `-${auditDays} days`
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
db.close();

console.log(JSON.stringify({
  mode: confirmed ? 'deleted' : 'dry-run',
  unreferencedArtifactFiles: candidates.length,
  expiredRuns: Number(oldRuns),
  expiredAuditLogs: Number(oldAudits),
  artifactRetentionDays: artifactDays,
  runRetentionDays: runDays,
  auditRetentionDays: auditDays,
}, null, 2));
