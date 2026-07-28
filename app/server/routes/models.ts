import { Router } from 'express';
import { db } from '../lib/db';

export const modelsRouter = Router();

modelsRouter.get('/config', (req, res) => {
  try {
    const stmt = db.prepare('SELECT * FROM model_config');
    const rows = stmt.all() as any[];
    return res.json({ success: true, data: rows });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});
