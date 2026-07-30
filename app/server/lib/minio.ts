import * as Minio from 'minio';
import dotenv from 'dotenv';
import path from 'node:path';

function minioConfig() {
  dotenv.config({ path: path.join(process.cwd(), '.env') });
  dotenv.config({ path: path.join(process.cwd(), 'app', '.env') });

  return {
    endPoint: process.env.MINIO_ENDPOINT || '',
    port: process.env.MINIO_PORT ? Number(process.env.MINIO_PORT) : 9000,
    useSSL: process.env.MINIO_USE_SSL === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY || '',
    secretKey: process.env.MINIO_SECRET_KEY || '',
    bucketName: process.env.MINIO_BUCKET || 'buv-materials',
    publicUrl: (process.env.MINIO_PUBLIC_URL || '').replace(/\/$/, ''),
  };
}

export function isMinioConfigured(): boolean {
  const { endPoint, accessKey, secretKey } = minioConfig();
  return Boolean(endPoint && accessKey && secretKey && !accessKey.startsWith('your_'));
}

let minioClientInstance: Minio.Client | null = null;
let initializedBucketKey = '';

function getMinioClient(): Minio.Client | null {
  if (!isMinioConfigured()) return null;
  if (!minioClientInstance) {
    const { endPoint, port, useSSL, accessKey, secretKey } = minioConfig();
    minioClientInstance = new Minio.Client({
      endPoint,
      port,
      useSSL,
      accessKey,
      secretKey,
    });
  }
  return minioClientInstance;
}

export async function probeMinio(): Promise<{
  configured: boolean;
  ready: boolean;
  bucketName: string;
  publicUrl: string;
  error?: string;
}> {
  const config = minioConfig();
  if (!isMinioConfigured()) {
    return {
      configured: false,
      ready: false,
      bucketName: config.bucketName,
      publicUrl: config.publicUrl,
    };
  }
  try {
    const client = getMinioClient()!;
    await ensureBucketReady(client);
    const bucketExists = await Promise.race([
      client.bucketExists(config.bucketName),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('MinIO probe timeout')), 5_000)
      ),
    ]);
    return {
      configured: true,
      ready: bucketExists,
      bucketName: config.bucketName,
      publicUrl: config.publicUrl,
      ...(!bucketExists ? { error: `bucket ${config.bucketName} does not exist` } : {}),
    };
  } catch (error: any) {
    return {
      configured: true,
      ready: false,
      bucketName: config.bucketName,
      publicUrl: config.publicUrl,
      error: String(error?.message || error),
    };
  }
}

async function ensureBucketReady(client: Minio.Client): Promise<void> {
  const { bucketName, endPoint, port } = minioConfig();
  const bucketKey = `${endPoint}:${port}:${bucketName}:${process.env.MINIO_ENSURE_PUBLIC_READ !== 'false'}`;
  if (initializedBucketKey === bucketKey) return;

  const exists = await client.bucketExists(bucketName);
  if (!exists) await client.makeBucket(bucketName, 'us-east-1');

  const ensurePublicRead = process.env.MINIO_ENSURE_PUBLIC_READ === 'true';
  let policy: { Version?: string; Statement?: any[] } = {};
  try {
    policy = JSON.parse(await client.getBucketPolicy(bucketName));
  } catch {
    policy = {};
  }
  const statements = Array.isArray(policy.Statement)
    ? policy.Statement.filter((statement) => statement?.Sid !== 'LiveTuPublicMaterials')
    : [];
  if (ensurePublicRead) {
    statements.push({
      Sid: 'LiveTuPublicMaterials',
      Effect: 'Allow',
      Principal: { AWS: ['*'] },
      Action: ['s3:GetObject'],
      Resource: [`arn:aws:s3:::${bucketName}/materials/*`],
    });
  }
  await client.setBucketPolicy(
    bucketName,
    JSON.stringify({
      Version: policy.Version || '2012-10-17',
      Statement: statements,
    })
  );
  initializedBucketKey = bucketKey;
}

/**
 * 上传文件到 MinIO 存储桶，并返回可公开访问的完整 HTTPS/HTTP 链接
 */
export async function uploadToMinio(
  filename: string,
  buffer: Buffer,
  contentType: string = 'image/png'
): Promise<string> {
  const client = getMinioClient();
  if (!client) {
    throw new Error('MinIO 未配置完全，请在 .env 中指定 MINIO_ENDPOINT / ACCESS_KEY / SECRET_KEY');
  }

  const { bucketName, publicUrl, endPoint, port, useSSL } = minioConfig();

  await ensureBucketReady(client);

  const objectName = `materials/${Date.now()}_${filename.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
  await client.putObject(bucketName, objectName, buffer, buffer.length, {
    'Content-Type': contentType,
  });

  if (publicUrl) {
    return `${publicUrl}/${bucketName}/${objectName}`;
  }

  const protocol = useSSL ? 'https' : 'http';
  const hostPort = (port === 80 || port === 443) ? endPoint : `${endPoint}:${port}`;
  return `${protocol}://${hostPort}/${bucketName}/${objectName}`;
}

export async function uploadFileToMinio(
  filename: string,
  filePath: string,
  contentType: string
): Promise<string> {
  const client = getMinioClient();
  if (!client) {
    throw new Error('MinIO 未配置完全，请在 .env 中指定 MINIO_ENDPOINT / ACCESS_KEY / SECRET_KEY');
  }
  const { bucketName, publicUrl, endPoint, port, useSSL } = minioConfig();
  await ensureBucketReady(client);
  const objectName = `materials/${Date.now()}_${filename.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
  await client.fPutObject(bucketName, objectName, filePath, { 'Content-Type': contentType });

  if (publicUrl) return `${publicUrl}/${bucketName}/${objectName}`;
  const protocol = useSSL ? 'https' : 'http';
  const hostPort = port === 80 || port === 443 ? endPoint : `${endPoint}:${port}`;
  return `${protocol}://${hostPort}/${bucketName}/${objectName}`;
}

export async function deleteMinioObjectByUrl(url: string): Promise<boolean> {
  const client = getMinioClient();
  if (!client || !url) return false;
  const { bucketName, publicUrl, endPoint, port, useSSL } = minioConfig();

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  const allowedOrigins = new Set<string>();
  if (publicUrl) {
    try {
      allowedOrigins.add(new URL(publicUrl).origin);
    } catch {}
  }
  const protocol = useSSL ? 'https' : 'http';
  const hostPort = port === 80 || port === 443 ? endPoint : `${endPoint}:${port}`;
  allowedOrigins.add(`${protocol}://${hostPort}`);
  if (!allowedOrigins.has(parsed.origin)) return false;

  const segments = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (segments[0] !== bucketName) return false;
  const objectName = segments.slice(1).join('/');
  if (!objectName.startsWith('materials/') || objectName.includes('..')) return false;

  await client.removeObject(bucketName, objectName);
  return true;
}
