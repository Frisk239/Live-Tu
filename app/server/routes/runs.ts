import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { db } from '../lib/db';
import { PipelineOrchestrator } from '../lib/pipeline-orchestrator';

export const runsRouter = Router();
let orchestrator: PipelineOrchestrator | null = null;

export function initializePipelineRuns(baseUrl: string) {
  orchestrator = new PipelineOrchestrator(baseUrl);
  orchestrator.recover();
}

function currentOrchestrator(): PipelineOrchestrator {
  if (!orchestrator) {
    throw Object.assign(new Error('后台任务执行器尚未就绪'), { status: 503 });
  }
  return orchestrator;
}

runsRouter.get('/', (req, res) => {
  const rows = req.authUser?.role === 'admin'
    ? db.prepare('SELECT id FROM pipeline_runs ORDER BY created_at DESC LIMIT 100').all() as Array<{ id: string }>
    : db.prepare(
        'SELECT id FROM pipeline_runs WHERE owner_id = ? ORDER BY created_at DESC LIMIT 100'
      ).all(req.authUser!.id) as Array<{ id: string }>;
  const data = rows.map((row) =>
    currentOrchestrator().get(row.id, req.authUser!.id, req.authUser?.role === 'admin')
  );
  return res.json({ success: true, data });
});

runsRouter.post('/', (req, res) => {
  try {
    const idempotencyKey = String(
      req.headers['idempotency-key'] || req.body?.idempotencyKey || randomUUID()
    );
    const run = currentOrchestrator().start({
      ownerId: req.authUser!.id,
      idempotencyKey,
      productId: req.body?.productId,
      productInfo: req.body?.productInfo,
      pipelineData: req.body?.pipelineData,
    });
    return res.status(202).json({ success: true, data: run });
  } catch (error: any) {
    return res.status(error.status || 400).json({ success: false, error: error.message });
  }
});

runsRouter.get('/:id', (req, res) => {
  try {
    const run = currentOrchestrator().get(
      req.params.id,
      req.authUser!.id,
      req.authUser?.role === 'admin'
    );
    return res.json({ success: true, data: run });
  } catch (error: any) {
    return res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

runsRouter.post('/:id/cancel', (req, res) => {
  try {
    const run = currentOrchestrator().cancel(
      req.params.id,
      req.authUser!.id,
      req.authUser?.role === 'admin'
    );
    return res.json({ success: true, data: run });
  } catch (error: any) {
    return res.status(error.status || 500).json({ success: false, error: error.message });
  }
});

runsRouter.post('/:id/retry', (req, res) => {
  try {
    const run = currentOrchestrator().retryStep(
      req.params.id,
      req.authUser!.id,
      Number(req.body?.step),
      req.authUser?.role === 'admin'
    );
    return res.status(202).json({ success: true, data: run });
  } catch (error: any) {
    return res.status(error.status || 500).json({ success: false, error: error.message });
  }
});
