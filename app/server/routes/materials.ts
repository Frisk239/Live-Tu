import { Router } from 'express';
import { db } from '../lib/db';

export const materialsRouter = Router();

materialsRouter.get('/', (req, res) => {
  try {
    const stmt = db.prepare('SELECT * FROM materials ORDER BY created_at DESC');
    const rows = stmt.all() as any[];
    return res.json({ success: true, data: rows });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});
