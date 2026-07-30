import { Router } from 'express';
import { db } from '../lib/db';
import { requireRole } from '../lib/auth';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { assertSafeRemoteUrl } from '../lib/safe-url';

export const bgmRouter = Router();

// Ensure uploads/bgm directory exists
const bgmDir = path.join(
  path.resolve(process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads')),
  'bgm'
);
if (!fs.existsSync(bgmDir)) {
  fs.mkdirSync(bgmDir, { recursive: true });
}

const audioMimeExtensions = new Map([
  ['audio/mpeg', 'mp3'],
  ['audio/wav', 'wav'],
  ['audio/x-wav', 'wav'],
  ['audio/ogg', 'ogg'],
  ['audio/aac', 'aac'],
  ['audio/mp4', 'm4a'],
  ['audio/x-m4a', 'm4a'],
]);
const streamingAudioUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, bgmDir),
    filename: (_req, file, callback) => {
      const extension = audioMimeExtensions.get(file.mimetype) || 'bin';
      callback(
        null,
        `bgm_${Date.now()}_${Math.random().toString(36).slice(2, 10)}.${extension}`
      );
    },
  }),
  limits: { files: 1, fileSize: 30 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    if (!audioMimeExtensions.has(file.mimetype)) {
      return callback(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'file'));
    }
    callback(null, true);
  },
});

function audioSignatureMatches(filePath: string, mimeType: string): boolean {
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(16);
    const bytesRead = fs.readSync(descriptor, header, 0, header.length, 0);
    if (bytesRead < 4) return false;
    if (mimeType === 'audio/mpeg') {
      return header.toString('ascii', 0, 3) === 'ID3' ||
        (header[0] === 0xff && (header[1] & 0xe0) === 0xe0);
    }
    if (mimeType === 'audio/wav' || mimeType === 'audio/x-wav') {
      return header.toString('ascii', 0, 4) === 'RIFF' &&
        header.toString('ascii', 8, 12) === 'WAVE';
    }
    if (mimeType === 'audio/ogg') return header.toString('ascii', 0, 4) === 'OggS';
    if (mimeType === 'audio/aac') {
      return header[0] === 0xff && (header[1] & 0xf6) === 0xf0;
    }
    if (mimeType === 'audio/mp4' || mimeType === 'audio/x-m4a') {
      return header.toString('ascii', 4, 8) === 'ftyp';
    }
    return false;
  } finally {
    fs.closeSync(descriptor);
  }
}

// POST /api/bgm/upload-file — bounded streaming upload for production audio.
bgmRouter.post('/upload-file', requireRole('admin'), (req, res) => {
  streamingAudioUpload.single('file')(req, res, (uploadError: any) => {
    if (uploadError) {
      const status = uploadError.code === 'LIMIT_FILE_SIZE' ? 413 : 415;
      return res.status(status).json({
        success: false,
        error: status === 413 ? '音频超过 30MB 上传限制' : '不支持的音频类型',
      });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, error: '必须提供 file 字段' });
    }
    if (String(req.body.licenseConfirmed) !== 'true') {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ success: false, error: '必须确认已取得商业使用授权' });
    }

    const uploadedPath = path.resolve(req.file.path);
    const expectedRoot = `${path.resolve(bgmDir)}${path.sep}`;
    if (!uploadedPath.startsWith(expectedRoot) || !audioSignatureMatches(uploadedPath, req.file.mimetype)) {
      try {
        if (fs.existsSync(uploadedPath)) fs.unlinkSync(uploadedPath);
      } catch {}
      return res.status(415).json({ success: false, error: '音频内容与声明类型不匹配' });
    }

    try {
      const bgmId = `bgm_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const trackName = String(req.body.name || req.file.originalname).slice(0, 255);
      const relativePath = `uploads/bgm/${req.file.filename}`;
      const audioUrl = `/uploads/bgm/${req.file.filename}`;
      const styleTags = String(req.body.styleTags || '')
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean)
        .slice(0, 20);

      db.prepare(`
        INSERT INTO bgm_library (
          id, track_name, artist, style_tags, bpm, mood, license_type, audio_path, audio_url
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        bgmId,
        trackName,
        String(req.body.artist || '自定义独立音乐人').slice(0, 255),
        JSON.stringify(styleTags),
        Math.min(300, Math.max(20, Number(req.body.bpm) || 100)),
        String(req.body.mood || '通用').slice(0, 100),
        '已商业授权',
        relativePath,
        audioUrl
      );

      return res.status(201).json({
        success: true,
        data: {
          id: bgmId,
          track_name: trackName,
          artist: String(req.body.artist || '自定义独立音乐人').slice(0, 255),
          style_tags: styleTags,
          bpm: Math.min(300, Math.max(20, Number(req.body.bpm) || 100)),
          mood: String(req.body.mood || '通用').slice(0, 100),
          license_type: '已商业授权',
          audio_url: audioUrl,
        },
      });
    } catch (error: any) {
      try {
        if (fs.existsSync(uploadedPath)) fs.unlinkSync(uploadedPath);
      } catch {}
      return res.status(500).json({ success: false, error: error.message || '音频上传失败' });
    }
  });
});

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
bgmRouter.post('/upload', requireRole('admin'), async (req, res) => {
  try {
    const { name, artist, bpm, mood, styleTags, fileDataUrl, url } = req.body;
    if (req.body.licenseConfirmed !== true) {
      return res.status(400).json({ success: false, error: '必须确认已取得商业使用授权' });
    }
    if (fileDataUrl && process.env.NODE_ENV === 'production') {
      return res.status(410).json({
        success: false,
        error: '旧版 Base64 音频上传已停用，请使用 /api/bgm/upload-file',
      });
    }
    if (url) await assertSafeRemoteUrl(String(url));
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
      return res.status(400).json({ success: false, error: '必须提供音频文件或已授权的 HTTPS URL' });
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
bgmRouter.delete('/:id', requireRole('admin'), (req, res) => {
  try {
    const { id } = req.params;
    const stmt = db.prepare('SELECT * FROM bgm_library WHERE id = ?');
    const item = stmt.get(id) as any;

    if (!item) {
      return res.status(404).json({ success: false, error: 'BGM 音频未找到' });
    }

    if (item.audio_path) {
      const relativePath = String(item.audio_path).replaceAll('\\', '/').replace(/^uploads\/bgm\//, '');
      const absolutePath = path.resolve(bgmDir, relativePath);
      const expectedRoot = `${path.resolve(bgmDir)}${path.sep}`;
      if (absolutePath.startsWith(expectedRoot) && fs.existsSync(absolutePath)) {
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
