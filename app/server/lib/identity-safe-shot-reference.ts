/**
 * Boundary for visual references sent to external video generation providers.
 *
 * The viral source is useful for structure and composition, but it may contain
 * a recognisable person, subtitles, watermark, or competitor packaging.  Those
 * frames are allowed at the image-conditioning boundary only after the
 * product-conditioned first frame has been produced and checked.  They are
 * never forwarded as Seedance reference images.
 */

import type { ReferencePolicy } from './full-video-plan';

export interface IdentitySafeShotReferenceInput {
  shotIndex: number;
  referencePolicy: ReferencePolicy;
  safeKeyframeUrl?: string | null;
  continuityAnchorUrl?: string | null;
  productAssetUrls: string[];
}

export interface IdentitySafeShotReference {
  conditioningReferenceUrl: string;
  productAssetUrls: string[];
  providerReferenceImageUrls: [];
  rawReferenceForwarded: false;
  policy: ReferencePolicy;
}

export class IdentitySafeReferenceError extends Error {
  readonly code = 'identity_safe_reference_missing';
}

/**
 * Resolve the one safe visual anchor used by image conditioning.  The paid
 * video provider only receives the derived product-conditioned first frame.
 */
export function buildIdentitySafeShotReference(
  input: IdentitySafeShotReferenceInput
): IdentitySafeShotReference {
  const conditioningReferenceUrl =
    (input.referencePolicy === 'semantic_replacement'
      ? input.continuityAnchorUrl || input.safeKeyframeUrl
      : input.safeKeyframeUrl || input.continuityAnchorUrl) || '';
  if (!conditioningReferenceUrl) {
    throw new IdentitySafeReferenceError(
      `shot ${input.shotIndex} has no safe reference anchor for conditioning`
    );
  }
  if (!Array.isArray(input.productAssetUrls) || input.productAssetUrls.length === 0) {
    throw new IdentitySafeReferenceError(
      `shot ${input.shotIndex} has no product asset for conditioning`
    );
  }
  return {
    conditioningReferenceUrl,
    productAssetUrls: [...input.productAssetUrls],
    providerReferenceImageUrls: [],
    rawReferenceForwarded: false,
    policy: input.referencePolicy,
  };
}

export function assertIdentitySafeProviderInputs(input: {
  providerReferenceImageUrls?: string[] | null;
  rawReferenceForwarded?: boolean;
}): void {
  if (input.rawReferenceForwarded) {
    throw new IdentitySafeReferenceError('raw reference was marked as forwarded to provider');
  }
  if (Array.isArray(input.providerReferenceImageUrls) && input.providerReferenceImageUrls.length > 0) {
    throw new IdentitySafeReferenceError('provider reference image list must be empty for de-identified demo');
  }
}

