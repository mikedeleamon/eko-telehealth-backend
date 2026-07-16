import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { HttpError } from '../lib/errors';

/**
 * Terminal error handler. Every response carries a `message` field because the
 * mobile client reads it off non-2xx bodies (eko_telehealth/src/api/client.ts).
 */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    res.status(400).json({ message: 'Validation failed', details: err.flatten() });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ message: err.message, details: err.details });
    return;
  }
  console.error('[unhandled error]', err);
  const message = err instanceof Error ? err.message : 'Internal server error';
  res.status(500).json({ message });
}
