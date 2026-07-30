import { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import multer from 'multer';
import { db } from '../lib/db';
import {
  deleteMinioObjectByUrl,
  isMinioConfigured,
  uploadFileToMinio,
  uploadToMinio,
} from '../lib/minio';
import { preprocessVideo, saveVideoPreprocessResult } from '../lib/video-preprocessor';
import { requireRole } from '../lib/auth';
import { assertSafeRemoteUrl } from '../lib/safe-url';

export const materialsRouter = Router();

const uploadsRoot = path.resolve(process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads'));
const uploadsMaterialsDir = path.join(uploadsRoot, 'materials');

if (!fs.existsSync(uploadsMaterialsDir)) {
  fs.mkdirSync(uploadsMaterialsDir, { recursive: true });
}

const allowedUploadMimeTypes = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['video/mp4', 'mp4'],
  ['video/webm', 'webm'],
  ['video/quicktime', 'mov'],
]);
const streamingUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, uploadsMaterialsDir),
    filename: (_req, file, callback) => {
      const extension = allowedUploadMimeTypes.get(file.mimetype) || 'bin';
      callback(
        null,
        `mat_${Date.now()}_${Math.random().toString(36).slice(2, 10)}.${extension}`
      );
    },
  }),
  limits: { files: 1, fileSize: 100 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    if (!allowedUploadMimeTypes.has(file.mimetype)) {
      return callback(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'file'));
    }
    callback(null, true);
  },
});

function fileSignatureMatches(filePath: string, mimeType: string): boolean {
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(16);
    const bytesRead = fs.readSync(descriptor, header, 0, header.length, 0);
    if (bytesRead < 4) return false;

    if (mimeType === 'image/jpeg') return header[0] === 0xff && header[1] === 0xd8;
    if (mimeType === 'image/png') {
      return header.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      );
    }
    if (mimeType === 'image/webp') {
      return header.toString('ascii', 0, 4) === 'RIFF' &&
        header.toString('ascii', 8, 12) === 'WEBP';
    }
    if (mimeType === 'video/webm') {
      return header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    }
    if (mimeType === 'video/mp4' || mimeType === 'video/quicktime') {
      return header.toString('ascii', 4, 8) === 'ftyp';
    }
    return false;
  } finally {
    fs.closeSync(descriptor);
  }
}

