import { Router } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { db } from '../lib/db';
import { requirePermission } from '../lib/auth';
import { callLlmGateway } from '../lib/llm-gateway';
import {
  deleteProductAsset,
  insertProductAsset,
  listProductAssets,
} from '../lib/product-assets';
import { registerOwnedMedia } from '../lib/media-ownership';
import { markStaleArtifactsExceptProduct } from '../lib/publish-context';

export const productsRouter = Router();

const uploadsRoot = path.resolve(process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads'));
const productAssetsDir = path.join(uploadsRoot, 'product-assets');
if (!fs.existsSync(productAssetsDir)) {
  fs.mkdirSync(productAssetsDir, { recursive: true });
}

const imageMime = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);

const productAssetUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, productAssetsDir),
    filename: (_req, file, cb) => {
      const ext = imageMime.get(file.mimetype) || 'jpg';
      cb(null, `pa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`);
    },
  }),
  limits: { files: 1, fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!imageMime.has(file.mimetype)) {
      return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'file'));
    }
    cb(null, true);
  },
});

function mapProductRow(r: any, assets?: ReturnType<typeof listProductAssets>) {
  return {
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
    assets: assets ?? listProductAssets(r.id),
  };
}

// GET /api/products — 获取所有产品列表
productsRouter.get('/', requirePermission('module.knowledge.read'), (req, res) => {
  try {
    const stmt = db.prepare('SELECT * FROM products ORDER BY updated_at DESC');
    const rows = stmt.all() as any[];
    const products = rows.map((r) => mapProductRow(r));
    return res.json({ success: true, data: products });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/products/:id/assets — list product visual assets
productsRouter.get('/:id/assets', requirePermission('module.knowledge.read'), (req, res) => {
  try {
    const product = db.prepare('SELECT id FROM products WHERE id = ?').get(req.params.id);
    if (!product) return res.status(404).json({ success: false, error: 'Product not found' });
    const assets = listProductAssets(req.params.id);
    return res.json({ success: true, data: assets });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/products/:id/assets — attach product image (JSON url or multipart file)
productsRouter.post(
  '/:id/assets',
  requirePermission('module.knowledge.write'),
  (req, res, next) => {
    const contentType = String(req.headers['content-type'] || '');
    if (contentType.includes('multipart/form-data')) {
      return productAssetUpload.single('file')(req, res, next);
    }
    return next();
  },
  async (req, res) => {
    try {
      const productId = req.params.id;
      const product = db.prepare('SELECT id FROM products WHERE id = ?').get(productId);
      if (!product) return res.status(404).json({ success: false, error: 'Product not found' });

      const role = String(req.body?.role || 'hero');
      const sortOrder = Number(req.body?.sortOrder ?? 0);
      let url = String(req.body?.url || '').trim();
      let filePath: string | undefined;

      const file = (req as any).file as { filename?: string } | undefined;
      if (file?.filename) {
        filePath = path.join('uploads', 'product-assets', file.filename).replace(/\\/g, '/');
        url = `/uploads/product-assets/${file.filename}`;
      }

      if (!url) {
        return res.status(400).json({
          success: false,
          error: '产品图 url 或 file 必填',
        });
      }

      const id =
        req.body?.id ||
        `pa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      insertProductAsset({
        id,
        productId,
        role,
        url,
        filePath: filePath || url.replace(/^\//, ''),
        sortOrder,
        ownerId: req.authUser?.id || null,
      });

      if (req.authUser?.id && url.startsWith('/uploads/')) {
        registerOwnedMedia(url, req.authUser.id, 'product_asset');
      }

      // Upload is not usable by any provider until this awaited, hash-bound safety
      // assessment has been recorded. A remote JSON URL has no local digest and is
      // deliberately left unverified instead of inheriting a stale verdict.
      if (req.authUser?.id) {
        const ownerId = req.authUser.id;
        try {
          const { evaluateVisualSafety, recordVisualSafety, sha256OfLocalFile } = await import('../lib/visual-safety');
          // hash 绑定：multipart 上传直接取产物路径；JSON url 若是本系统 /uploads
          // 素材（如 materials 上传的图片），从本地字节解析——否则远程裸 URL 无
          // 本地摘要，按 unverified 拒绝（不继承过期判决）。路径穿越守卫：
          // 解析结果必须仍在 uploadsRoot 内，否则视为不可哈希。
          const uploadsRoot = path.resolve(process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads'));
          let localPath: string | null = file?.filename
            ? path.join(productAssetsDir, file.filename)
            : null;
          if (!localPath && url.startsWith('/uploads/')) {
            const resolved = path.resolve(uploadsRoot, url.slice('/uploads/'.length));
            if (resolved.startsWith(`${uploadsRoot}${path.sep}`)) localPath = resolved;
          }
          const assessment = await evaluateVisualSafety(url, { sha256: sha256OfLocalFile(localPath) });
          recordVisualSafety(ownerId, url, assessment);
        } catch (e: any) {
          // The inserted row remains at its migration default (unverified), which
          // blocks image/video providers. Do not return a successful safety result.
          console.warn('[visual-safety] evaluation could not be recorded:', e?.message || e);
        }
      }

      // Optionally set cover if empty
      const row = db.prepare('SELECT cover_image FROM products WHERE id = ?').get(productId) as
        | { cover_image?: string }
        | undefined;
      if (row && !row.cover_image) {
        db.prepare('UPDATE products SET cover_image = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
          url,
          productId
        );
      }

      const assets = listProductAssets(productId);
      const created = assets.find((a) => a.id === id) || { id, url, role, sortOrder };
      return res.status(201).json({ success: true, data: created, assets });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }
);

// DELETE /api/products/:id/assets/:assetId
productsRouter.delete(
  '/:id/assets/:assetId',
  requirePermission('module.knowledge.write'),
  (req, res) => {
    try {
      const ok = deleteProductAsset(req.params.assetId, req.params.id);
      if (!ok) return res.status(404).json({ success: false, error: 'Asset not found' });
      return res.json({
        success: true,
        data: listProductAssets(req.params.id),
      });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }
);

// GET /api/products/:id — 获取单个产品
productsRouter.get('/:id', requirePermission('module.knowledge.read'), (req, res) => {
  try {
    const stmt = db.prepare('SELECT * FROM products WHERE id = ?');
    const r = stmt.get(req.params.id) as any;
    if (!r) return res.status(404).json({ success: false, error: 'Product not found' });

    const product = mapProductRow(r);
    return res.json({ success: true, data: product });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/products — 新增产品
productsRouter.post('/', requirePermission('module.knowledge.write'), (req, res) => {
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
productsRouter.put('/:id', requirePermission('module.knowledge.write'), (req, res) => {
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
          updated_at = CURRENT_TIMESTAMP,
          revision = revision + 1
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
productsRouter.delete('/:id', requirePermission('module.knowledge.write'), (req, res) => {
  try {
    const stmt = db.prepare('DELETE FROM products WHERE id = ?');
    stmt.run(req.params.id);
    return res.json({ success: true, message: '产品记录已成功删除' });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/products/:id/context-switch — 切换工作台产品上下文（S0 产品污染修复）
// 工作台切换到新绑定产品时调用：旧产品 Run 的下游产物全部标记 stale，
// 之后任何发布/合成路径引用 stale 产物都会被 publish-context 守卫阻断（409）。
productsRouter.post(
  '/:id/context-switch',
  requirePermission('module.knowledge.write'),
  (req, res) => {
    try {
      const productId = req.params.id;
      const product = db.prepare('SELECT id FROM products WHERE id = ?').get(productId);
      if (!product) {
        return res.status(404).json({ success: false, error: '产品不存在' });
      }
      const { staleCount } = markStaleArtifactsExceptProduct(
        productId,
        (req as any).authUser?.id || 'system'
      );
      // 审计：记录上下文切换（谁、切到哪个产品、作废了多少旧产物）
      try {
        db.prepare(
          `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, metadata_json)
           VALUES (?, ?, 'product_context_switch', 'product', ?, ?)`
        ).run(
          randomUUID(),
          (req as any).authUser?.id || null,
          productId,
          JSON.stringify({ staleCount })
        );
      } catch (auditErr: any) {
        console.warn('[products] context-switch audit skipped:', auditErr.message);
      }
      return res.json({
        success: true,
        productId,
        staleCount,
        message:
          staleCount > 0
            ? `已切换到「${productId}」，${staleCount} 个旧产品产物已标记过期，重新生成后可发布`
            : `已切换到「${productId}」`,
      });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }
);

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

productsRouter.post('/optimize', requirePermission('module.knowledge.write'), handleSellingPointsOptimize);
