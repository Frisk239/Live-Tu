import {
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';

const backupRoot = process.argv[2] ? resolve(process.argv[2]) : '';
const confirmed = process.argv.includes('--confirm');
if (!backupRoot || !confirmed) {
  throw new Error('用法: npm run restore -- <备份目录> --confirm');
}

const manifestPath = join(backupRoot, 'manifest.json');
const backupDatabasePath = join(backupRoot, 'pipeline.db');
if (!existsSync(manifestPath) || !existsSync(backupDatabasePath)) {
  throw new Error('备份目录缺少 manifest.json 或 pipeline.db');
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (![1, 2].includes(manifest.format)) {
  throw new Error(`不支持的备份格式: ${manifest.format}`);
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

if (manifest.format === 2) {
  if (!manifest.checksums || typeof manifest.checksums !== 'object') {
    throw new Error('Backup manifest is missing checksums');
  }
  for (const [relativeName, expected] of Object.entries(manifest.checksums)) {
    const candidate = resolve(backupRoot, relativeName);
    const relativeCandidate = relative(backupRoot, candidate);
    if (
      !relativeCandidate ||
      relativeCandidate.startsWith('..') ||
      isAbsolute(relativeCandidate) ||
      !existsSync(candidate)
    ) {
      throw new Error(`Backup contains an invalid or missing file: ${relativeName}`);
    }
    const actual = await sha256(candidate);
    if (actual !== expected) {
      throw new Error(`Backup checksum mismatch: ${relativeName}`);
    }
  }
}

const cwd = process.cwd();
const dataDir = resolve(process.env.DATA_DIR || join(cwd, 'data'));
const uploadsDir = resolve(process.env.UPLOADS_DIR || join(cwd, 'uploads'));
const backupRelativeToData = relative(dataDir, backupRoot);
const backupRelativeToUploads = relative(uploadsDir, backupRoot);
if (
  (!backupRelativeToData.startsWith('..') && !isAbsolute(backupRelativeToData)) ||
  (!backupRelativeToUploads.startsWith('..') && !isAbsolute(backupRelativeToUploads))
) {
  throw new Error('备份目录不能位于待恢复的数据或上传目录内部');
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const quarantineData = join(dataDir, `.before-restore-${stamp}`);
const quarantineUploads = join(uploadsDir, `.before-restore-${stamp}`);

mkdirSync(dataDir, { recursive: true });
mkdirSync(quarantineData, { recursive: true });
for (const entry of readdirSync(dataDir)) {
  if (entry === `.before-restore-${stamp}`) continue;
  renameSync(join(dataDir, entry), join(quarantineData, entry));
}
cpSync(backupDatabasePath, join(dataDir, 'pipeline.db'));

const backupUploads = join(backupRoot, 'uploads');
if (existsSync(backupUploads)) {
  mkdirSync(uploadsDir, { recursive: true });
  mkdirSync(quarantineUploads, { recursive: true });
  for (const entry of readdirSync(uploadsDir)) {
    if (entry === `.before-restore-${stamp}`) continue;
    renameSync(join(uploadsDir, entry), join(quarantineUploads, entry));
  }
  cpSync(backupUploads, uploadsDir, { recursive: true, force: true });
}

console.log(
  `Restore completed. Previous data retained at: ${quarantineData}` +
    (existsSync(backupUploads) ? ` and ${quarantineUploads}` : '')
);
