import { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { db } from '../lib/db';

export const materialsRouter = Router();

const uploadsMaterialsDir = path.join(process.cwd(), 'uploads', 'materials');

if (!fs.existsSync(uploadsMaterialsDir)) {
  fs.mkdirSync(uploadsMaterialsDir, { recursive: true });
}

// GET /api/materials — 获取素材库全量列表
materialsRouter.get('/', (req, res) => {
  try {
    const stmt = db.prepare('SELECT * FROM materials ORDER BY created_at DESC');
    const rows = stmt.all() as any[];

    const materials = rows.map((r) => ({
      id: r.id,
      name: r.name,
      filePath: r.file_path,
      url: r.url,
      type: r.media_type as 'video' | 'image',
      size: r.size || '1.0 MB',
      duration: r.duration || undefined,
      dimensions: r.dimensions || undefined,
      createdAt: r.created_at,
    }));

    return res.json({ success: true, data: materials });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/materials/upload — 上传素材（支持 dataUrl / base64 Payload）
materialsRouter.post('/upload', (req, res) => {
  try {
    const { name = 'uploaded_file', dataUrl, url, mediaType, size } = req.body;

    const id = 'mat_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
    let finalUrl = url || '';
    let filePath = '';

    const isVideo = mediaType === 'video' || name.match(/\.(mp4|webm|mov)$/i);
    const calculatedType = isVideo ? 'video' : 'image';

    if (dataUrl && dataUrl.startsWith('data:')) {
      const matches = dataUrl.match(/^data:(.+);base64,(.+)$/);
      if (matches) {
        const ext = matches[1].split('/')[1] || (isVideo ? 'mp4' : 'png');
        const filename = `${id}.${ext}`;
        const fullPath = path.join(uploadsMaterialsDir, filename);
        const buffer = Buffer.from(matches[2], 'base64');

        fs.writeFileSync(fullPath, buffer);

        filePath = path.join('uploads', 'materials', filename).replace(/\\/g, '/');
        finalUrl = `/${filePath}`;
      }
    }

    if (!finalUrl) {
      finalUrl = url || 'https://images.unsplash.com/photo-1556228720-195a672e8a03?auto=format&fit=crop&w=600&q=80';
      filePath = finalUrl;
    }

    const calculatedSize = size || '2.5 MB';
    const createdAt = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const stmt = db.prepare(`
      INSERT INTO materials (id, name, file_path, url, media_type, size, duration, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      name,
      filePath,
      finalUrl,
      calculatedType,
      calculatedSize,
      isVideo ? '00:15' : null,
      createdAt
    );

    const createdItem = {
      id,
      name,
      filePath,
      url: finalUrl,
      type: calculatedType,
      size: calculatedSize,
      duration: isVideo ? '00:15' : undefined,
      createdAt,
    };

    return res.json({ success: true, data: createdItem, message: '素材成功上传并写入 SQLite 素材库！' });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/materials — 直接新增素材记录
materialsRouter.post('/', (req, res) => {
  try {
    const { name, url, type = 'image', size = '1.2 MB' } = req.body;
    if (!name || !url) return res.status(400).json({ success: false, error: 'Name and URL required' });

    const id = 'mat_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
    const createdAt = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const stmt = db.prepare(`
      INSERT INTO materials (id, name, file_path, url, media_type, size, duration, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(id, name, url, url, type, size, type === 'video' ? '00:15' : null, createdAt);

    return res.json({
      success: true,
      data: { id, name, url, type, size, createdAt },
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/materials/:id — 删除素材（兼删磁盘文件与 SQLite 记录）
materialsRouter.delete('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const stmt = db.prepare('SELECT * FROM materials WHERE id = ?');
    const existing = stmt.get(id) as any;

    if (existing) {
      if (existing.file_path && existing.file_path.startsWith('uploads/')) {
        const diskPath = path.join(process.cwd(), existing.file_path);
        if (fs.existsSync(diskPath)) {
          fs.unlinkSync(diskPath);
        }
      }

      const deleteStmt = db.prepare('DELETE FROM materials WHERE id = ?');
      deleteStmt.run(id);
    }

    return res.json({ success: true, message: '素材记录及磁盘关联文件已成功删除！' });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});
