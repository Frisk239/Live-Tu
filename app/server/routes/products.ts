import { Router } from 'express';
import { db } from '../lib/db';
import { requireRole } from '../lib/auth';
import { callLlmGateway } from '../lib/llm-gateway';

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
productsRouter.post('/', requireRole('admin'), (req, res) => {
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
productsRouter.put('/:id', requireRole('admin'), (req, res) => {
  try {
    const { id } = req.params;

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
productsRouter.delete('/:id', requireRole('admin'), (req, res) => {
  try {
    const stmt = db.prepare('DELETE FROM products WHERE id = ?');
    stmt.run(req.params.id);
    return res.json({ success: true, message: '产品记录已成功删除' });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/products/optimize 或 /api/selling-points/optimize — AI 智能提炼/优化卖点
export async function handleSellingPointsOptimize(req: any, res: any) {
  const { product, rawText } = req.body;
  const inputSource = rawText || JSON.stringify(product || {});

  try {
    const result = await callLlmGateway({
      system: `你是一个资深美妆护肤产品专家与合规文案提炼师。
请分析用户提供的产品描述、SGS 检验报告或宣传文本，自动提炼出结构化的卖点档案。
必须返回合法 JSON 对象，包含以下字段：
- name: 产品名称
- positioning: 简短核心定位
- price: 价格或规格
- salesRecord: 销量认证或背书
- model343: { clays: "泥/核心成分", extracts: "植萃成分", surfactants: "清洁/复配表活" }
- sgsData: { oil8h: "8h控油数据", oil14d: "14d改善数据", blackhead14d: "黑头或指标数据" }
- prohibitedWords: ["违规词1", "违规词2"] (字符串数组)
- targetAudience: 目标受众描述
- customSellingPoints: 核心亮点总结`,
      user: `请提炼并优化以下产品文本，输出结构化卖点库 JSON：\n${inputSource}`,
    });

    if (result.success && result.data) {
      return res.json({ success: true, data: result.data, source: result.source, modelUsed: result.modelUsed });
    }
  } catch (err: any) {
    console.warn('Selling points AI optimization fallback:', err.message);
    if (process.env.NODE_ENV === 'production') {
      return res.status(502).json({
        success: false,
        error: '卖点优化服务暂时不可用，未生成任何推测性功效数据',
      });
    }
  }

  // Development-only fallback for local UI work. Production must never invent efficacy claims.
  return res.json({
    success: true,
    data: {
      name: product?.name || '默认产品 (AI 优化版)',
      positioning: product?.positioning || '油皮专研 · 深层净澈 · 温和控油',
      price: product?.price || '49元/件',
      salesRecord: product?.salesRecord || '爆款销量第一认证',
      model343: product?.model343 || {
        clays: '3重天然矿物泥 (白泥+火山泥+冰河泥)',
        extracts: '4重复配植萃 (积雪草+叶绿素)',
        surfactants: '氨基酸+甜菜碱温和表活',
      },
      sgsData: product?.sgsData || {
        oil8h: '8h 控油 -66.87%',
        oil14d: '14d 出油 -35.28%',
        blackhead14d: '14d 黑头 -35.92%',
      },
      prohibitedWords: product?.prohibitedWords || ['绝对第一', '100%根除', '神奇效果'],
      targetAudience: product?.targetAudience || '注重温和控油与清洁的年轻人',
      customSellingPoints: product?.customSellingPoints || '一润二修三控油，膏体清爽不紧绷',
    },
    source: 'mock',
  });
}

productsRouter.post('/optimize', handleSellingPointsOptimize);
