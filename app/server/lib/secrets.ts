import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { db } from './db';

const PREFIX = 'enc:v1:';

function encryptionKey(): Buffer {
  const configuredSecret = process.env.MODEL_KEY_ENCRYPTION_SECRET || '';
  if (!configuredSecret) {
    throw new Error('未配置 MODEL_KEY_ENCRYPTION_SECRET，无法安全保存模型密钥');
  }
  const secret = configuredSecret;
  if (process.env.NODE_ENV === 'production' && secret.length < 32) {
    throw new Error('生产环境 MODEL_KEY_ENCRYPTION_SECRET 至少需要 32 个字符');
  }
  return createHash('sha256').update(secret).digest();
}

export function isMaskedSecret(value: string): boolean {
  return !value || value === '••••••••' || value.includes('***');
}

export function encryptSecret(value: string): string {
  if (!value) return '';
  if (value.startsWith(PREFIX)) return value;
  if (!process.env.MODEL_KEY_ENCRYPTION_SECRET && process.env.NODE_ENV !== 'production') {
    return value;
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64url')}:${tag.toString('base64url')}:${encrypted.toString('base64url')}`;
}

export function decryptSecret(value: string): string {
  if (!value) return '';
  if (!value.startsWith(PREFIX)) return value;

  const [ivEncoded, tagEncoded, dataEncoded] = value.slice(PREFIX.length).split(':');
  if (!ivEncoded || !tagEncoded || !dataEncoded) {
    throw new Error('模型密钥密文格式无效');
  }

  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(),
    Buffer.from(ivEncoded, 'base64url')
  );
  decipher.setAuthTag(Buffer.from(tagEncoded, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataEncoded, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export function migrateStoredModelSecrets() {
  if (!process.env.MODEL_KEY_ENCRYPTION_SECRET && process.env.NODE_ENV !== 'production') return;
  if (!process.env.MODEL_KEY_ENCRYPTION_SECRET) encryptionKey();
  const rows = db.prepare(
    "SELECT id, api_key FROM model_config WHERE api_key IS NOT NULL AND api_key != ''"
  ).all() as Array<{ id: string; api_key: string }>;
  const update = db.prepare('UPDATE model_config SET api_key = ? WHERE id = ?');

  for (const row of rows) {
    if (!row.api_key.startsWith(PREFIX)) {
      update.run(encryptSecret(row.api_key), row.id);
    }
  }
}
