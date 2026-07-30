import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSafeRemoteUrl } from '../lib/safe-url';

test('rejects IPv4-mapped IPv6 targets for every non-public IPv4 range', async () => {
  const blocked = [
    'https://[::ffff:0.0.0.1]/media.mp4',
    'https://[::ffff:10.0.0.1]/media.mp4',
    'https://[::ffff:100.64.0.1]/media.mp4',
    'https://[::ffff:127.0.0.1]/media.mp4',
    'https://[::ffff:169.254.169.254]/latest/meta-data',
    'https://[::ffff:172.16.0.1]/media.mp4',
    'https://[::ffff:192.168.0.1]/media.mp4',
    'https://[::ffff:224.0.0.1]/media.mp4',
  ];
  for (const url of blocked) {
    await assert.rejects(() => assertSafeRemoteUrl(url), /内网/, url);
  }
});
