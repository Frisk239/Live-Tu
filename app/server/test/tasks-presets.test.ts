import { initDatabase } from '../lib/db';
import express from 'express';
import { tasksRouter } from '../routes/tasks';
import { presetsRouter } from '../routes/presets';
import { authStub } from './_helpers';

async function runTasksPresetsTest() {
  console.log('--- Starting Ticket 10 Tasks History & Presets SQLite Persistence Tests ---');
  initDatabase();

  const app = express();
  app.use(express.json());
  // 路由依赖 req.authUser（权限/归属过滤），测试以管理员身份挂载
  app.use(authStub);
  app.use('/api/tasks', tasksRouter);
  app.use('/api/presets', presetsRouter);

  const server = app.listen(3094);

  try {
    // Test 1: GET /api/tasks (List tasks)
    const resTasks = await fetch('http://localhost:3094/api/tasks');
    const jsonTasks = await resTasks.json();
    if (!(jsonTasks.success === true)) throw new Error('Test 1 Failed: GET /api/tasks success false');
    if (!(Array.isArray(jsonTasks.data) && jsonTasks.data.length >= 2)) throw new Error('Test 1 Failed: Seed tasks missing');
    console.log(`✓ Test 1 Passed: Retrieved ${jsonTasks.data.length} task history items from SQLite`);

    // Test 2: POST /api/tasks (Create/Save task snapshot)
    const newTaskId = `task_test_${Date.now()}`;
    const resSaveTask = await fetch('http://localhost:3094/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: newTaskId,
        title: '小绿泥测试任务',
        status: 'completed',
        currentStep: 5,
        pipelineData: { test: true },
        thumbnailUrl: 'https://images.unsplash.com/photo-1556228720-195a672e8a03',
      }),
    });

    const jsonSaveTask = await resSaveTask.json();
    if (!(jsonSaveTask.success === true)) throw new Error('Test 2 Failed: Save task failed');
    console.log(`✓ Test 2 Passed: Created new task ID "${jsonSaveTask.data.id}" ("${jsonSaveTask.data.title}")`);

    // Test 3: DELETE /api/tasks/:id
    const resDelTask = await fetch(`http://localhost:3094/api/tasks/${newTaskId}`, { method: 'DELETE' });
    const jsonDelTask = await resDelTask.json();
    if (!(jsonDelTask.success === true)) throw new Error('Test 3 Failed: Delete task failed');
    console.log(`✓ Test 3 Passed: Deleted test task ID ${newTaskId}`);

    // Test 4: GET /api/presets (List presets)
    const resPresets = await fetch('http://localhost:3094/api/presets');
    const jsonPresets = await resPresets.json();
    if (!(jsonPresets.success === true)) throw new Error('Test 4 Failed: GET /api/presets success false');
    if (!(Array.isArray(jsonPresets.data) && jsonPresets.data.length >= 3)) throw new Error('Test 4 Failed: Seed presets missing');
    console.log(`✓ Test 4 Passed: Retrieved ${jsonPresets.data.length} preset templates from SQLite`);

    // Test 5: POST /api/presets (Create preset template)
    const resSavePreset = await fetch('http://localhost:3094/api/presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '测试美妆通用模版',
        tag: '测试模版',
        description: '用于自动卡点与文案生成测试',
        pipelineData: { presetTest: true },
      }),
    });

    const jsonSavePreset = await resSavePreset.json();
    if (!(jsonSavePreset.success === true)) throw new Error('Test 5 Failed: Save preset failed');
    const newPresetId = jsonSavePreset.data.id;
    console.log(`✓ Test 5 Passed: Created preset ID "${newPresetId}" ("${jsonSavePreset.data.title}")`);

    // Test 6: DELETE /api/presets/:id
    const resDelPreset = await fetch(`http://localhost:3094/api/presets/${newPresetId}`, { method: 'DELETE' });
    const jsonDelPreset = await resDelPreset.json();
    if (!(jsonDelPreset.success === true)) throw new Error('Test 6 Failed: Delete preset failed');
    console.log(`✓ Test 6 Passed: Deleted test preset ID ${newPresetId}`);

    console.log('--- ALL TICKET 10 TASKS & PRESETS TESTS PASSED! ---');
  } finally {
    server.close();
  }
}

runTasksPresetsTest().catch((err) => {
  console.error('Tasks & Presets Test Suite Failed:', err);
  process.exit(1);
});
