import { Router } from 'express';
import { db } from '../lib/db';

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
      apiKey: r.api_key,
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

    const defaultTextModel = textModels.find((m) => m.isDefault)?.id || 'DeepSeek V3';
    const defaultImageModel = imageModels.find((m) => m.isDefault)?.id || 'Imagen 4 Ultra';
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

    const updateStmt = db.prepare(`
      UPDATE model_config
      SET base_url = ?, api_key = ?, enabled = ?, is_default = ?
      WHERE id = ?
    `);

    const updateList = (list: any[], defaultId?: string) => {
      for (const m of list) {
        if (!m.id) continue;
        const isDef = m.id === defaultId || m.isDefault ? 1 : 0;
        updateStmt.run(m.baseUrl || '', m.apiKey || '', m.enabled ? 1 : 0, isDef, m.id);
      }
    };

    updateList(textModels, defaultTextModel);
    updateList(imageModels, defaultImageModel);
    updateList(videoModels, defaultVideoModel);

    return res.json({ success: true, message: '模型配置配置已成功持久化至 SQLite 数据库！' });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});
