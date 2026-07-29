import { hasSeedanceConfig, getSeedanceToken } from '../server/routes/seedance';

async function testSeedanceDetailed() {
  console.log('=====================================================');
  console.log('  Seedance 接口连通性深度诊断测试');
  console.log('=====================================================\n');

  const baseUrl = (process.env.SEEDANCE_BASE_URL || '').replace(/\/$/, '');
  const account = (process.env.SEEDANCE_ACCOUNT || '').trim();
  const password = (process.env.SEEDANCE_PASSWORD || '').trim();
  const model = process.env.SEEDANCE_MODEL || 'doubao-seedance-2-0-fast';

  console.log(`[配置信息]`);
  console.log(`  Base URL:  ${baseUrl}`);
  console.log(`  Account:   ${account}`);
  console.log(`  Password:  ${password ? password.slice(0, 3) + '***' + password.slice(-2) : '(空)'}`);
  console.log(`  Model:     ${model}`);
  console.log(`  配置判定:  ${hasSeedanceConfig() ? '完整' : '不完整'}\n`);

  // 1. 发起 POST /api/v1/auth/token
  const authUrl = `${baseUrl}/api/v1/auth/token`;
  console.log(`[步骤 1] 请求 Token 接口: POST ${authUrl} ...`);
  const t0 = Date.now();

  try {
    const response = await fetch(authUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'BUV-Workbench/0.2',
      },
      body: JSON.stringify({ account, password }),
    });

    const elapsed = Date.now() - t0;
    const rawText = await response.text().catch(() => '');

    console.log(`\n[响应状态] HTTP ${response.status} ${response.statusText} (${elapsed}ms)`);
    console.log(`[响应 Headers]:`);
    response.headers.forEach((val, key) => console.log(`  ${key}: ${val}`));

    console.log(`\n[响应 Body 内容]:`);
    console.log(rawText || '(空内容)');

    if (response.ok) {
      try {
        const json = JSON.parse(rawText);
        console.log(`\n✓ Token 获取成功！Data:`, json.data);
      } catch {
        console.error('\n✗ 响应返回 200，但非合法 JSON');
      }
    } else {
      console.error(`\n✗ Token 获取失败: 状态码 ${response.status}`);
      if (response.status === 500) {
        console.error('  --> 原因分析: 远端服务器（ai.xmhaini.com）在处理 token 签发逻辑时抛出了 500 内部服务错误。');
        console.error('  --> 常见可能性:');
        console.error('      1. 远端 Seedance 数据库/中转服务暂时挂掉或未启动');
        console.error('      2. 账号 hejinzhe@xmhaini.com 在远端系统未开通 AI_MODEL_INVOKE / FILE_UPLOAD 权限，或账号已被停用/到期');
        console.error('      3. 密码在远端校验时数据库检索异常');
      }
    }
  } catch (err: any) {
    const elapsed = Date.now() - t0;
    console.error(`\n✗ 网络请求捕获到底层异常 (${elapsed}ms):`, err.message);
  }

  console.log('\n=====================================================');
}

testSeedanceDetailed().catch(console.error);
