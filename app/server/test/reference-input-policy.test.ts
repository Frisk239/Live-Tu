import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateReferenceInputs,
  buildProviderReferencePayload,
  assertProviderPayloadSafe,
  ReferencePolicyViolationError,
  type ReferenceAssetDeclaration,
} from '../domain/reference-policy/reference-input-policy';

const sourceKeyframeWithFace: ReferenceAssetDeclaration = {
  id: 'kf-1',
  kind: 'source_keyframe',
  url: 'https://example.com/source-kf-1.jpg',
  containsFace: true,
};

const sourceKeyframeClean: ReferenceAssetDeclaration = {
  id: 'kf-2',
  kind: 'source_keyframe',
  url: 'https://example.com/source-kf-2.jpg',
  containsFace: false,
};

const productShot: ReferenceAssetDeclaration = {
  id: 'prod-1',
  kind: 'product_shot',
  url: 'https://example.com/buv-pack.jpg',
};

const generatedFrame: ReferenceAssetDeclaration = {
  id: 'gen-1',
  kind: 'generated_frame',
  url: 'https://example.com/conditioned-first-frame.png',
};

const personPhoto: ReferenceAssetDeclaration = {
  id: 'person-1',
  kind: 'person_photo',
  url: 'https://example.com/public-person.jpg',
};

const authorizedPerson: ReferenceAssetDeclaration = {
  id: 'person-2',
  kind: 'person_photo',
  url: 'https://example.com/authorized-person.jpg',
  authorization: { status: 'verified', licenseRef: 'license-2026-001' },
};

const unauthorizedPerson: ReferenceAssetDeclaration = {
  id: 'person-3',
  kind: 'person_photo',
  url: 'https://example.com/unauthorized-person.jpg',
  authorization: { status: 'none' },
};

const virtualTalent: ReferenceAssetDeclaration = {
  id: 'vt-1',
  kind: 'virtual_talent_asset',
  url: 'https://example.com/brand-avatar.png',
};

test('semantic_recreation（默认）：含人脸的原始参考帧绝不能进入 provider payload', () => {
  const decision = evaluateReferenceInputs(
    [sourceKeyframeWithFace, productShot, generatedFrame],
    { mode: 'semantic_recreation' }
  );
  const face = decision.rejected.find((a) => a.id === 'kf-1');
  assert.ok(face, '含人脸的原视频关键帧必须被拒绝');
  assert.equal(face?.code, 'face_in_provider_input');
  assert.ok(!decision.providerPayloadUrls.includes(sourceKeyframeWithFace.url));
  assert.ok(decision.providerPayloadUrls.includes(productShot.url));
  assert.ok(decision.providerPayloadUrls.includes(generatedFrame.url));
});

test('semantic_recreation：原视频关键帧（即使声明无人脸）也不得进入 provider', () => {
  const decision = evaluateReferenceInputs([sourceKeyframeClean, productShot], {
    mode: 'semantic_recreation',
  });
  assert.ok(decision.rejected.some((a) => a.id === 'kf-2' && a.code === 'source_keyframe_to_provider'));
  assert.deepEqual(decision.providerPayloadUrls, [productShot.url]);
});

test('semantic_recreation：竞品包装/水印/真人照片全部拒绝', () => {
  const decision = evaluateReferenceInputs(
    [
      { id: 'comp', kind: 'competitor_packaging', url: 'https://example.com/competitor.jpg' },
      { id: 'wm', kind: 'watermarked_asset', url: 'https://example.com/with-watermark.jpg' },
      personPhoto,
      productShot,
    ],
    { mode: 'semantic_recreation' }
  );
  assert.equal(decision.rejected.length, 3);
  assert.deepEqual(decision.providerPayloadUrls, [productShot.url]);
});

test('authorized_likeness：任意公网真人图拒绝；已验证授权放行', () => {
  const decision = evaluateReferenceInputs([personPhoto, authorizedPerson, unauthorizedPerson, productShot], {
    mode: 'authorized_likeness',
  });
  assert.ok(decision.rejected.some((a) => a.id === 'person-1' && a.code === 'unauthorized_likeness'));
  assert.ok(decision.rejected.some((a) => a.id === 'person-3' && a.code === 'unauthorized_likeness'));
  assert.ok(decision.allowed.some((a) => a.id === 'person-2'));
  // 非人物资产不受影响
  assert.ok(decision.allowed.some((a) => a.id === 'prod-1'));
});

test('authorized_likeness：带验证标记但缺 licenseRef 仍拒绝（授权状态必须完整）', () => {
  const incomplete = evaluateReferenceInputs(
    [{ ...authorizedPerson, authorization: { status: 'verified' } }],
    { mode: 'authorized_likeness' }
  );
  assert.equal(incomplete.allowed.length, 0);
  assert.equal(incomplete.rejected[0].code, 'unauthorized_likeness');
});

