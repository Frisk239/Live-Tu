import { Router } from 'express';
import { db } from '../lib/db';

export const productsRouter = Router();

productsRouter.get('/', (req, res) => {
  try {
    const stmt = db.prepare('SELECT * FROM products ORDER BY updated_at DESC');
    const rows = stmt.all() as any[];
    const products = rows.map((r) => ({
      id: r.id,
      name: r.name,
      category: r.category,
      positioning: r.positioning,
      price: r.price,
      salesRecord: r.sales_record,
      coverImage: r.cover_image,
      model343: {
        clays: r.model343_clays,
        extracts: r.model343_extracts,
        surfactants: r.model343_surfactants,
      },
      sgsData: {
        oil8h: r.sgs_oil_8h,
        oil14d: r.sgs_oil_14d,
        blackhead14d: r.sgs_blackhead_14d,
      },
      prohibitedWords: JSON.parse(r.prohibited_words || '[]'),
      customSellingPoints: r.custom_selling_points,
      targetAudience: r.target_audience,
      updatedAt: r.updated_at,
    }));
    return res.json({ success: true, data: products });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});
