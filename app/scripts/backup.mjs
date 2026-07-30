import { cpSync, createReadStream, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { relative, resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const cwd = process.cwd();
const dataDir = resolve(process.env.DATA_DIR || join(cwd, 'data'));
const uploadsDir = resolve(process.env.UPLOADS_DIR || join(cwd, 'uploads'));
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupBase = resolve(process.env.BACKUP_DIR || join(cwd, 'backups'));
const backupRoot = resolve(process.argv[2] || join(backupBase, timestamp));
const databasePath = join(dataDir, 'pipeline.db');
const backupDatabasePath = join(backupRoot, 'pipeline.db');

if (!existsSync(databasePath)) {
  throw new Error(`数据库不存在: ${databasePath}`);
}
if (backupRoot === dataDir || backupRoot === uploadsDir) {
  throw new Error('备份目录不能与数据目录或上传目录相同');
}

mkdirSync(backupRoot, { recursive: true });
const db = new DatabaseSync(databasePath);
try {
  db.exec('PRAGMA wal_checkpoint(FULL)');
  const escapedTarget = backupDatabasePath.replaceAll("'", "''");
  db.exec(`VACUUM INTO '${escapedTarget}'`);
} finally {
  db.close();
}

if (existsSync(uploadsDir)) {
  cpSync(uploadsDir, join(backupRoot, 'uploads'), { recursive: true });
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

const backupFiles = [backupDatabasePath];
const copiedUploads = join(backupRoot, 'uploads');
if (existsSync(copiedUploads)) {
  for (const entry of readdirSync(copiedUploads, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) backupFiles.push(resolve(entry.parentPath, entry.name));
  }
}
const checksums = {};
for (const filePath of backupFiles) {
  checksums[relative(backupRoot, filePath).replaceAll('\\', '/')] = await sha256(filePath);
}

writeFileSync(
  join(backupRoot, 'manifest.json'),
  JSON.stringify(
    {
      format: 2,
      createdAt: new Date().toISOString(),
      database: 'pipeline.db',
      uploads: 'uploads',
      checksums,
    },
    null,
    2
  )
);

console.log(`Backup created: ${backupRoot}`);
