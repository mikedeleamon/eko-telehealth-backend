import type { NextFunction, Request, Response } from 'express';
import { getDb } from '../db/client';
import { auditLog } from '../db/schema';

type AuditAction = 'read' | 'create' | 'update' | 'delete';
type AuditResourceType = 'document' | 'prescription' | 'lab' | 'medical_note';

const METHOD_ACTIONS: Record<string, AuditAction> = {
  GET: 'read',
  POST: 'create',
  PATCH: 'update',
  PUT: 'update',
  DELETE: 'delete',
};

/** Like lib/http.ts's param(), but undefined when absent rather than ''. */
function optionalParam(req: Request, name: string): string | undefined {
  const value = req.params[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Records who accessed a clinical record and when — attach directly on each
 * medical_notes/prescriptions/labs/documents route (after requireAuth), not
 * as a blanket prefix middleware, since /me and /practice both mix clinical
 * and non-clinical routes (pharmacy, settings, agenda, earnings, ...) that
 * shouldn't show up in an EMR audit trail.
 *
 * Logs on response finish so it captures the real status code, and never
 * throws into the request itself — a logging failure must not break the
 * actual read/write it's recording.
 */
export function auditAccess(resourceType: AuditResourceType) {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.on('finish', () => {
      const user = req.user;
      if (!user) return; // requireAuth runs before this on every route it's attached to
      const subjectId = optionalParam(req, 'patientId') ?? (user.accountType === 'Patient' ? user.id : undefined);
      const row: typeof auditLog.$inferInsert = {
        actorId: user.id,
        actorAccountType: user.accountType,
        action: METHOD_ACTIONS[req.method] ?? 'read',
        resourceType,
        resourceId: optionalParam(req, 'id') ?? optionalParam(req, 'noteId') ?? null,
        subjectId: subjectId ?? null,
        statusCode: res.statusCode,
      };
      getDb()
        .insert(auditLog)
        .values(row)
        .catch((err) => {
          console.error('audit log insert failed', err);
        });
    });
    next();
  };
}
