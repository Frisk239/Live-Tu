import { db } from './db';

export function registerSeedanceTaskOwner(
  providerTaskId: string,
  ownerId: string,
  source: string
): void {
  if (!providerTaskId || !ownerId) {
    throw new Error('Seedance task ownership requires providerTaskId and ownerId');
  }
  db.prepare(
    `INSERT OR IGNORE INTO seedance_task_ownership
       (provider_task_id, owner_id, source)
     VALUES (?, ?, ?)`
  ).run(providerTaskId, ownerId, source);
  const existing = db.prepare(
    `SELECT owner_id FROM seedance_task_ownership WHERE provider_task_id = ?`
  ).get(providerTaskId) as { owner_id: string } | undefined;
  if (!existing || existing.owner_id !== ownerId) {
    throw new Error('Seedance task is already registered to another owner');
  }
}

export function canAccessSeedanceTask(
  providerTaskId: string,
  ownerId: string,
  isAdmin: boolean
): boolean {
  const owners = db.prepare(
    `SELECT owner_id
       FROM seedance_task_ownership
      WHERE provider_task_id = ?
     UNION
     SELECT owner_id
       FROM shot_generation_tasks
      WHERE seedance_task_id = ? AND owner_id IS NOT NULL
     UNION
     SELECT pipeline_runs.owner_id
       FROM pipeline_steps
       JOIN pipeline_runs ON pipeline_runs.id = pipeline_steps.run_id
      WHERE pipeline_steps.provider_task_id = ?`
  ).all(providerTaskId, providerTaskId, `seedance:${providerTaskId}`) as Array<{
    owner_id: string;
  }>;
  return isAdmin ? owners.length > 0 : owners.some((row) => row.owner_id === ownerId);
}
