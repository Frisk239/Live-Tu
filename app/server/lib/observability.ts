import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { requireAuth, requireRole } from './auth';

type Metric = { count: number; totalDurationMs: number; errors: number };
const metrics = new Map<string, Metric>();
const MAX_METRIC_SERIES = 500;
let activeRequests = 0;

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

function routeLabel(originalUrl: string): string {
  return originalUrl
    .split('?', 1)[0]
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ':id')
    .replace(/\/\d+(?=\/|$)/g, '/:id');
}

export function observeRequests(req: Request, res: Response, next: NextFunction) {
  const startedAt = performance.now();
  const requestId = String(req.headers['x-request-id'] || randomUUID()).slice(0, 128);
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  activeRequests += 1;

  res.on('finish', () => {
    activeRequests = Math.max(0, activeRequests - 1);
    const durationMs = Math.max(0, performance.now() - startedAt);
    const route = routeLabel(req.originalUrl);
    const requestedKey = `${req.method} ${route}`;
    const key =
      metrics.has(requestedKey) || metrics.size < MAX_METRIC_SERIES
        ? requestedKey
        : `${req.method} /:other`;
    const current = metrics.get(key) || { count: 0, totalDurationMs: 0, errors: 0 };
    current.count += 1;
    current.totalDurationMs += durationMs;
    if (res.statusCode >= 500) current.errors += 1;
    metrics.set(key, current);

    console.log(JSON.stringify({
      level: res.statusCode >= 500 ? 'error' : 'info',
      event: 'http_request',
      requestId,
      method: req.method,
      route,
      status: res.statusCode,
      durationMs: Math.round(durationMs),
      userId: req.authUser?.id || null,
    }));
  });
  next();
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requireMetricsAccess(req: Request, res: Response, next: NextFunction) {
  const configuredToken = process.env.METRICS_TOKEN || '';
  const providedToken = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (configuredToken && providedToken && safeEqual(providedToken, configuredToken)) return next();
  return requireAuth(req, res, () => requireRole('admin')(req, res, next));
}

export const metricsRouter = Router();
metricsRouter.get('/', requireMetricsAccess, (_req, res) => {
  const lines = [
    '# HELP live_tu_active_requests Current in-flight HTTP requests.',
    '# TYPE live_tu_active_requests gauge',
    `live_tu_active_requests ${activeRequests}`,
    '# HELP live_tu_process_uptime_seconds Process uptime.',
    '# TYPE live_tu_process_uptime_seconds gauge',
    `live_tu_process_uptime_seconds ${process.uptime().toFixed(3)}`,
    '# HELP live_tu_process_resident_memory_bytes Resident memory.',
    '# TYPE live_tu_process_resident_memory_bytes gauge',
    `live_tu_process_resident_memory_bytes ${process.memoryUsage().rss}`,
    '# HELP live_tu_http_requests_total HTTP requests by method and route.',
    '# TYPE live_tu_http_requests_total counter',
  ];

  for (const [key, metric] of [...metrics.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const separator = key.indexOf(' ');
    const method = key.slice(0, separator);
    const route = key.slice(separator + 1).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    const labels = `method="${method}",route="${route}"`;
    lines.push(
      `live_tu_http_requests_total{${labels}} ${metric.count}`,
      `live_tu_http_request_errors_total{${labels}} ${metric.errors}`,
      `live_tu_http_request_duration_ms_sum{${labels}} ${metric.totalDurationMs.toFixed(3)}`
    );
  }
  res.type('text/plain; version=0.0.4').send(`${lines.join('\n')}\n`);
});
