import dns from 'node:dns/promises';
import net from 'node:net';

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

function mappedIpv4FromIpv6(address: string): string | null {
  let normalized = address.toLowerCase().split('%', 1)[0];
  const dottedSuffix = normalized.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dottedSuffix) {
    const octets = dottedSuffix[2].split('.').map(Number);
    if (
      octets.length !== 4 ||
      octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
    ) return null;
    normalized =
      `${dottedSuffix[1]}${((octets[0] << 8) | octets[1]).toString(16)}:` +
      `${((octets[2] << 8) | octets[3]).toString(16)}`;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  const right = halves.length === 2 && halves[1]
    ? halves[1].split(':').filter(Boolean)
    : [];
  const omitted = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (omitted < 0) return null;
  const segments = [
    ...left,
    ...Array.from({ length: omitted }, () => '0'),
    ...right,
  ];
  if (
    segments.length !== 8 ||
    segments.some((segment) => !/^[0-9a-f]{1,4}$/.test(segment))
  ) return null;
  const values = segments.map((segment) => Number.parseInt(segment, 16));
  if (
    values.slice(0, 5).some((segment) => segment !== 0) ||
    values[5] !== 0xffff
  ) return null;
  return [
    values[6] >> 8,
    values[6] & 0xff,
    values[7] >> 8,
    values[7] & 0xff,
  ].join('.');
}

function isPrivateIp(address: string): boolean {
  if (net.isIPv4(address)) return isPrivateIpv4(address);
  if (!net.isIPv6(address)) return true;
  const normalized = address.toLowerCase();
  const mappedIpv4 = mappedIpv4FromIpv6(normalized);
  if (mappedIpv4) return isPrivateIpv4(mappedIpv4);
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb') ||
    normalized.startsWith('ff')
  );
}

export async function assertSafeRemoteUrl(value: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw Object.assign(new Error('远程媒体 URL 无效'), { status: 400 });
  }

  if (parsed.protocol !== 'https:') {
    throw Object.assign(new Error('远程媒体只允许 HTTPS URL'), { status: 400 });
  }
  if (parsed.username || parsed.password) {
    throw Object.assign(new Error('远程媒体 URL 不允许包含账号凭据'), { status: 400 });
  }
  if (parsed.port && parsed.port !== '443') {
    throw Object.assign(new Error('远程媒体 URL 不允许使用非标准端口'), { status: 400 });
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw Object.assign(new Error('远程媒体 URL 不允许指向本机或内网'), { status: 400 });
  }

  const allowlist = String(process.env.REMOTE_MEDIA_HOST_ALLOWLIST || '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  if (
    allowlist.length > 0 &&
    !allowlist.some((allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`))
  ) {
    throw Object.assign(new Error('远程媒体域名不在允许列表中'), { status: 400 });
  }

  const addresses = net.isIP(hostname)
    ? [{ address: hostname }]
    : await dns.lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateIp(address))) {
    throw Object.assign(new Error('远程媒体 URL 解析到本机或内网地址'), { status: 400 });
  }
  return parsed;
}
