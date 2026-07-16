import { Router } from 'express';
import { asyncHandler } from '../lib/http';
import { requireAuth } from '../middleware/auth';
import { mintUserToken } from '../services/stream';

const router = Router();
router.use(requireAuth);

/**
 * POST /chat/token — mint a Stream Chat token for the signed-in user.
 * (This route was contracted in the integration guide but not yet in the
 * mobile client; add a matching api.chat.token() there during the Stream swap.)
 */
router.post(
  '/token',
  asyncHandler(async (req, res) => {
    const grant = mintUserToken(req.user!.id);
    res.json({
      token: grant.token,
      apiKey: grant.apiKey,
      identity: grant.identity,
      userId: grant.identity,
      expiresAt: grant.expiresAt,
    });
  }),
);

export default router;
