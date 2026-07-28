import { Router } from 'express';
import { db } from '../lib/db';

export const presetsRouter = Router();

// GET /api/presets — 获取全量预设模版列表
presetsRouter.get('/', (req, res) => {
  try {
    const stmt = db.prepare('SELECT * FROM presets ORDER BY created_at DESC');
    const rows = stmt.all() as any[];

    const formattedPresets = rows.map((r) => ({
      id: r.id,
      title: r.title,
      tag: r.tag,
      description: r.description,
      coverImage: r.cover_image,
      createdAt: r.created_at,
      pipelineData: JSON.parse(r.pipeline_data || '{}'),
    }));

    return res.json({ success: true, data: formattedPresets });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/presets — 保存新预设模版
presetsRouter.post('/', (req, res) => {
  try {
    const { title, tag = '爆款反推', description = '', coverImage = '', pipelineData = {} } = req.body;
    const presetId = `preset_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const presetTitle = title || `自定义爆款模版_${Date.now()}`;
    const pipelineDataStr = JSON.stringify(pipelineData);
    const image = coverImage || 'https://images.unsplash.com/photo-1556228720-195a672e8a03?auto=format&fit=crop&w=600&q=80';

    const insertStmt = db.prepare(`
      INSERT INTO presets (id, title, tag, description, cover_image, pipeline_data)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    insertStmt.run(presetId, presetTitle, tag, description, image, pipelineDataStr);

    const savedStmt = db.prepare('SELECT * FROM presets WHERE id = ?');
    const saved = savedStmt.get(presetId) as any;

    return res.json({
      success: true,
      data: {
        id: saved.id,
        title: saved.title,
        tag: saved.tag,
        description: saved.description,
        coverImage: saved.cover_image,
        createdAt: saved.created_at,
        pipelineData: JSON.parse(saved.pipeline_data || '{}'),
      },
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/presets/:id — 删除预设模版
presetsRouter.delete('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const deleteStmt = db.prepare('DELETE FROM presets WHERE id = ?');
    deleteStmt.run(id);
    return res.json({ success: true, message: '预设模版已成功删除' });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});
