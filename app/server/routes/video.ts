import { Router } from 'express';
import {
  preprocessVideo,
  getVideoPreprocessCache,
  saveVideoPreprocessResult,
  VideoPreprocessResult,
} from '../lib/video-preprocessor';
import { db } from '../lib/db';

export const videoRouter = Router();

// POST /api/video/preprocess — 执行视频预处理（提取元数据、生成关键帧并自动缓存）
videoRouter.post('/preprocess', async (req, res) => {
  const { videoPath, videoId, force } = req.body;

  if (!videoId && req.authUser?.role !== 'admin') {
    return res.status(400).json({
      success: false,
      error: '普通用户必须通过本人素材 videoId 发起预处理',
    });
  }

  let authorizedVideoPath = String(videoPath || '');
  if (videoId) {
    const material = req.authUser?.role === 'admin'
      ? db.prepare('SELECT file_path FROM materials WHERE id = ?').get(videoId) as
          | { file_path: string }
          | undefined
      : db.prepare(
          'SELECT file_path FROM materials WHERE id = ? AND owner_id = ?'
        ).get(videoId, req.authUser!.id) as { file_path: string } | undefined;
    if (!material) {
      return res.status(404).json({ success: false, error: '素材不存在或无权处理' });
    }
    authorizedVideoPath = material.file_path;
  }
  if (!authorizedVideoPath) {
    return res.status(400).json({ success: false, error: 'videoPath is required' });
  }

  const lookupKey = videoId || authorizedVideoPath;

  try {
    if (!force) {
      const cached = await getVideoPreprocessCache(lookupKey);
      if (cached) {
        return res.json({
          success: true,
          data: cached,
          cached: true,
          message: 'Video preprocess result retrieved from SQLite cache',
        });
      }
    }

    const result = await preprocessVideo(authorizedVideoPath, videoId);
    await saveVideoPreprocessResult(lookupKey, result);

    return res.json({
      success: true,
      data: result,
      cached: false,
      message: 'Video preprocessing completed',
    });
  } catch (error: any) {
    console.error('[video-route] Preprocess failed:', error);
    return res.status(500).json({ success: false, error: error.message || 'Video preprocessing failed' });
  }
});

// GET /api/video/keyframes/:id — 根据视频ID或路径查询提取的关键帧列表
videoRouter.get('/keyframes/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const material = req.authUser?.role === 'admin'
      ? db.prepare('SELECT * FROM materials WHERE id = ?').get(id) as any
      : db.prepare(
          'SELECT * FROM materials WHERE id = ? AND owner_id = ?'
        ).get(id, req.authUser!.id) as any;
    if (!material && req.authUser?.role !== 'admin') {
      return res.status(404).json({
        success: false,
        error: '素材不存在或无权读取关键帧',
      });
    }

    const cached = await getVideoPreprocessCache(id);
    if (cached) {
      return res.json({
        success: true,
        data: {
          videoId: id,
          keyframes: cached.keyframeUrls || [],
          timestamps: cached.keyframeTimestamps || [],
          duration: cached.duration,
          resolution: cached.resolution,
        },
      });
    }

    // Try finding in materials table as fallback
    if (material && material.file_path) {
      const result = await preprocessVideo(material.file_path, id);
      await saveVideoPreprocessResult(id, result);
      return res.json({
        success: true,
        data: {
          videoId: id,
          keyframes: result.keyframeUrls || [],
          timestamps: result.keyframeTimestamps || [],
          duration: result.duration,
          resolution: result.resolution,
        },
      });
    }

    return res.status(404).json({
      success: false,
      error: `No preprocessed video cache or material found for id '${id}'`,
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

console.log('Video sub-router registered');
