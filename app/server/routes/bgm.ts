import { Router } from 'express';
import { db } from '../lib/db';
import fs from 'node:fs';
import path from 'node:path';

export const bgmRouter = Router();

// Ensure uploads/bgm directory exists
const bgmDir = path.join(process.cwd(), 'uploads', 'bgm');
if (!fs.existsSync(bgmDir)) {
  fs.mkdirSync(bgmDir, { recursive: true });
}

// GET /api/bgm — 获取全量 BGM 列表
bgmRouter.get('/', (req, res) => {
  try {
    const stmt = db.prepare('SELECT * FROM bgm_library ORDER BY created_at DESC');
    const rows = stmt.all() as any[];

    const formattedRows = rows.map((r) => {
      let styleTags: string[] = [];
      try {
        styleTags = JSON.parse(r.style_tags || '[]');
      } catch {
        styleTags = [r.style_tags || '通用'];
      }
      return {
        id: r.id,
        track_name: r.track_name,
        artist: r.artist || '未知未知艺术家',
        style_tags: styleTags,
        bpm: r.bpm || 90,
        mood: r.mood || '治愈',
        license_type: r.license_type || '已商业授权',
        audio_path: r.audio_path,
        audio_url: r.audio_url,
        created_at: r.created_at,
      };
    });

    return res.json({ success: true, data: formattedRows });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/bgm/upload — 上传新 BGM 音频
bgmRouter.post('/upload', async (req, res) => {
  try {
    const { name, artist, bpm, mood, styleTags, fileDataUrl, url } = req.body;
    const bgmId = `bgm_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const trackName = name || `BGM_${Date.now()}`;
    let finalUrl = url || '';
    let finalPath = '';

    if (fileDataUrl && fileDataUrl.startsWith('data:')) {
      const matches = fileDataUrl.match(/^data:audio\/([a-zA-Z0-9]+);base64,(.+)$/);
      const ext = matches ? matches[1] : 'mp3';
      const base64Data = matches ? matches[2] : fileDataUrl.split(',')[1];

      const filename = `${bgmId}.${ext}`;
      finalPath = path.join('uploads', 'bgm', filename);
      const absolutePath = path.join(process.cwd(), finalPath);

      fs.writeFileSync(absolutePath, Buffer.from(base64Data, 'base64'));
      finalUrl = `/uploads/bgm/${filename}`;
    }

    if (!finalUrl) {
      finalUrl = 'https://assets.mixkit.co/music/preview/mixkit-tech-house-vibes-130.mp3';
    }

    const tagsJson = JSON.stringify(Array.isArray(styleTags) ? styleTags : [styleTags || '通用']);

    const stmt = db.prepare(`
      INSERT INTO bgm_library (
        id, track_name, artist, style_tags, bpm, mood, license_type, audio_path, audio_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      bgmId,
      trackName,
      artist || '自定义独立音乐人',
      tagsJson,
      Number(bpm) || 100,
      mood || '治愈',
      '已商业授权',
      finalPath,
      finalUrl
    );

    const insertedStmt = db.prepare('SELECT * FROM bgm_library WHERE id = ?');
    const inserted = insertedStmt.get(bgmId) as any;

    return res.json({
      success: true,
      data: {
        id: inserted.id,
        track_name: inserted.track_name,
        artist: inserted.artist,
        style_tags: JSON.parse(inserted.style_tags || '[]'),
        bpm: inserted.bpm,
        mood: inserted.mood,
        license_type: inserted.license_type,
        audio_url: inserted.audio_url,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/bgm/:id — 删除 BGM
bgmRouter.delete('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const stmt = db.prepare('SELECT * FROM bgm_library WHERE id = ?');
    const item = stmt.get(id) as any;

    if (!item) {
      return res.status(404).json({ success: false, error: 'BGM 音频未找到' });
    }

    if (item.audio_path) {
      const absolutePath = path.join(process.cwd(), item.audio_path);
      if (fs.existsSync(absolutePath)) {
        try {
          fs.unlinkSync(absolutePath);
        } catch {}
      }
    }

    const deleteStmt = db.prepare('DELETE FROM bgm_library WHERE id = ?');
    deleteStmt.run(id);

    return res.json({ success: true, message: 'BGM 音频删除成功' });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});
