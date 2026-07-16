import { getDb } from '../db/client';
import { notifications } from '../db/schema';

/**
 * Insert an in-app notification for a user (GET /notifications feeds on these).
 *
 * Fire-and-forget by design: a notification is a side effect of booking,
 * cancelling, paying, or messaging — it must never fail or slow the action
 * that triggered it, so errors are logged and swallowed.
 */
export async function notify(userId: string, title: string, body: string): Promise<void> {
  try {
    await getDb().insert(notifications).values({ userId, title, body });
  } catch (err) {
    console.error('[notify] failed:', err instanceof Error ? err.message : err);
  }
}
