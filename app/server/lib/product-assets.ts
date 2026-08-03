/**
 * Product visual asset helpers (DB access).
 */
import { db } from './db';
import type { ProductAssetRef } from './migration-plan';
import { mapDbRowsToProductAssets } from './migration-plan';

export function listProductAssets(productId: string): ProductAssetRef[] {
  if (!productId) return [];
  try {
    const rows = db
      .prepare(
        `SELECT id, url, role, sort_order
           FROM product_assets
          WHERE product_id = ?
          ORDER BY sort_order ASC, created_at ASC`
      )
      .all(productId) as Array<{
      id: string;
      url: string;
      role?: string;
      sort_order?: number;
    }>;
    return mapDbRowsToProductAssets(rows);
  } catch {
    return [];
  }
}

export function listProductAssetsByIds(ids: string[]): ProductAssetRef[] {
  if (!ids?.length) return [];
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return [];
  try {
    const placeholders = unique.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT id, url, role, sort_order
           FROM product_assets
          WHERE id IN (${placeholders})
          ORDER BY sort_order ASC, created_at ASC`
      )
      .all(...unique) as Array<{
      id: string;
      url: string;
      role?: string;
      sort_order?: number;
    }>;
    return mapDbRowsToProductAssets(rows);
  } catch {
    return [];
  }
}

/**
 * Resolve assets for a viral-direct-out run:
 * prefer explicit productAssetIds, else all assets for productId.
 * Falls back to products.cover_image as a synthetic hero asset.
 */
export function resolveRunProductAssets(input: {
  productId?: string;
  productAssetIds?: string[];
}): ProductAssetRef[] {
  const ids = Array.isArray(input.productAssetIds)
    ? input.productAssetIds.filter(Boolean)
    : [];
  if (ids.length > 0) {
    const byId = listProductAssetsByIds(ids);
    if (byId.length > 0) return byId;
  }
  if (input.productId) {
    const listed = listProductAssets(input.productId);
    if (listed.length > 0) return listed;
    try {
      const row = db
        .prepare('SELECT id, cover_image FROM products WHERE id = ?')
        .get(input.productId) as { id: string; cover_image?: string } | undefined;
      if (row?.cover_image) {
        return [
          {
            id: `cover_${row.id}`,
            url: row.cover_image,
            role: 'hero',
            sortOrder: 0,
          },
        ];
      }
    } catch {
      /* ignore */
    }
  }
  return [];
}

export function insertProductAsset(params: {
  id: string;
  productId: string;
  role: string;
  url: string;
  filePath?: string;
  sortOrder?: number;
  ownerId?: string | null;
}): void {
  db.prepare(
    `INSERT INTO product_assets (
      id, product_id, role, url, file_path, sort_order, owner_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    params.id,
    params.productId,
    params.role || 'hero',
    params.url,
    params.filePath || params.url.replace(/^\//, ''),
    params.sortOrder ?? 0,
    params.ownerId ?? null
  );
}

export function deleteProductAsset(assetId: string, productId?: string): boolean {
  if (productId) {
    const r = db
      .prepare('DELETE FROM product_assets WHERE id = ? AND product_id = ?')
      .run(assetId, productId);
    return Number(r.changes || 0) > 0;
  }
  const r = db.prepare('DELETE FROM product_assets WHERE id = ?').run(assetId);
  return Number(r.changes || 0) > 0;
}
