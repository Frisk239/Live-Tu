/**
 * Side-effect entry: load .env before any other app modules.
 * Use: node --import ./load-env.ts  or  tsx --import ./load-env.ts server.ts
 * Also imported first from server.ts for tsx/dev convenience.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
  path.join(here, '.env'),
  path.join(process.cwd(), '.env'),
  path.join(process.cwd(), 'app', '.env'),
];

for (const p of candidates) {
  const r = dotenv.config({ path: p });
  if (!r.error) break;
}
