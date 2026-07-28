import { Router } from 'express';
import { db } from '../lib/db';

export const tasksRouter = Router();

tasksRouter.get('/', (req, res) => {
  try {
    const stmt = db.prepare('SELECT * FROM tasks ORDER BY created_at DESC');
    const rows = stmt.all() as any[];
    const tasks = rows.map((r) => ({
      id: r.id,
      title: r.title,
      createdAt: r.created_at,
      status: r.status,
      currentStep: r.current_step,
      pipelineData: JSON.parse(r.pipeline_data || '{}'),
      thumbnailUrl: r.thumbnail_url,
    }));
    return res.json({ success: true, data: tasks });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});