test('virtual_talent：虚拟人物可以有脸——身份与原视频无关则放行，同一身份才拒绝', () => {
  // 有脸的品牌自有虚拟人物（身份与原视频人物不同）→ 放行
  const brandOwned = evaluateReferenceInputs(
    [
      {
        id: 'vt-brand',
        kind: 'virtual_talent_asset',
        url: 'https://example.com/brand-avatar.png',
        containsFace: true,
        identityRef: 'brand-talent-001',
        sourceIdentityRef: 'source-host-01',
      },
      productShot,
    ],
    { mode: 'virtual_talent' }
  );
  assert.ok(brandOwned.allowed.some((a) => a.id === 'vt-brand'), '品牌自有虚拟人物（不同身份）必须放行');
  assert.deepEqual(brandOwned.providerPayloadUrls, ['https://example.com/brand-avatar.png', productShot.url]);

  // 显式声明与原视频人物同一身份 → 拒绝（身份红线）
  const sameIdentity = evaluateReferenceInputs(
    [
      {
        id: 'vt-copy',
        kind: 'virtual_talent_asset',
        url: 'https://example.com/copy-avatar.png',
        containsFace: true,
        matchesSourceIdentity: true,
      },
    ],
    { mode: 'virtual_talent' }
  );
  assert.equal(sameIdentity.rejected[0].code, 'virtual_talent_identity_link');

  // identityRef === sourceIdentityRef → 同样拒绝
  const sameRef = evaluateReferenceInputs(
    [
      {
        id: 'vt-same-ref',
        kind: 'virtual_talent_asset',
        url: 'https://example.com/same-avatar.png',
        containsFace: true,
        identityRef: 'person-a',
        sourceIdentityRef: 'person-a',
      },
    ],
    { mode: 'virtual_talent' }
  );
  assert.equal(sameRef.rejected[0].code, 'virtual_talent_identity_link');

  // 身份字段缺失且含人脸 → 保守拒绝（无法排除与原视频同一身份）
  const unknown = evaluateReferenceInputs(
    [{ id: 'vt-unknown', kind: 'virtual_talent_asset', url: 'https://example.com/u.png', containsFace: true }],
    { mode: 'virtual_talent' }
  );
  assert.equal(unknown.rejected[0].code, 'virtual_talent_identity_link');
});

test('virtual_talent：原视频关键帧/无授权真人仍拒绝（身份无关不等于放开源头）', () => {
  const decision = evaluateReferenceInputs(
    [virtualTalent, sourceKeyframeWithFace, personPhoto, productShot],
    { mode: 'virtual_talent' }
  );
  assert.ok(decision.allowed.some((a) => a.id === 'vt-1'));
  assert.ok(decision.allowed.some((a) => a.id === 'prod-1'));
  assert.ok(decision.rejected.some((a) => a.id === 'kf-1'));
  assert.ok(decision.rejected.some((a) => a.id === 'person-1'));
});

test('buildProviderReferencePayload：strict 模式有拒绝项即抛错（请求构建处硬性阻断）', () => {
  assert.throws(
    () =>
      buildProviderReferencePayload([sourceKeyframeWithFace, productShot], {
        mode: 'semantic_recreation',
      }),
    (error: unknown) =>
      error instanceof ReferencePolicyViolationError && error.code === 'face_in_provider_input'
  );
  // 非 strict：返回仅放行项
  const lenient = buildProviderReferencePayload([sourceKeyframeWithFace, productShot], {
    mode: 'semantic_recreation',
    strict: false,
  });
  assert.deepEqual(lenient, [productShot.url]);
});

test('assertProviderPayloadSafe：payload 混入被拒绝资产即抛错（请求前双重把关）', () => {
  assert.throws(
    () =>
      assertProviderPayloadSafe(
        [productShot.url, sourceKeyframeWithFace.url],
        [sourceKeyframeWithFace, productShot],
        { mode: 'semantic_recreation' }
      ),
    ReferencePolicyViolationError
  );
  assert.doesNotThrow(() =>
    assertProviderPayloadSafe([productShot.url], [sourceKeyframeWithFace, productShot], {
      mode: 'semantic_recreation',
    })
  );
});

test('空声明列表：允许/拒绝均空，payload 为空', () => {
  const decision = evaluateReferenceInputs([], { mode: 'semantic_recreation' });
  assert.deepEqual(decision.providerPayloadUrls, []);
  assert.equal(decision.rejected.length, 0);
});
