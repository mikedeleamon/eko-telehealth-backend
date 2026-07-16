import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/http';
import { requireAuth } from '../middleware/auth';
import { presignUpload } from '../services/storage';

const router = Router();
router.use(requireAuth);

/**
 * POST /uploads/presign — get a short-lived R2 URL to PUT a file directly.
 * `kind` scopes the object: profile photos vs. provider verification documents.
 */
router.post(
  '/presign',
  asyncHandler(async (req, res) => {
    const { kind, contentType } = z
      .object({ kind: z.enum(['avatar', 'provider-doc']), contentType: z.string().min(1) })
      .parse(req.body);

    const prefix = kind === 'avatar' ? `avatars/${req.user!.id}` : `provider-docs/${req.user!.id}`;
    const result = await presignUpload(prefix, contentType);
    res.json(result);
  }),
);

export default router;
