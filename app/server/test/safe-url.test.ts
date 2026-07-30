import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSafeRemoteUrl } from '../lib/safe-url';

test('accepts a public HTTPS address', async () => {
  const url = await assertSafeRemoteUrl('https://1.1.1.1/media.mp4');
  assert.equal(url.protocol, 'https:');
});

test('rejects localhost and private network targets', async () => {
  await assert.rejects(() => assertSafeRemoteUrl('https://127.0.0.1/media.mp4'), /内网/);
  await assert.rejects(() => assertSafeRemoteUrl('https://10.0.0.1/media.mp4'), /内网/);
  await assert.rejects(() => assertSafeRemoteUrl('https://[::1]/media.mp4'), /内网/);
});

test('rejects credentials, non-TLS URLs and non-standard ports', async () => {
  await assert.rejects(
    () => assertSafeRemoteUrl('https://user:secret@1.1.1.1/media.mp4'),
    /凭据/
  );
  await assert.rejects(() => assertSafeRemoteUrl('http://1.1.1.1/media.mp4'), /HTTPS/);
  await assert.rejects(() => assertSafeRemoteUrl('https://1.1.1.1:8443/media.mp4'), /端口/);
});
