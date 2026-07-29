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

  // 确保 Bucket 存在且设置为可读
  const exists = await client.bucketExists(bucketName).catch(() => false);
  if (!exists) {
    await client.makeBucket(bucketName, 'us-east-1');
    const policy = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { AWS: ['*'] },
          Action: ['s3:GetObject'],
          Resource: [`arn:aws:s3:::${bucketName}/*`],
        },
      ],
    };
    await client.setBucketPolicy(bucketName, JSON.stringify(policy)).catch(() => {});
  }

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
