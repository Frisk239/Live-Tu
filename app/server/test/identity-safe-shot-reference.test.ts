import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertIdentitySafeProviderInputs,
  buildIdentitySafeShotReference,
  IdentitySafeReferenceError,
} from '../lib/identity-safe-shot-reference';

test('semantic replacement uses a safe continuity anchor and never forwards raw references', () => {
  const result = buildIdentitySafeShotReference({
    shotIndex: 4,
    referencePolicy: 'semantic_replacement',
    safeKeyframeUrl: 'https://relay.example/safe.jpg',
    continuityAnchorUrl: 'https://relay.example/anchor.jpg',
    productAssetUrls: ['https://relay.example/product.png'],
  });
  assert.equal(result.conditioningReferenceUrl, 'https://relay.example/anchor.jpg');
  assert.deepEqual(result.providerReferenceImageUrls, []);
  assert.equal(result.rawReferenceForwarded, false);
  assert.doesNotThrow(() => assertIdentitySafeProviderInputs(result));
});

test('missing anchor or product is an explicit block, never a silent downgrade', () => {
  assert.throws(
    () => buildIdentitySafeShotReference({
      shotIndex: 2,
      referencePolicy: 'semantic_replacement',
      productAssetUrls: ['https://relay.example/product.png'],
    }),
    IdentitySafeReferenceError
  );
  assert.throws(
    () => buildIdentitySafeShotReference({
      shotIndex: 2,
      referencePolicy: 'safe_keyframe',
      safeKeyframeUrl: 'https://relay.example/safe.jpg',
      productAssetUrls: [],
    }),
    IdentitySafeReferenceError
  );
  assert.throws(
    () => assertIdentitySafeProviderInputs({ providerReferenceImageUrls: ['https://raw.example/face.jpg'] }),
    IdentitySafeReferenceError
  );
});

