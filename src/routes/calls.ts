import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/http';
import { requireAuth } from '../middleware/auth';
import { mintUserToken, streamCallType } from '../services/stream';

const router = Router();
router.use(requireAuth);

/**
 * POST /calls/token — mint a Stream Video token for a visit room.
 * Returns the CallTokenGrant fields the app already expects, plus `apiKey`
 * and `callType` so the Stream SDK can be initialised straight from the grant.
 */
router.post(
  '/token',
  asyncHandler(async (req, res) => {
    const { roomName } = z.object({ roomName: z.string().min(1) }).parse(req.body);
    const grant = mintUserToken(req.user!.id);
    res.json({
      token: grant.token,
      roomName,
      identity: grant.identity,
      expiresAt: grant.expiresAt,
      apiKey: grant.apiKey,
      callType: streamCallType,
    });
  }),
);

export default router;
