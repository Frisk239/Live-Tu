import { Router } from 'express';
import { db } from '../lib/db';
import { decryptSecret, encryptSecret, isMaskedSecret } from '../lib/secrets';

export const modelsRouter = Router();

modelsRouter.get('/config', (req, res) => {
  try {
    const stmt = db.prepare('SELECT * FROM model_config');
    const rows = stmt.all() as any[];

    const mapModel = (r: any) => ({
      id: r.id,
      name: r.name,
      provider: r.provider,
      baseUrl: r.base_url,
      apiKey: r.api_key ? '••••••••' : '',
      modelCode: r.model_code,
      recommendedScenario: r.recommended_scenario,
      speedRating: r.speed_rating,
      speedMs: r.speed_ms,
      qualityRating: r.quality_rating,
      description: r.description,
      badge: r.badge || undefined,
      enabled: Boolean(r.enabled),
      isDefault: Boolean(r.is_default),
    });

    const textModels = rows.filter((r) => r.category === 'text').map(mapModel);
    const imageModels = rows.filter((r) => r.category === 'image').map(mapModel);
    const videoModels = rows.filter((r) => r.category === 'video').map(mapModel);

    const defaultTextModel = textModels.find((m) => m.isDefault)?.id || 'Gemini 3.6 Flash';
    const defaultImageModel = imageModels.find((m) => m.isDefault)?.id || 'GPT Image 1';
    const defaultVideoModel = videoModels.find((m) => m.isDefault)?.id || 'Seedance 2.0 Fast';

    return res.json({
      success: true,
      textModels,
      imageModels,
      videoModels,
      autoRecommendationEnabled: true,
      defaultTextModel,
      defaultImageModel,
      defaultVideoModel,
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

modelsRouter.post('/config', (req, res) => {
  try {
    const { textModels = [], imageModels = [], videoModels = [], defaultTextModel, defaultImageModel, defaultVideoModel } = req.body;

    const upsertStmt = db.prepare(`
      INSERT INTO model_config (
        id, name, category, provider, base_url, api_key, model_code,
        recommended_scenario, speed_rating, speed_ms, quality_rating,
        description, badge, enabled, is_default
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        category = excluded.category,
        provider = excluded.provider,
        base_url = excluded.base_url,
        api_key = excluded.api_key,
        model_code = excluded.model_code,
        recommended_scenario = excluded.recommended_scenario,
        speed_rating = excluded.speed_rating,
        speed_ms = excluded.speed_ms,
        quality_rating = excluded.quality_rating,
        description = excluded.description,
        badge = excluded.badge,
        enabled = excluded.enabled,
        is_default = excluded.is_default
    `);

    const upsertList = (list: any[], category: string, defaultId?: string) => {
      for (const m of list) {
        if (!m.id) continue;
        const isDef = m.id === defaultId || m.isDefault ? 1 : 0;
        const existing = db.prepare('SELECT api_key FROM model_config WHERE id = ?').get(m.id) as
          | { api_key: string }
          | undefined;
        const storedApiKey = isMaskedSecret(String(m.apiKey || ''))
          ? existing?.api_key || ''
          : encryptSecret(String(m.apiKey).trim());
        upsertStmt.run(
          m.id,
          m.name || m.id,
          category,
          m.provider || '',
          m.baseUrl || '',
          storedApiKey,
          m.modelCode || m.id,
          m.recommendedScenario || '',
          m.speedRating || '标准',
          m.speedMs || '',
          m.qualityRating || '专业级',
          m.description || '',
          m.badge || null,
          m.enabled ? 1 : 0,
          isDef
        );
      }
    };

    // Soft-delete models removed from UI lists for each category
    const keepIds = new Set(
      [...textModels, ...imageModels, ...videoModels].map((m: any) => m.id).filter(Boolean)
    );
    const existing = db.prepare('SELECT id, category FROM model_config').all() as { id: string; category: string }[];
    const del = db.prepare('DELETE FROM model_config WHERE id = ?');
    for (const row of existing) {
      if (!keepIds.has(row.id) && ['text', 'image', 'video'].includes(row.category)) {
        // Only delete if that category list was provided (non-empty save of that tab)
        const list =
          row.category === 'text' ? textModels : row.category === 'image' ? imageModels : videoModels;
        if (Array.isArray(list) && list.length > 0) del.run(row.id);
      }
    }

    upsertList(textModels, 'text', defaultTextModel);
    upsertList(imageModels, 'image', defaultImageModel);
    upsertList(videoModels, 'video', defaultVideoModel);

    return res.json({ success: true, message: '模型配置已成功持久化至 SQLite 数据库！' });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Real model connectivity probing endpoint
modelsRouter.post('/test-connection', async (req, res) => {
  const startTime = Date.now();
  try {
    const { model } = req.body;
    if (!model) {
      return res.status(400).json({ success: false, message: '缺少 model 配置参数' });
    }

    const category =
      model.category ||
      (model.id.includes('Seedance')
        ? 'video'
        : model.id.includes('Image') || model.id.includes('Seedream') || model.id.includes('Turbo')
        ? 'image'
        : 'text');

    let baseUrl = (model.baseUrl || '').trim();
    let apiKey = (model.apiKey || '').trim();
    if (isMaskedSecret(apiKey) && model.id) {
      const stored = db.prepare('SELECT api_key FROM model_config WHERE id = ?').get(model.id) as
        | { api_key: string }
        | undefined;
      apiKey = stored?.api_key ? decryptSecret(stored.api_key) : '';
    }

    // Fallback to system env if empty
    if (!apiKey) {
      apiKey = process.env.YUNWU_API_KEY || process.env.GEMINI_API_KEY || '';
    }
    if (!baseUrl) {
      baseUrl = process.env.YUNWU_BASE_URL || 'https://api3.wlai.vip/v1';
    }

    baseUrl = baseUrl.replace(/\/$/, '');

    // 1. Text Model Probe
    if (
      category === 'text' ||
      model.modelCode?.includes('chat') ||
      model.modelCode?.includes('gemini') ||
      model.modelCode?.includes('gpt-4')
    ) {
      const probeUrl = `${baseUrl}/chat/completions`;
      const response = await fetch(probeUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: model.modelCode || 'gemini-3.6-flash',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
        }),
      });

      const elapsed = Date.now() - startTime;
      if (response.ok) {
        return res.json({
          success: true,
          message: `✓ 真实连通成功 (${elapsed}ms)`,
          latencyMs: elapsed,
        });
      } else {
        const errText = await response.text().catch(() => '');
        return res.json({
          success: false,
          message: `✗ 连通失败 (HTTP ${response.status}): ${errText.slice(0, 80) || response.statusText}`,
          latencyMs: elapsed,
        });
      }
    }

    // 2. Image Model Probe
    if (
      category === 'image' ||
      model.modelCode?.includes('image') ||
      model.modelCode?.includes('seedream') ||
      model.modelCode?.includes('turbo')
    ) {
      const modelsUrl = `${baseUrl}/models`;
      const response = await fetch(modelsUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      });

      const elapsed = Date.now() - startTime;
      if (response.ok || response.status === 400 || response.status === 404) {
        // If /models route is ok or returned API gateway response
        return res.json({
          success: true,
          message: `✓ 真实连通成功 (${elapsed}ms)`,
          latencyMs: elapsed,
        });
      } else {
        const errText = await response.text().catch(() => '');
        return res.json({
          success: false,
          message: `✗ 连通失败 (HTTP ${response.status}): ${errText.slice(0, 80) || response.statusText}`,
          latencyMs: elapsed,
        });
      }
    }

    // 3. Video Model Probe (Seedance)
    if (category === 'video' || model.modelCode?.includes('seedance')) {
      const { getSeedanceToken } = await import('./seedance');
      try {
        await getSeedanceToken(false);
        const elapsed = Date.now() - startTime;
        return res.json({
          success: true,
          message: `✓ 真实连通成功 (${elapsed}ms)`,
          latencyMs: elapsed,
        });
      } catch (err: any) {
        const elapsed = Date.now() - startTime;
        return res.json({
          success: false,
          message: `✗ 连通失败: ${err.message || 'Seedance 鉴权异常'} (${elapsed}ms)`,
          latencyMs: elapsed,
        });
      }
    }

    return res.json({
      success: true,
      message: `✓ 连通成功 (${Date.now() - startTime}ms)`,
      latencyMs: Date.now() - startTime,
    });
  } catch (err: any) {
    return res.json({
      success: false,
      message: `✗ 网络连接异常: ${err.message}`,
      latencyMs: Date.now() - startTime,
    });
  }
});
