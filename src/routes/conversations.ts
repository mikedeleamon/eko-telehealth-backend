import { Router } from 'express';
import { and, asc, desc, eq, or } from 'drizzle-orm';
import { z } from 'zod';
import { configured } from '../config/env';
import { getDb } from '../db/client';
import { conversations, doctors, messages, users } from '../db/schema';
import { HttpError } from '../lib/errors';
import { asyncHandler, param } from '../lib/http';
import { formatClockTime, formatConversationTime } from '../lib/format';
import { requireAuth } from '../middleware/auth';
import { ensureChannel } from '../services/stream';

const router = Router();
router.use(requireAuth);

/**
 * POST /conversations — start (or return) a thread with a doctor and create the
 * backing Stream channel with both members. The mobile app calls this before
 * opening chat; the returned `id` is also the Stream channel id, so the app
 * watches the same channel the backend owns.
 */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { doctorId } = z.object({ doctorId: z.string().uuid() }).parse(req.body);
    const db = getDb();

    const [doctor] = await db.select().from(doctors).where(eq(doctors.id, doctorId));
    if (!doctor) throw new HttpError(404, 'Doctor not found');

    let [conversation] = await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.patientId, req.user!.id), eq(conversations.doctorId, doctorId)));

    if (!conversation) {
      [conversation] = await db
        .insert(conversations)
        .values({ patientId: req.user!.id, doctorId, lastMessage: '', unread: 0 })
        .returning();
    }

    // Best-effort channel creation — never fail the request if Stream hiccups.
    if (configured.stream()) {
      try {
        const [patient] = await db.select().from(users).where(eq(users.id, req.user!.id));
        const members = [
          { id: req.user!.id, name: patient ? `${patient.firstName} ${patient.lastName}` : undefined },
        ];
        if (doctor.userId) members.push({ id: doctor.userId, name: doctor.name });
        await ensureChannel(conversation!.id, members, req.user!.id);
      } catch (err) {
        console.error('[stream] ensureChannel failed:', err instanceof Error ? err.message : err);
      }
    }

    res.status(201).json({
      id: conversation!.id,
      doctorId: conversation!.doctorId,
      lastMessage: conversation!.lastMessage,
      time: formatConversationTime(conversation!.updatedAt),
      unread: conversation!.unread,
    });
  }),
);

/** GET /conversations — threads for the signed-in user (patient or doctor). */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const db = getDb();
    // A doctor sees threads tied to their doctor profile; a patient sees their own.
    const [doctorProfile] = await db.select().from(doctors).where(eq(doctors.userId, req.user!.id));
    const rows = await db
      .select()
      .from(conversations)
      .where(
        doctorProfile
          ? or(eq(conversations.patientId, req.user!.id), eq(conversations.doctorId, doctorProfile.id))
          : eq(conversations.patientId, req.user!.id),
      )
      .orderBy(desc(conversations.updatedAt));

    res.json(
      rows.map((c) => ({
        id: c.id,
        doctorId: c.doctorId,
        lastMessage: c.lastMessage,
        time: formatConversationTime(c.updatedAt),
        unread: c.unread,
      })),
    );
  }),
);

/** GET /conversations/:id/messages — thread history (stored server-side). */
router.get(
  '/:id/messages',
  asyncHandler(async (req, res) => {
    const db = getDb();
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, param(req, 'id')));
    if (!conv) throw new HttpError(404, 'Conversation not found');

    const rows = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conv.id))
      .orderBy(asc(messages.createdAt));

    res.json(
      rows.map((m) => ({
        id: m.id,
        conversationId: m.conversationId,
        text: m.text,
        fromMe: m.senderId === req.user!.id,
        time: formatClockTime(m.createdAt),
      })),
    );
  }),
);

export default router;
