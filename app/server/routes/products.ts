import { Router } from 'express';
import { db } from '../lib/db';

export const productsRouter = Router();

// GET /api/products — 获取所有产品列表
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

// GET /api/products/:id — 获取单个产品
productsRouter.get('/:id', (req, res) => {
  try {
    const stmt = db.prepare('SELECT * FROM products WHERE id = ?');
    const r = stmt.get(req.params.id) as any;
    if (!r) return res.status(404).json({ success: false, error: 'Product not found' });

    const product = {
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
    };
    return res.json({ success: true, data: product });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/products — 新增产品
productsRouter.post('/', (req, res) => {
  try {
    const {
      name,
      category = '美妆护肤',
      positioning = '',
      price = '',
      salesRecord = '',
      coverImage = '',
      model343,
      sgsData,
      prohibitedWords = [],
      customSellingPoints = '',
      targetAudience = '',
    } = req.body;

    if (!name) return res.status(400).json({ success: false, error: 'Product name is required' });

    const id = req.body.id || ('prod_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6));

    const stmt = db.prepare(`
      INSERT INTO products (
        id, name, category, positioning, price, sales_record,
        model343_clays, model343_extracts, model343_surfactants,
        sgs_oil_8h, sgs_oil_14d, sgs_blackhead_14d,
        prohibited_words, target_audience, custom_selling_points, cover_image, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?, CURRENT_TIMESTAMP
      )
    `);

    stmt.run(
      id,
      name,
      category,
      positioning,
      price,
      salesRecord,
      model343?.clays || '',
      model343?.extracts || '',
      model343?.surfactants || '',
      sgsData?.oil8h || '',
      sgsData?.oil14d || '',
      sgsData?.blackhead14d || '',
      JSON.stringify(prohibitedWords),
      targetAudience,
      customSellingPoints,
      coverImage
    );

    return res.json({ success: true, id, message: '产品成功添加至知识库！' });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/products/:id — 更新产品
productsRouter.put('/:id', (req, res) => {
  try {
    const { id } = req.params;

    // Fetch existing product first
    const selectStmt = db.prepare('SELECT * FROM products WHERE id = ?');
    const existing = selectStmt.get(id) as any;
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Product not found' });
    }

    const body = req.body || {};
    const name = body.name ?? existing.name;
    const category = body.category ?? existing.category;
    const positioning = body.positioning ?? existing.positioning;
    const price = body.price ?? existing.price;
    const salesRecord = body.salesRecord ?? existing.sales_record;
    const coverImage = body.coverImage ?? existing.cover_image;

    const clays = body.model343?.clays ?? existing.model343_clays;
    const extracts = body.model343?.extracts ?? existing.model343_extracts;
    const surfactants = body.model343?.surfactants ?? existing.model343_surfactants;

    const oil8h = body.sgsData?.oil8h ?? existing.sgs_oil_8h;
    const oil14d = body.sgsData?.oil14d ?? existing.sgs_oil_14d;
    const blackhead14d = body.sgsData?.blackhead14d ?? existing.sgs_blackhead_14d;

    const prohibitedWords = body.prohibitedWords
      ? JSON.stringify(body.prohibitedWords)
      : existing.prohibited_words;
    const targetAudience = body.targetAudience ?? existing.target_audience;
    const customSellingPoints = body.customSellingPoints ?? existing.custom_selling_points;

    const stmt = db.prepare(`
      UPDATE products
      SET name = ?,
          category = ?,
          positioning = ?,
          price = ?,
          sales_record = ?,
          cover_image = ?,
          model343_clays = ?,
          model343_extracts = ?,
          model343_surfactants = ?,
          sgs_oil_8h = ?,
          sgs_oil_14d = ?,
          sgs_blackhead_14d = ?,
          prohibited_words = ?,
          target_audience = ?,
          custom_selling_points = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    stmt.run(
      name,
      category,
      positioning,
      price,
      salesRecord,
      coverImage,
      clays,
      extracts,
      surfactants,
      oil8h,
      oil14d,
      blackhead14d,
      prohibitedWords,
      targetAudience,
      customSellingPoints,
      id
    );

    return res.json({ success: true, message: '产品知识库信息已成功更新！' });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/products/:id — 删除产品
productsRouter.delete('/:id', (req, res) => {
  try {
    const stmt = db.prepare('DELETE FROM products WHERE id = ?');
    stmt.run(req.params.id);
    return res.json({ success: true, message: '产品记录已成功删除' });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});
