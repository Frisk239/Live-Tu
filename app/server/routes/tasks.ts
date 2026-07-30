import { Router } from 'express';
import { db } from '../lib/db';

export const tasksRouter = Router();

// GET /api/tasks — 获取全量历史任务列表
tasksRouter.get('/', (req, res) => {
  try {
    const isAdmin = req.authUser?.role === 'admin';
    const rows = isAdmin
      ? db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all() as any[]
      : db.prepare('SELECT * FROM tasks WHERE owner_id = ? ORDER BY created_at DESC')
          .all(req.authUser!.id) as any[];
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

// GET /api/tasks/:id — 获取单个任务详情
tasksRouter.get('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const r = req.authUser?.role === 'admin'
      ? db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any
      : db.prepare('SELECT * FROM tasks WHERE id = ? AND owner_id = ?')
          .get(id, req.authUser!.id) as any;
    if (!r) {
      return res.status(404).json({ success: false, error: '任务不存在' });
    }
    return res.json({
      success: true,
      data: {
        id: r.id,
        title: r.title,
        createdAt: r.created_at,
        status: r.status,
        currentStep: r.current_step,
        pipelineData: JSON.parse(r.pipeline_data || '{}'),
        thumbnailUrl: r.thumbnail_url,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/tasks — 保存 / 更新任务快照
tasksRouter.post('/', (req, res) => {
  try {
    const { id, title, status = 'completed', currentStep = 1, pipelineData = {}, thumbnailUrl } = req.body;
    const taskId = id || `task_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const taskTitle = title || `反推工程_${new Date().toLocaleDateString('zh-CN')}`;
    const pipelineDataStr = JSON.stringify(pipelineData);

    const exist = db.prepare('SELECT id, owner_id FROM tasks WHERE id = ?').get(taskId) as
      | { id: string; owner_id: string | null }
      | undefined;
    if (exist && req.authUser?.role !== 'admin' && exist.owner_id !== req.authUser?.id) {
      return res.status(403).json({ success: false, error: '无权修改该任务' });
    }

    if (exist) {
      const updateStmt = db.prepare(`
        UPDATE tasks
        SET title = ?, status = ?, current_step = ?, pipeline_data = ?, thumbnail_url = ?
        WHERE id = ?
      `);
      updateStmt.run(taskTitle, status, Number(currentStep) || 1, pipelineDataStr, thumbnailUrl || null, taskId);
    } else {
      const insertStmt = db.prepare(`
        INSERT INTO tasks (id, title, status, current_step, pipeline_data, thumbnail_url, owner_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      insertStmt.run(
        taskId,
        taskTitle,
        status,
        Number(currentStep) || 1,
        pipelineDataStr,
        thumbnailUrl || null,
        req.authUser!.id
      );
    }

    const savedStmt = db.prepare('SELECT * FROM tasks WHERE id = ?');
    const saved = savedStmt.get(taskId) as any;

    return res.json({
      success: true,
      data: {
        id: saved.id,
        title: saved.title,
        createdAt: saved.created_at,
        status: saved.status,
        currentStep: saved.current_step,
        pipelineData: JSON.parse(saved.pipeline_data || '{}'),
        thumbnailUrl: saved.thumbnail_url,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/tasks/:id — 删除历史任务
tasksRouter.delete('/:id', (req, res) => {
  try {
    const { id } = req.params;
    const result = req.authUser?.role === 'admin'
      ? db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
      : db.prepare('DELETE FROM tasks WHERE id = ? AND owner_id = ?').run(id, req.authUser!.id);
    if (Number(result.changes) === 0) {
      return res.status(404).json({ success: false, error: '任务不存在或无权删除' });
    }
    return res.json({ success: true, message: '历史任务清理成功' });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});
