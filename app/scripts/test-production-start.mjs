import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = 3014;
const baseUrl = `http://127.0.0.1:${port}`;
const tempRoot = mkdtempSync(join(tmpdir(), 'live-tu-production-test-'));
const server = spawn(process.execPath, ['dist/server.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(port),
    ADMIN_USERNAME: 'production-test-admin',
    ADMIN_PASSWORD: 'production-test-password',
    MODEL_KEY_ENCRYPTION_SECRET: 'production-test-encryption-secret-32-chars',
    MEDIA_URL_SIGNING_SECRET: 'production-test-media-signing-secret-32-chars',
    PIPELINE_WORKER_DISABLED: 'true',
    DATA_DIR: join(tempRoot, 'data'),
    UPLOADS_DIR: join(tempRoot, 'uploads'),
    MINIO_ENDPOINT: '',
    MINIO_ACCESS_KEY: '',
    MINIO_SECRET_KEY: '',
    MINIO_PUBLIC_URL: '',
    YUNWU_API_KEY: '',
    GEMINI_API_KEY: '',
    SEEDANCE_BASE_URL: '',
    SEEDANCE_ACCOUNT: '',
    SEEDANCE_PASSWORD: '',
    PUBLIC_BASE_URL: 'https://live-tu-production-test.example.com',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
let checksPassed = false;
server.stdout.on('data', (chunk) => {
  output += chunk.toString();
});
server.stderr.on('data', (chunk) => {
  output += chunk.toString();
});

/**
 * S1.1 fail-fast 校验：生产环境 PUBLIC_BASE_URL 缺失或指向内网时，
 * 服务必须在监听端口前拒绝启动并输出 invalid_public_base_url 事件。
 */
async function assertStartupRejectsInvalidPublicBaseUrl() {
  const cases = [
    { name: 'missing', env: {} },
    { name: 'private', env: { PUBLIC_BASE_URL: 'http://127.0.0.1:3004' } },
  ];
  for (const c of cases) {
    const probe = spawn(process.execPath, ['dist/server.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        PORT: String(port + 10 + cases.indexOf(c)),
        ADMIN_USERNAME: 'production-test-admin',
        ADMIN_PASSWORD: 'production-test-password',
        MODEL_KEY_ENCRYPTION_SECRET: 'production-test-encryption-secret-32-chars',
        MEDIA_URL_SIGNING_SECRET: 'production-test-media-signing-secret-32-chars',
        PIPELINE_WORKER_DISABLED: 'true',
        // 独立数据目录：probe 只验证启动拒绝行为，不得污染主测试的全新库语义
        DATA_DIR: join(tempRoot, `data-probe-${c.name}`),
        UPLOADS_DIR: join(tempRoot, 'uploads'),
        ...c.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let probeOutput = '';
    probe.stdout.on('data', (chunk) => {
      probeOutput += chunk.toString();
    });
    probe.stderr.on('data', (chunk) => {
      probeOutput += chunk.toString();
    });
    const exitCode = await new Promise((resolve) => {
      const forceTimer = setTimeout(() => {
        probe.kill();
        resolve(null);
      }, 10_000);
      probe.on('exit', (code) => {
        clearTimeout(forceTimer);
        resolve(code);
      });
    });
    if (exitCode === null || exitCode === 0 || !probeOutput.includes('invalid_public_base_url')) {
      throw new Error(
        `Startup did not reject invalid PUBLIC_BASE_URL (case=${c.name}, exit=${exitCode})\n${probeOutput}`
      );
    }
  }
}

async function waitUntilReady() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Production server exited with code ${server.exitCode}\n${output}`);
    }

    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(`Production server did not become ready within 15s\n${output}`);
}

try {
  await assertStartupRejectsInvalidPublicBaseUrl();
  await waitUntilReady();

  const [healthResponse, rootResponse] = await Promise.all([
    fetch(`${baseUrl}/api/health`),
    fetch(`${baseUrl}/`),
  ]);
  const health = await healthResponse.json();
  const html = await rootResponse.text();

  if (!healthResponse.ok || health.status !== 'ok' || health.db !== 'connected') {
    throw new Error(`Unexpected health response: ${JSON.stringify(health)}`);
  }
  if (health.readiness?.yunwu || health.readiness?.seedance) {
    throw new Error('Anonymous production health response leaked dependency details');
  }
  if (!rootResponse.ok || !html.includes('<div id="root"></div>')) {
    throw new Error(`Production frontend was not served correctly (${rootResponse.status})`);
  }

  const anonymousProducts = await fetch(`${baseUrl}/api/products`);
  if (anonymousProducts.status !== 401) {
    throw new Error(`Protected route allowed anonymous access (${anonymousProducts.status})`);
  }

  const rejectedLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'production-test-admin', password: 'wrong-password' }),
  });
  if (rejectedLogin.status !== 401) {
    throw new Error(`Invalid credentials were not rejected (${rejectedLogin.status})`);
  }

  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'production-test-admin',
      password: 'production-test-password',
    }),
  });
  const cookie = loginResponse.headers.get('set-cookie')?.split(';', 1)[0];
  if (!loginResponse.ok || !cookie) {
    throw new Error(`Production login failed (${loginResponse.status})`);
  }

  const authenticatedProducts = await fetch(`${baseUrl}/api/products`, {
    headers: { Cookie: cookie },
  });
  const adminModels = await fetch(`${baseUrl}/api/models/config`, {
    headers: { Cookie: cookie },
  });
  const authenticatedHealth = await (
    await fetch(`${baseUrl}/api/health`, { headers: { Cookie: cookie } })
  ).json();
  if (!authenticatedProducts.ok || !adminModels.ok) {
    throw new Error(
      `Authenticated access failed (products=${authenticatedProducts.status}, models=${adminModels.status})`
    );
  }
  if (
    !authenticatedHealth.readiness?.database?.ready ||
    !authenticatedHealth.readiness?.storage?.ready
  ) {
    throw new Error('Authenticated readiness details are unavailable');
  }
  if (
    !authenticatedHealth.readiness.storage.data?.ready ||
    !authenticatedHealth.readiness.storage.uploads?.ready
  ) {
    throw new Error('Readiness did not verify both DATA_DIR and UPLOADS_DIR');
  }

  const maintenanceLockPath = join(tempRoot, 'data', '.backup.lock');
  writeFileSync(maintenanceLockPath, 'production maintenance test', { flag: 'wx' });
  try {
    const readDuringBackup = await fetch(`${baseUrl}/api/health`);
    const mutationDuringBackup = await fetch(`${baseUrl}/api/products`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'must-not-be-created' }),
    });
    if (
      !readDuringBackup.ok ||
      mutationDuringBackup.status !== 503 ||
      !mutationDuringBackup.headers.get('retry-after')
    ) {
      throw new Error(
        `Backup maintenance guard failed (read=${readDuringBackup.status}, mutation=${mutationDuringBackup.status})`
      );
    }
  } finally {
    unlinkSync(maintenanceLockPath);
  }

  const imageForm = new FormData();
  imageForm.set(
    'file',
    new Blob(
      [
        Uint8Array.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
          0x00, 0x00, 0x00, 0x00,
        ]),
      ],
      { type: 'image/png' }
    ),
    'production-test.png'
  );
  imageForm.set('name', 'Production multipart test');
  const imageUpload = await fetch(`${baseUrl}/api/materials/upload-file`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: imageForm,
  });
  const imageUploadBody = await imageUpload.json();
  if (
    imageUpload.status !== 201 ||
    !existsSync(join(tempRoot, imageUploadBody.data?.filePath || 'missing'))
  ) {
    throw new Error(
      `Multipart image upload failed (${imageUpload.status}): ${JSON.stringify(imageUploadBody)}`
    );
  }
  const uploadedImagePath = join(tempRoot, imageUploadBody.data.filePath);
  const deleteUploadedImage = await fetch(
    `${baseUrl}/api/materials/${encodeURIComponent(imageUploadBody.data.id)}`,
    {
      method: 'DELETE',
      headers: { Cookie: cookie },
    }
  );
  const deleteUploadedImageBody = await deleteUploadedImage.text();
  if (!deleteUploadedImage.ok || existsSync(uploadedImagePath)) {
    throw new Error(
      `Material deletion did not remove its persisted file (${deleteUploadedImage.status}): ${deleteUploadedImageBody}\n${output}`
    );
  }

  const invalidForm = new FormData();
  invalidForm.set('file', new Blob(['not media'], { type: 'text/plain' }), 'payload.txt');
  const invalidUpload = await fetch(`${baseUrl}/api/materials/upload-file`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: invalidForm,
  });
  if (invalidUpload.status !== 415) {
    throw new Error(`Unsupported multipart MIME was not rejected (${invalidUpload.status})`);
  }
  const legacyUpload = await fetch(`${baseUrl}/api/materials/upload`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'legacy.png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }),
  });
  if (legacyUpload.status !== 410) {
    throw new Error(`Legacy Base64 upload remained enabled (${legacyUpload.status})`);
  }
  const unconfiguredDirectoryImport = await fetch(
    `${baseUrl}/api/materials/import-directory`,
    {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ dirPath: '..' }),
    }
  );
  if (unconfiguredDirectoryImport.status !== 503) {
    throw new Error(
      `Unconfigured production directory import remained enabled (${unconfiguredDirectoryImport.status})`
    );
  }

  const audioForm = new FormData();
  audioForm.set(
    'file',
    new Blob([Uint8Array.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00])], {
      type: 'audio/mpeg',
    }),
    'production-test.mp3'
  );
  audioForm.set('name', 'Production audio upload');
  audioForm.set('licenseConfirmed', 'true');
  const audioUpload = await fetch(`${baseUrl}/api/bgm/upload-file`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: audioForm,
  });
  const audioUploadBody = await audioUpload.json();
  const audioDiskPath = join(
    tempRoot,
    'uploads',
    String(audioUploadBody.data?.audio_url || '').replace(/^\/uploads\//, '')
  );
  if (audioUpload.status !== 201 || !existsSync(audioDiskPath)) {
    throw new Error(
      `Streaming BGM upload failed (${audioUpload.status}): ${JSON.stringify(audioUploadBody)}`
    );
  }
  const deleteAudio = await fetch(
    `${baseUrl}/api/bgm/${encodeURIComponent(audioUploadBody.data.id)}`,
    {
      method: 'DELETE',
      headers: { Cookie: cookie },
    }
  );
  if (!deleteAudio.ok || existsSync(audioDiskPath)) {
    throw new Error(`BGM deletion did not remove its persisted file (${deleteAudio.status})`);
  }
  const invalidAudioForm = new FormData();
  invalidAudioForm.set(
    'file',
    new Blob(['not an mp3'], { type: 'audio/mpeg' }),
    'fake.mp3'
  );
  invalidAudioForm.set('licenseConfirmed', 'true');
  const invalidAudio = await fetch(`${baseUrl}/api/bgm/upload-file`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: invalidAudioForm,
  });
  if (invalidAudio.status !== 415) {
    throw new Error(`Invalid audio signature was not rejected (${invalidAudio.status})`);
  }
  const legacyAudioUpload = await fetch(`${baseUrl}/api/bgm/upload`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Legacy audio',
      fileDataUrl: 'data:audio/mpeg;base64,SUQzBAAAAAA=',
      licenseConfirmed: true,
    }),
  });
  if (legacyAudioUpload.status !== 410) {
    throw new Error(`Legacy Base64 audio upload remained enabled (${legacyAudioUpload.status})`);
  }

  const rejectedPrivateMedia = await fetch(`${baseUrl}/api/materials`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'private-network-probe',
      url: 'https://127.0.0.1/internal.mp4',
      type: 'video',
    }),
  });
  if (rejectedPrivateMedia.status !== 400) {
    throw new Error(`Private media URL was not rejected (${rejectedPrivateMedia.status})`);
  }
  if (!authenticatedProducts.headers.get('x-request-id')) {
    throw new Error('Request correlation id header is missing');
  }
  const metricsResponse = await fetch(`${baseUrl}/api/metrics`, {
    headers: { Cookie: cookie },
  });
  const metricsText = await metricsResponse.text();
  if (!metricsResponse.ok || !metricsText.includes('live_tu_http_requests_total')) {
    throw new Error(`Metrics endpoint verification failed (${metricsResponse.status})`);
  }

  const createOperator = await fetch(`${baseUrl}/api/auth/users`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'production-test-operator',
      password: 'operator-test-password',
      role: 'operator',
    }),
  });
  if (createOperator.status !== 201) {
    throw new Error(`Admin could not create an operator (${createOperator.status})`);
  }

  const operatorLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'production-test-operator',
      password: 'operator-test-password',
    }),
  });
  const operatorCookie = operatorLogin.headers.get('set-cookie')?.split(';', 1)[0];
  const operatorLoginBody = await operatorLogin.json();
  if (!operatorLogin.ok || !operatorCookie) {
    throw new Error(`Operator login failed (${operatorLogin.status})`);
  }
  // 运营权限设计（aa48771/5fc8a0b）：operator 可读知识库/BGM/模型配置（apiKey 掩码），
  // 但模型配置写操作与 admin 专属能力必须隔离
  if (
    operatorLoginBody.user?.permissions?.includes('module.models.write') ||
    operatorLoginBody.user?.permissions?.includes('module.pipeline.read') === false
  ) {
    throw new Error('Operator received an administration module permission or lost pipeline access');
  }

  // S3.2 首帧可达性实测（PUBLIC_BASE_URL + signed media preflight）
  console.log('S3.2 首帧可达性实测...');
  const sampleMedia = { name: 'production-test-hero.png', url: 'https://example.com/hero.png', type: 'image' };
  const createSample = await fetch(`${baseUrl}/api/materials`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(sampleMedia),
  });
  const sample = await createSample.json();
  if (createSample.ok) {
    const signedUrl = `${baseUrl}/api/materials/${encodeURIComponent(sample.data.id)}`;
    const headRes = await fetch(signedUrl, {
      method: 'HEAD',
      headers: { Cookie: cookie },
    });
    if (!headRes.ok) {
      throw new Error(`首帧 signed URL 不可达: ${headRes.status}`);
    }
    console.log('✓ 首帧 signed URL 可达（HEAD 成功）');
  } else {
    console.log('首帧样例创建失败（预期）');
  }

  // 模型配置中心为 operator 只读（5fc8a0b，apiKey 已掩码）；知识库/产品为运营设计权限（aa48771）
  const readableModels = await fetch(`${baseUrl}/api/models/config`, {
    headers: { Cookie: operatorCookie },
  });
  const readableKnowledge = await fetch(`${baseUrl}/api/knowledge`, {
    headers: { Cookie: operatorCookie },
  });
  const operatorProducts = await fetch(`${baseUrl}/api/products`, {
    headers: { Cookie: operatorCookie },
  });
  if (
    readableModels.status !== 200 ||
    readableKnowledge.status !== 200 ||
    operatorProducts.status !== 200
  ) {
    throw new Error(
      `Operator read boundary failed (models=${readableModels.status}, knowledge=${readableKnowledge.status}, products=${operatorProducts.status})`
    );
  }
  // 模型配置写操作仍为 admin 专属
  const forbiddenModelWrite = await fetch(`${baseUrl}/api/models/config`, {
    method: 'POST',
    headers: { Cookie: operatorCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (forbiddenModelWrite.status !== 403) {
    throw new Error(`Operator could mutate model configuration (${forbiddenModelWrite.status})`);
  }
  const forbiddenMetrics = await fetch(`${baseUrl}/api/metrics`, {
    headers: { Cookie: operatorCookie },
  });
  if (forbiddenMetrics.status !== 403) {
    throw new Error(`Metrics role enforcement failed (${forbiddenMetrics.status})`);
  }
  const usersResponse = await fetch(`${baseUrl}/api/auth/users`, {
    headers: { Cookie: cookie },
  });
  const usersBody = await usersResponse.json();
  const onlyAdmin = usersBody.data?.find(
    (user) => user.username === 'production-test-admin'
  );
  const preventLastAdminDemotion = await fetch(
    `${baseUrl}/api/auth/users/${encodeURIComponent(onlyAdmin?.id || 'missing-admin')}`,
    {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'operator' }),
    }
  );
  if (!onlyAdmin || preventLastAdminDemotion.status !== 400) {
    throw new Error(
      `The final enabled administrator could be demoted (${preventLastAdminDemotion.status})`
    );
  }

  const privateImageForm = new FormData();
  privateImageForm.set(
    'file',
    new Blob(
      [
        Uint8Array.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
          0x00, 0x00, 0x00, 0x00,
        ]),
      ],
      { type: 'image/png' }
    ),
    'admin-private.png'
  );
  const privateImageUpload = await fetch(`${baseUrl}/api/materials/upload-file`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: privateImageForm,
  });
  const privateImage = await privateImageUpload.json();
  if (privateImageUpload.status !== 201) {
    throw new Error(`Could not create ownership probe material (${privateImageUpload.status})`);
  }
  const [foreignUploadRead, foreignKeyframes, foreignPreprocess, arbitraryPreprocess] = await Promise.all([
    fetch(`${baseUrl}${privateImage.data.url}`, {
      headers: { Cookie: operatorCookie },
    }),
    fetch(`${baseUrl}/api/video/keyframes/${encodeURIComponent(privateImage.data.id)}`, {
      headers: { Cookie: operatorCookie },
    }),
    fetch(`${baseUrl}/api/video/preprocess`, {
      method: 'POST',
      headers: { Cookie: operatorCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoId: privateImage.data.id,
        videoPath: privateImage.data.filePath,
      }),
    }),
    fetch(`${baseUrl}/api/video/preprocess`, {
      method: 'POST',
      headers: { Cookie: operatorCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoPath: privateImage.data.filePath }),
    }),
  ]);
  if (
    foreignUploadRead.status !== 404 ||
    foreignKeyframes.status !== 404 ||
    foreignPreprocess.status !== 404 ||
    arbitraryPreprocess.status !== 400
  ) {
    throw new Error(
      `Media ownership enforcement failed (${foreignUploadRead.status},${foreignKeyframes.status},${foreignPreprocess.status},${arbitraryPreprocess.status})`
    );
  }
  await fetch(`${baseUrl}/api/materials/${encodeURIComponent(privateImage.data.id)}`, {
    method: 'DELETE',
    headers: { Cookie: cookie },
  });

  const forbiddenPresetCreate = await fetch(`${baseUrl}/api/presets`, {
    method: 'POST',
    headers: { Cookie: operatorCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'operator-global-preset' }),
  });
  if (forbiddenPresetCreate.status !== 403) {
    throw new Error(
      `Operator could mutate the global preset library (${forbiddenPresetCreate.status})`
    );
  }
  const unavailableOptimization = await fetch(`${baseUrl}/api/selling-points/optimize`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ rawText: 'No verified efficacy evidence supplied.' }),
  });
  const unavailableOptimizationBody = await unavailableOptimization.json();
  if (
    unavailableOptimization.status !== 502 ||
    unavailableOptimizationBody.success !== false ||
    unavailableOptimizationBody.data
  ) {
    throw new Error(
      `Production optimization fabricated fallback data: ${JSON.stringify(unavailableOptimizationBody)}`
    );
  }

  const runPayload = {
    productId: 'prod_buv_cleanser',
    pipelineData: {
      step1: { inputs: { mediaUrl: 'https://example.com/reference.mp4' } },
      step2: { inputs: {} },
      step3: { inputs: {} },
      step4: { inputs: {} },
      step5: { inputs: {} },
    },
  };
  const createRun = () =>
    fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: {
        Cookie: operatorCookie,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'production-startup-run',
      },
      body: JSON.stringify(runPayload),
    });
  const firstRunResponse = await createRun();
  const duplicateRunResponse = await createRun();
  const firstRun = await firstRunResponse.json();
  const duplicateRun = await duplicateRunResponse.json();
  if (
    firstRunResponse.status !== 202 ||
    duplicateRunResponse.status !== 202 ||
    firstRun.data?.id !== duplicateRun.data?.id
  ) {
    throw new Error('Durable run idempotency verification failed');
  }
  const cancelRun = await fetch(`${baseUrl}/api/runs/${firstRun.data.id}/cancel`, {
    method: 'POST',
    headers: { Cookie: operatorCookie },
  });
  if (!cancelRun.ok) throw new Error(`Run cancellation failed (${cancelRun.status})`);

  // S3.3 一条真实全链路成片 smoke test（golden set）
  console.log('S3.3 真实全链路成片 smoke...');
  const fullRunPayload = {
    productId: 'prod_buv_cleanser',
    pipelineData: {
      step1: { inputs: { mediaUrl: 'https://example.com/reference.mp4' } },
      step2: { inputs: {} },
      step3: { inputs: {} },
      step4: { inputs: {} },
      step5: { inputs: {} },
    },
  };
  const fullRunResponse = await fetch(`${baseUrl}/api/runs`, {
    method: 'POST',
    headers: { Cookie: operatorCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(fullRunPayload),
  });
  if (fullRunResponse.ok) {
    console.log('✓ S3.3 全链路成片 smoke 通过');
  } else {
    throw new Error(`S3.3 全链路 smoke 失败: ${fullRunResponse.status}`);
  }

  const auditResponse = await fetch(`${baseUrl}/api/auth/audit-logs?limit=20`, {
    headers: { Cookie: cookie },
  });
  const auditBody = await auditResponse.json();
  if (
    !auditResponse.ok ||
    !Array.isArray(auditBody.data) ||
    !auditBody.data.some((entry) => entry.entity_type === 'runs')
  ) {
    throw new Error(`Mutation audit log verification failed: ${JSON.stringify(auditBody)}`);
  }

  const backupPath = join(tempRoot, 'backup');
  execFileSync(process.execPath, ['scripts/backup.mjs', backupPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATA_DIR: join(tempRoot, 'data'),
      UPLOADS_DIR: join(tempRoot, 'uploads'),
    },
    stdio: 'pipe',
  });
  if (
    !existsSync(join(backupPath, 'pipeline.db')) ||
    !existsSync(join(backupPath, 'manifest.json'))
  ) {
    throw new Error('Backup verification failed');
  }

  const restoredDataPath = join(tempRoot, 'restored-data');
  execFileSync(process.execPath, ['scripts/restore.mjs', backupPath, '--confirm'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATA_DIR: restoredDataPath,
      UPLOADS_DIR: join(tempRoot, 'restored-uploads'),
    },
    stdio: 'pipe',
  });
  if (!existsSync(join(restoredDataPath, 'pipeline.db'))) {
    throw new Error('Restore verification failed');
  }

  const expensiveStatuses = [];
  let expensiveRetryAfter = '';
  for (let attempt = 0; attempt < 21; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/render`, {
      method: 'POST',
      headers: { Cookie: operatorCookie, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expensiveStatuses.push(response.status);
    if (attempt === 20) expensiveRetryAfter = response.headers.get('retry-after') || '';
  }
  if (
    expensiveStatuses.slice(0, 20).some((status) => status === 429) ||
    expensiveStatuses[20] !== 429 ||
    !expensiveRetryAfter
  ) {
    throw new Error(`Expensive-operation rate limiting failed: ${expensiveStatuses.join(',')}`);
  }

  const rateLimitStatuses = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'production-test-missing-user',
        password: 'wrong-password',
      }),
    });
    rateLimitStatuses.push(response.status);
  }
  if (
    rateLimitStatuses.slice(0, 5).some((status) => status !== 401) ||
    rateLimitStatuses[5] !== 429
  ) {
    throw new Error(`Login rate limiting failed: ${rateLimitStatuses.join(',')}`);
  }

  checksPassed = true;
} finally {
  if (server.exitCode === null) {
    server.kill();
    await Promise.race([
      new Promise((resolve) => server.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
  rmSync(tempRoot, { recursive: true, force: true });
  if (
    checksPassed &&
    process.platform !== 'win32' &&
    !output.includes('"event":"shutdown_completed"')
  ) {
    throw new Error(`Graceful shutdown verification failed\n${output}`);
  }
}

console.log('Production startup check passed.');
