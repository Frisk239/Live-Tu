/**
 * 集中式 typed 环境配置（资产发布链路）。
 *
 * 所有资产发布相关环境变量只在本模块读取；旧变量保留兼容并有明确弃用说明，
 * 不静默改变用户现有配置。变更语义时打印 deprecation 警告并写入返回结构。
 */

export type DemoPublisherSetting = 'imgur' | 'litterbox' | 'off';

export interface AssetPublicationConfig {
  /** 正式路径 1：部署域名/公网 IP 站点根（/uploads 签名 URL 的来源） */
  publicBaseUrl: string | null;
  /** 本地 uploads 根目录 */
  uploadsDir: string;
  /**
   * 正式路径 2：自建公网上传中继（用户自有宿主）。
   * @deprecated 变量名 DEMO_PUBLIC_UPLOAD_URL 来自早期演示期命名；语义不变，
   * 保留兼容。新配置建议迁移到 PUBLIC_BASE_URL（部署域名），中继仅作无域名的
   * 自建宿主方案保留。
   */
  relayUrl: string | null;
  /** @deprecated 见 relayUrl（DEMO_PUBLIC_UPLOAD_TOKEN） */
  relayToken: string | null;
  /**
   * 第三方图床开关（imgur/litterbox）。
   * @deprecated DEMO_ASSET_PUBLISHER=auto 的历史语义是「自动回退到第三方图床」，
   * P5 起 auto 不再隐含第三方回退（第三方图床不得成为默认/自动回退的生产行为）：
   * auto → 按 off 处理并打印弃用警告；只有显式 imgur / litterbox 才启用对应
   * test/demo adapter。
   */
  demoPublisher: DemoPublisherSetting;
  /** 用户原始取值（'auto'/'imgur'/'litterbox'/'off'/空），供日志与报告使用 */
  demoPublisherRaw: string;
}

function textValue(env: Record<string, string | undefined>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = env[key];
    if (value && value.trim().length > 0) return value.trim();
  }
  return null;
}

/** 读取资产发布配置（默认从 process.env 读取；测试可注入自定义 env） */
export function loadAssetPublicationConfig(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>
): AssetPublicationConfig {
  const publicBaseUrl = textValue(env, 'PUBLIC_BASE_URL', 'APP_PUBLIC_URL');
  // APP_PUBLIC_URL 为历史别名（@deprecated）：与 PUBLIC_BASE_URL 语义一致，保留兼容。
  const relayUrl = textValue(env, 'DEMO_PUBLIC_UPLOAD_URL');
  const relayToken = textValue(env, 'DEMO_PUBLIC_UPLOAD_TOKEN');
  const demoPublisherRaw = (env.DEMO_ASSET_PUBLISHER || 'off').trim().toLowerCase();

  let demoPublisher: DemoPublisherSetting = 'off';
  if (demoPublisherRaw === 'imgur' || demoPublisherRaw === 'litterbox') {
    demoPublisher = demoPublisherRaw;
  } else if (demoPublisherRaw === 'auto') {
    // P5：'auto' 弃用——不再自动回退第三方图床。显式警告一次，按 off 处理。
    if (!(globalThis as { __p5DemoPublisherWarned?: boolean }).__p5DemoPublisherWarned) {
      console.warn(
        '[asset-publication] DEMO_ASSET_PUBLISHER=auto 已弃用：不再自动回退 imgur/litterbox。' +
          '生产路径请配置 PUBLIC_BASE_URL 或自建中继；如需 test/demo 通道请显式设为 imgur 或 litterbox。'
      );
      (globalThis as { __p5DemoPublisherWarned?: boolean }).__p5DemoPublisherWarned = true;
    }
  }

  return {
    publicBaseUrl,
    uploadsDir: env.UPLOADS_DIR || 'uploads',
    relayUrl,
    relayToken,
    demoPublisher,
    demoPublisherRaw,
  };
}