function formatDurationStr(sec: number): string {
  if (!sec || isNaN(sec) || sec <= 0) return '00:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

// GET /api/materials — 获取素材库全量列表
materialsRouter.get('/', (req, res) => {
  try {
    const rows = req.authUser?.role === 'admin'
      ? db.prepare('SELECT * FROM materials ORDER BY created_at DESC').all() as any[]
      : db.prepare(
          'SELECT * FROM materials WHERE owner_id = ? OR owner_id IS NULL ORDER BY created_at DESC'
        ).all(req.authUser!.id) as any[];

    const materials = rows.map((r) => {
      let tags: string[] = [];
      try {
        tags = JSON.parse(r.tags || '[]');
      } catch {
        tags = [];
      }
      return {
        id: r.id,
        name: r.name,
        filePath: r.file_path,
        url: r.url,
        type: r.media_type as 'video' | 'image',
        size: r.size || '1.0 MB',
        duration: r.duration || undefined,
        dimensions: r.dimensions || undefined,
        tags,
        createdAt: r.created_at,
      };
    });

    return res.json({ success: true, data: materials });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/materials/upload-file — streaming multipart upload (production path)
materialsRouter.post('/upload-file', (req, res) => {
  streamingUpload.single('file')(req, res, async (uploadError: any) => {
    if (uploadError) {
      const status = uploadError.code === 'LIMIT_FILE_SIZE' ? 413 : 415;
      return res.status(status).json({
        success: false,
        error:
          uploadError.code === 'LIMIT_FILE_SIZE'
            ? '文件超过 100MB 上传限制'
            : '不支持的文件类型',
      });
    }
    if (!req.file) {
      return res.status(400).json({ success: false, error: '必须提供 file 字段' });
    }

    const uploadedPath = path.resolve(req.file.path);
    const expectedRoot = `${uploadsMaterialsDir}${path.sep}`;
    if (!uploadedPath.startsWith(expectedRoot)) {
      return res.status(400).json({ success: false, error: '上传路径无效' });
    }
    if (!fileSignatureMatches(uploadedPath, req.file.mimetype)) {
      fs.unlinkSync(uploadedPath);
      return res.status(415).json({ success: false, error: '文件内容与声明类型不匹配' });
    }

    const isVideo = req.file.mimetype.startsWith('video/');
    if (!isVideo && req.file.size > 20 * 1024 * 1024) {
      fs.unlinkSync(uploadedPath);
      return res.status(413).json({ success: false, error: '图片超过 20MB 上传限制' });
    }
    const maximumUserStorage = Math.max(
      100 * 1024 * 1024,
      Number(process.env.MAX_USER_STORAGE_BYTES || 5 * 1024 * 1024 * 1024)
    );
    const usedStorage = db.prepare(
      'SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM materials WHERE owner_id = ?'
    ).get(req.authUser!.id) as { bytes: number };
    if (Number(usedStorage.bytes) + req.file.size > maximumUserStorage) {
      fs.unlinkSync(uploadedPath);
      return res.status(413).json({
        success: false,
        error: '用户素材存储配额已用尽，请删除旧素材后重试',
      });
    }

    const id = `mat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const name = String(req.body?.name || req.file.originalname || req.file.filename).slice(0, 255);
    const relativeFilePath = path.join('uploads', 'materials', req.file.filename).replace(/\\/g, '/');
    const finalUrl = `/uploads/materials/${req.file.filename}`;
    let storageUrl: string | null = null;
    let duration: string | null = null;
    let dimensions: string | null = null;

    try {
      if (isVideo) {
        const preprocessed = await preprocessVideo(uploadedPath, id);
        await saveVideoPreprocessResult(id, preprocessed);
        duration = formatDurationStr(preprocessed.duration);
        dimensions = preprocessed.resolution;
      }
      if (isMinioConfigured()) {
        storageUrl = await uploadFileToMinio(
          req.file.filename,
          uploadedPath,
          req.file.mimetype
        );
      }

      const createdAt = new Date().toISOString();
      const size = `${(req.file.size / (1024 * 1024)).toFixed(1)} MB`;
      db.prepare(
        `INSERT INTO materials (
          id, name, file_path, url, storage_url, media_type, size, size_bytes,
          duration, dimensions, created_at, owner_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        name,
        relativeFilePath,
        finalUrl,
        storageUrl,
        isVideo ? 'video' : 'image',
        size,
        req.file.size,
        duration,
        dimensions,
        createdAt,
        req.authUser!.id
      );

      return res.status(201).json({
        success: true,
        data: {
          id,
          name,
          filePath: relativeFilePath,
          url: finalUrl,
          type: isVideo ? 'video' : 'image',
          size,
          duration: duration || undefined,
          dimensions: dimensions || undefined,
          createdAt,
        },
      });
    } catch (error: any) {
      if (storageUrl) {
        try {
          await deleteMinioObjectByUrl(storageUrl);
        } catch {}
      }
      try {
        const cached = db.prepare(
          'SELECT keyframe_urls FROM video_preprocess_cache WHERE id = ?'
        ).get(id) as { keyframe_urls?: string } | undefined;
        const keyframeUrls = cached?.keyframe_urls
          ? JSON.parse(cached.keyframe_urls) as unknown
          : [];
        if (Array.isArray(keyframeUrls)) {
          for (const keyframeUrl of keyframeUrls) {
            if (typeof keyframeUrl !== 'string' || !keyframeUrl.startsWith('/uploads/')) continue;
            const keyframePath = path.resolve(
              uploadsRoot,
              keyframeUrl.slice('/uploads/'.length)
            );
            if (
              keyframePath.startsWith(`${uploadsRoot}${path.sep}`) &&
              fs.existsSync(keyframePath)
            ) {
              fs.unlinkSync(keyframePath);
            }
          }
        }
        db.prepare('DELETE FROM video_preprocess_cache WHERE id = ?').run(id);
      } catch {}
      try {
        if (fs.existsSync(uploadedPath)) fs.unlinkSync(uploadedPath);
      } catch {}
      return res.status(error.status || 500).json({
        success: false,
        error: error.message || '上传处理失败',
      });
    }
  });
});

// POST /api/materials/upload — 上传素材（支持 dataUrl / base64 Payload）
materialsRouter.post('/upload', async (req, res) => {
  try {
    if (process.env.NODE_ENV === 'production') {
      return res.status(410).json({
        success: false,
        error: '旧版 Base64 上传已停用，请使用 /api/materials/upload-file',
      });
    }
    const { name = 'uploaded_file', dataUrl, url, mediaType, size } = req.body;

    const id = 'mat_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
    let finalUrl = url || '';
    let filePath = '';

    const isVideo = mediaType === 'video' || name.match(/\.(mp4|webm|mov)$/i);
    const calculatedType = isVideo ? 'video' : 'image';
    if (url && String(url).startsWith('https://')) {
      await assertSafeRemoteUrl(String(url));
    } else if (url && !String(url).startsWith('/uploads/')) {
      return res.status(400).json({
        success: false,
        error: '素材 URL 必须使用 HTTPS 或站内上传路径',
      });
    }

    if (dataUrl && dataUrl.startsWith('data:')) {
      const base64Str = dataUrl.split(',')[1] || '';
      const estimatedBytes = Math.ceil(base64Str.length * 0.75);
      const maxAllowedBytes = isVideo ? 100 * 1024 * 1024 : 20 * 1024 * 1024;
      if (estimatedBytes > maxAllowedBytes) {
        return res.status(413).json({ success: false, error: `文件超过大小限制 (最大 ${isVideo ? '100MB' : '20MB'})` });
      }

      const matches = dataUrl.match(/^data:(.+);base64,(.+)$/);
      if (matches) {
        const mimeType = matches[1];
        const allowedMimeTypes = new Map([
          ['image/jpeg', 'jpg'],
          ['image/png', 'png'],
          ['image/webp', 'webp'],
          ['video/mp4', 'mp4'],
          ['video/webm', 'webm'],
          ['video/quicktime', 'mov'],
        ]);
        const ext = allowedMimeTypes.get(mimeType);
        if (!ext) {
          return res.status(415).json({ success: false, error: '不支持的文件类型' });
        }
        const filename = `${id}.${ext}`;
        const fullPath = path.join(uploadsMaterialsDir, filename);
        const buffer = Buffer.from(matches[2], 'base64');

        fs.writeFileSync(fullPath, buffer);

        filePath = path.join('uploads', 'materials', filename).replace(/\\/g, '/');
        finalUrl = `/${filePath}`;

        // 如果配置了 MinIO 对象存储，自动同步至 MinIO 并获取公网 URL
        if (isMinioConfigured()) {
          try {
            const minioUrl = await uploadToMinio(filename, buffer, mimeType);
            finalUrl = minioUrl;
          } catch (minioErr: any) {
            console.warn('[materials] MinIO 上传失败，回退使用本地路径:', minioErr.message);
          }
        }
      }
    }

    if (!finalUrl) {
      return res.status(400).json({ success: false, error: '必须提供有效文件内容或素材 URL' });
    }

    let durationStr: string | null = isVideo ? '00:15' : null;
    let dimensionsStr: string | null = null;

    // 上传视频时自动触发 preprocessVideo 填充精确视频元信息
    const uploadedDiskPath = path.join(uploadsMaterialsDir, path.basename(filePath));
    if (isVideo && filePath && fs.existsSync(uploadedDiskPath)) {
      try {
        const preRes = await preprocessVideo(uploadedDiskPath, id);
        await saveVideoPreprocessResult(id, preRes);
        durationStr = formatDurationStr(preRes.duration);
        dimensionsStr = preRes.resolution;
      } catch (err: any) {
        console.warn('[materials] Upload preprocess error:', err.message);
      }
    }

    const calculatedSize = size || '2.5 MB';
    const createdAt = new Date().toISOString();

    const stmt = db.prepare(`
      INSERT INTO materials (id, name, file_path, url, media_type, size, duration, dimensions, created_at, owner_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      name,
      filePath,
      finalUrl,
      calculatedType,
      calculatedSize,
      durationStr,
      dimensionsStr,
      createdAt,
      req.authUser!.id
    );

    const createdItem = {
      id,
      name,
      filePath,
      url: finalUrl,
      type: calculatedType,
      size: calculatedSize,
      duration: durationStr || undefined,
      dimensions: dimensionsStr || undefined,
      createdAt,
    };

    return res.json({ success: true, data: createdItem, message: '素材成功上传并完成预处理！' });
  } catch (err: any) {
    return res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// POST /api/materials — 直接新增素材记录
materialsRouter.post('/', async (req, res) => {
  try {
    const { name, url, type = 'image', size = '1.2 MB' } = req.body;
    if (!name || !url) return res.status(400).json({ success: false, error: 'Name and URL required' });
    if (!String(url).startsWith('https://') && !String(url).startsWith('/uploads/')) {
      return res.status(400).json({ success: false, error: '素材 URL 必须使用 HTTPS 或站内上传路径' });
    }
    if (String(url).startsWith('https://')) await assertSafeRemoteUrl(String(url));

    const id = 'mat_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
    const createdAt = new Date().toISOString();

    const stmt = db.prepare(`
      INSERT INTO materials (id, name, file_path, url, media_type, size, duration, created_at, owner_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      name,
      url,
      url,
      type,
      size,
      type === 'video' ? '00:15' : null,
      createdAt,
      req.authUser!.id
    );

    return res.json({
      success: true,
      data: { id, name, url, type, size, createdAt },
    });
  } catch (err: any) {
    return res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// POST /api/materials/import-directory — 支持一键扫描根目录 [爆款视频] 下的所有 .mp4/.mov 文件导入到素材库并抽取关键帧与元信息
materialsRouter.post('/import-directory', requireRole('admin'), async (req, res) => {
  try {
    const configuredImportRoot = String(process.env.MATERIAL_IMPORT_ROOT || '').trim();
    if (process.env.NODE_ENV === 'production' && !configuredImportRoot) {
      return res.status(503).json({
        success: false,
        error: '生产环境未配置 MATERIAL_IMPORT_ROOT，目录导入不可用',
      });
    }
    const importRoot = path.resolve(
      configuredImportRoot || path.join(process.cwd(), '爆款视频')
    );
    const targetDir = req.body.dirPath
      ? path.resolve(importRoot, String(req.body.dirPath))
      : importRoot;
    const relativeTarget = path.relative(importRoot, targetDir);
    if (
      relativeTarget === '..' ||
      relativeTarget.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativeTarget)
    ) {
      return res.status(400).json({
        success: false,
        error: '导入目录必须位于 MATERIAL_IMPORT_ROOT 内',
      });
    }

    if (!fs.existsSync(targetDir)) {
      return res.status(404).json({ success: false, error: `目录不存在: ${targetDir}` });
    }

    const files = fs.readdirSync(targetDir);
    const videoFiles = files.filter((f) => f.match(/\.(mp4|mov|webm)$/i));

    if (videoFiles.length === 0) {
      return res.json({ success: true, message: '未在该目录下找到 .mp4/.mov 视频文件', importedCount: 0, items: [] });
    }

    let importedCount = 0;
    const importedItems: any[] = [];

    const stmtCheck = db.prepare('SELECT id, file_path FROM materials WHERE name = ?');
    const stmtInsert = db.prepare(`
      INSERT INTO materials (id, name, file_path, url, media_type, size, duration, dimensions, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const stmtUpdate = db.prepare(`
      UPDATE materials SET file_path = ?, url = ?, duration = ?, dimensions = ? WHERE id = ?
    `);

    for (const filename of videoFiles) {
      const fullSourcePath = path.join(targetDir, filename);
      const stat = fs.statSync(fullSourcePath);
      const sizeMb = (stat.size / (1024 * 1024)).toFixed(1) + ' MB';

      // 复制到 uploads/materials/
      const targetMaterialsPath = path.join(uploadsMaterialsDir, filename);
      if (!fs.existsSync(targetMaterialsPath)) {
        fs.copyFileSync(fullSourcePath, targetMaterialsPath);
      }

      const relFilePath = `uploads/materials/${filename}`;
      const webUrl = `/uploads/materials/${encodeURIComponent(filename)}`;

      // 尝试匹配已存在素材
      const existing = stmtCheck.get(filename) as any;
      const id = existing ? existing.id : 'mat_viral_' + Math.random().toString(36).substring(2, 8);

      // 执行视频预处理抽取元信息与关键帧
      let durationStr = '00:15';
      let dimensionsStr = '1080x1920';

      try {
        const preRes = await preprocessVideo(targetMaterialsPath, id);
        await saveVideoPreprocessResult(id, preRes);
        durationStr = formatDurationStr(preRes.duration);
        dimensionsStr = preRes.resolution;
      } catch (err: any) {
        console.warn(`[materials] Preprocess failed for imported video ${filename}:`, err.message);
      }

      const nowIso = new Date().toISOString();

      if (existing) {
        stmtUpdate.run(relFilePath, webUrl, durationStr, dimensionsStr, id);
      } else {
        stmtInsert.run(
          id,
          filename,
          relFilePath,
          webUrl,
          'video',
          sizeMb,
          durationStr,
          dimensionsStr,
          nowIso
        );
        importedCount++;
      }

      importedItems.push({
        id,
        name: filename,
        filePath: relFilePath,
        url: webUrl,
        size: sizeMb,
        duration: durationStr,
        dimensions: dimensionsStr,
      });
    }

    return res.json({
      success: true,
      message: `成功扫描并导入目录中的 ${importedCount} 个新视频文件（共处理 ${videoFiles.length} 个视频物料）。`,
      importedCount,
      totalProcessed: videoFiles.length,
      items: importedItems,
    });
  } catch (err: any) {
    console.error('[materials] Import directory error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Alias sync-viral to import-directory for backward compatibility
materialsRouter.post('/sync-viral', requireRole('admin'), (req, res, next) => {
  req.url = '/import-directory';
  (materialsRouter as any).handle(req, res, next);
});

// DELETE /api/materials/:id — 删除素材（兼删磁盘文件与 SQLite 记录）
materialsRouter.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const existing = req.authUser?.role === 'admin'
      ? db.prepare('SELECT * FROM materials WHERE id = ?').get(id) as any
      : db.prepare('SELECT * FROM materials WHERE id = ? AND owner_id = ?')
          .get(id, req.authUser!.id) as any;

    if (existing) {
      await deleteMinioObjectByUrl(String(existing.storage_url || existing.url || ''));

      if (existing.file_path && existing.file_path.startsWith('uploads/')) {
        const relativePath = existing.file_path.slice('uploads/'.length);
        const diskPath = path.resolve(uploadsRoot, relativePath);
        const expectedRoot = `${uploadsRoot}${path.sep}`;
        if (diskPath.startsWith(expectedRoot) && fs.existsSync(diskPath)) {
          fs.unlinkSync(diskPath);
        }
      }

      const cached = db.prepare(
        'SELECT keyframe_urls FROM video_preprocess_cache WHERE id = ?'
      ).get(id) as { keyframe_urls?: string } | undefined;
      if (cached?.keyframe_urls) {
        try {
          const keyframeUrls = JSON.parse(cached.keyframe_urls) as unknown;
          if (Array.isArray(keyframeUrls)) {
            for (const keyframeUrl of keyframeUrls) {
              if (typeof keyframeUrl !== 'string' || !keyframeUrl.startsWith('/uploads/')) continue;
              const keyframePath = path.resolve(
                uploadsRoot,
                keyframeUrl.slice('/uploads/'.length)
              );
              const expectedRoot = `${uploadsRoot}${path.sep}`;
              if (keyframePath.startsWith(expectedRoot) && fs.existsSync(keyframePath)) {
                fs.unlinkSync(keyframePath);
              }
            }
          }
        } catch {}
      }

      const deleteStmt = db.prepare('DELETE FROM materials WHERE id = ?');
      deleteStmt.run(id);

      // Clean up cache if any
      try {
        db.prepare('DELETE FROM video_preprocess_cache WHERE id = ?').run(id);
      } catch (_e) {}
    } else {
      return res.status(404).json({ success: false, error: '素材不存在或无权删除' });
    }

    return res.json({ success: true, message: '素材记录及磁盘关联文件已成功删除！' });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/materials/:id/tags — 更新素材标签
materialsRouter.patch('/:id/tags', (req, res) => {
  try {
    const { id } = req.params;
    const { tags } = req.body;
    if (!Array.isArray(tags)) {
      return res.status(400).json({ success: false, error: 'tags must be an array' });
    }
    const result = req.authUser?.role === 'admin'
      ? db.prepare('UPDATE materials SET tags = ? WHERE id = ?').run(JSON.stringify(tags), id)
      : db.prepare('UPDATE materials SET tags = ? WHERE id = ? AND owner_id = ?')
          .run(JSON.stringify(tags), id, req.authUser!.id);
    if (Number(result.changes) === 0) {
      return res.status(404).json({ success: false, error: '素材不存在或无权修改' });
    }
    return res.json({ success: true, tags, message: '素材标签设置成功' });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});
