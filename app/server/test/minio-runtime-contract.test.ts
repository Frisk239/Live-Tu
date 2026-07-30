import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureBucketReady } from '../lib/minio';

test('runtime bucket readiness works with a least-privilege application client', async () => {
  const applicationClient = {
    bucketExists: async (bucketName: string) => bucketName === 'tenant-media',
    makeBucket: async () => {
      throw new Error('existing bucket must not be recreated');
    },
  };

  await assert.doesNotReject(() =>
    ensureBucketReady(applicationClient as never, {
      bucketName: 'tenant-media',
      endpointKey: 'minio:9000',
    })
  );
});
