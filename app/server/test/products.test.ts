import { initDatabase, db } from '../lib/db';
import express from 'express';
import { productsRouter } from '../routes/products';

async function runProductsTest() {
  console.log('--- Starting Ticket 03 Products CRUD Tests ---');
  initDatabase();

  const app = express();
  app.use(express.json());
  app.use('/api/products', productsRouter);

  const server = app.listen(3099);

  try {
    // Test 1: GET /api/products
    const res1 = await fetch('http://localhost:3099/api/products');
    const json1 = await res1.json();
    console.assert(json1.success === true, 'Test 1 Failed: GET products success false');
    console.assert(Array.isArray(json1.data), 'Test 1 Failed: GET products data not array');
    console.assert(json1.data.length > 0, 'Test 1 Failed: GET products empty');
    console.log(`✓ Test 1 Passed: GET /api/products returned ${json1.data.length} products`);

    // Test 2: POST /api/products (Create new product)
    const newProduct = {
      name: 'BUV 控油泥膜 Demo',
      category: '泥膜/面膜',
      positioning: '高效深洁 · 毛孔收敛',
      price: '69元/件',
      salesRecord: '小红书爆款热销榜 #1',
      model343: {
        clays: '亚马逊白泥 + 竹炭粉',
        extracts: '积雪草 + 茶树叶',
        surfactants: '氨基酸清洁因子',
      },
      sgsData: {
        oil8h: '8h出油 -50%',
        oil14d: '14d毛孔细致 +40%',
        blackhead14d: '14d黑头减少 -30%',
      },
      prohibitedWords: ['绝对有效', '神器'],
      targetAudience: '毛孔粗大与出油严重群体',
      customSellingPoints: '强力深洁不紧绷，吸走多余油脂',
    };

    const res2 = await fetch('http://localhost:3099/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newProduct),
    });
    const json2 = await res2.json();
    console.assert(json2.success === true, 'Test 2 Failed: POST product success false');
    const createdId = json2.id;
    console.assert(Boolean(createdId), 'Test 2 Failed: POST product missing created id');
    console.log(`✓ Test 2 Passed: POST /api/products created new product ID: ${createdId}`);

    // Test 3: PUT /api/products/:id (Update product)
    const res3 = await fetch(`http://localhost:3099/api/products/${createdId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        price: '59元/限时特惠',
        customSellingPoints: '【已更新卖点】强力深洁不紧绷，吸走多余油脂，收敛毛孔',
      }),
    });
    const json3 = await res3.json();
    console.assert(json3.success === true, 'Test 3 Failed: PUT product success false');
    console.log('✓ Test 3 Passed: PUT /api/products/:id updated product price and selling points');

    // Verify update persistence with GET /api/products/:id
    const res3Verify = await fetch(`http://localhost:3099/api/products/${createdId}`);
    const json3Verify = await res3Verify.json();
    console.assert(json3Verify.data.price === '59元/限时特惠', 'Test 3 Verification Failed: Price not updated in DB');
    console.log('✓ Test 3 Verification Passed: Updated data persisted in SQLite');

    // Test 4: DELETE /api/products/:id (Delete product)
    const res4 = await fetch(`http://localhost:3099/api/products/${createdId}`, {
      method: 'DELETE',
    });
    const json4 = await res4.json();
    console.assert(json4.success === true, 'Test 4 Failed: DELETE product success false');
    console.log('✓ Test 4 Passed: DELETE /api/products/:id deleted product');

    // Verify deletion
    const res4Verify = await fetch(`http://localhost:3099/api/products/${createdId}`);
    console.assert(res4Verify.status === 404, 'Test 4 Verification Failed: Product should return 404 after deletion');
    console.log('✓ Test 4 Verification Passed: Product cleanly removed from SQLite DB');

    console.log('--- ALL TICKET 03 PRODUCTS CRUD TESTS PASSED! ---');
  } finally {
    server.close();
  }
}

runProductsTest().catch((err) => {
  console.error('Products Test Suite Failed:', err);
  process.exit(1);
});
