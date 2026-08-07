/**
 * S3 确定性真实样例配置（demo fixture）
 *
 * 只被 demo runner / 验收脚本 / 相关测试引用；通用业务逻辑绝不 import 本文件
 * （通用代码一律从请求/数据库读取素材）。
 * Manifest URL 用于启动前验证素材大小与 SHA-256（失败即拒绝运行，防止素材被替换）。
 */
import crypto from 'node:crypto';

export const REAL_DEMO_MANIFEST_URL = 'http://64.83.1.104/live-tu-assets/manifest.json';

export interface RealDemoSample {
  sampleId: string;
  sampleName: string;
  /** 一级输入 1：爆款参考视频 */
  referenceVideoUrl: string;
  /** 一级输入 2：产品图（一张或多张） */
  productAssetUrls: string[];
  /** 可选产品文字信息 */
  productName: string;
  productPositioning: string;
  productPrice: string;
  /** 视频总长（ffprobe 实测 78.25s） */
  videoDurationSec: number;
  /** manifest 期望条目（大小 + SHA-256） */
  manifestExpectations: Array<{
    path: string;
    size: number;
    sha256: string;
  }>;
}

export const REAL_DEMO_SAMPLE: RealDemoSample = {
  sampleId: 'real-viral-buv-2shot',
  sampleName: '爆款复刻真实 Demo（2 镜）',
  referenceVideoUrl: 'http://64.83.1.104/live-tu-assets/viral/viral-reference-01.mp4',
  productAssetUrls: ['http://64.83.1.104/live-tu-assets/products/buv-product-front.png'],
  productName: 'BUV 小绿泥洁面',
  productPositioning: '油皮专研 · 温和净澈',
  productPrice: '49元/件',
  videoDurationSec: 78.25,
  manifestExpectations: [
    {
      path: 'viral/viral-reference-01.mp4',
      size: 98155935,
      sha256: '913fcc39bafc5192e11a84c263f4f68cd5a0df941c196f48d2553a0ee05564cf',
    },
    {
      path: 'products/buv-product-front.png',
      size: 1264120,
      sha256: 'eeb218699c3c40a8f0f9f86a34706a7cffcdcb1e761004188f419ef2c9fb518f',
    },
  ],
};

export interface ManifestVerification {
  ok: boolean;
  errors: string[];
  matched: string[];
}

/**
 * 拉取 manifest.json 并校验每个期望条目的大小与 SHA-256。
 * 失败返回具体原因（素材被替换/不可达），由 demo runner 决定是否拒绝运行。
 */
export async function verifyRealDemoManifest(opts?: {
  manifestUrl?: string;
  fetchFn?: typeof fetch;
}): Promise<ManifestVerification> {
  const manifestUrl = opts?.manifestUrl || REAL_DEMO_MANIFEST_URL;
  const fetchFn = opts?.fetchFn ?? fetch;
  const errors: string[] = [];
  const matched: string[] = [];
  let manifest: any = null;
  try {
    const res = await fetchFn(manifestUrl, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      errors.push(`manifest 不可达：HTTP ${res.status}`);
      return { ok: false, errors, matched };
    }
    manifest = await res.json();
  } catch (e: any) {
    errors.push(`manifest 拉取失败：${e?.message?.slice(0, 200) || e}`);
    return { ok: false, errors, matched };
  }
  const files: Array<{ path: string; size: number; sha256: string }> = manifest.files ?? [];
  for (const expect of REAL_DEMO_SAMPLE.manifestExpectations) {
    const entry = files.find((f) => f.path === expect.path);
    if (!entry) {
      errors.push(`manifest 缺少条目 ${expect.path}`);
      continue;
    }
    const sizeOk = Number(entry.size) === expect.size;
    if (!sizeOk) errors.push(`${expect.path} 大小不符：manifest=${entry.size} 期望=${expect.size}`);
    const hashOk = String(entry.sha256 || '').toLowerCase() === expect.sha256.toLowerCase();
    if (!hashOk) errors.push(`${expect.path} SHA-256 不符：manifest=${entry.sha256} 期望=${expect.sha256}`);
    if (sizeOk && hashOk) matched.push(expect.path);
  }
  return { ok: matched.length === REAL_DEMO_SAMPLE.manifestExpectations.length, errors, matched };
}

/** 下载并校验一个素材的 SHA-256 与大小（demo 启动前对实际文件做真实性校验） */
export async function verifyRealAsset(opts: {
  url: string;
  expectedSize: number;
  expectedSha256: string;
}): Promise<{ ok: boolean; error?: string; size: number; sha256: string }> {
  try {
    const res = await fetch(opts.url, { signal: AbortSignal.timeout(180_000) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, size: 0, sha256: '' };
    const buf = Buffer.from(await res.arrayBuffer());
    const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    const size = buf.length;
    if (size !== opts.expectedSize) {
      return { ok: false, error: `大小不符：实际 ${size}，期望 ${opts.expectedSize}`, size, sha256 };
    }
    if (sha256 !== opts.expectedSha256.toLowerCase()) {
      return { ok: false, error: `SHA-256 不符：实际 ${sha256}`, size, sha256 };
    }
    return { ok: true, size, sha256 };
  } catch (e: any) {
    return { ok: false, error: e?.message?.slice(0, 200) || String(e), size: 0, sha256: '' };
  }
}
