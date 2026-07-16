/**
 * Stream (getstream.io) — powers BOTH video/audio calls (Stream Video) and
 * secure messaging (Stream Chat). A single user token works for both products
 * under one app, so /calls/token and /chat/token share this minting logic.
 *
 * We use the `stream-chat` server client (instantiated with the API secret):
 * it mints user tokens, manages channels + membership server-side, and verifies
 * webhook signatures — so the backend owns chat channels and message history
 * (the pitch's universal EMR + moderation both require server-owned transcripts).
 */
import { StreamChat, type UserResponse } from 'stream-chat';
import { configured, env } from '../config/env';
import { ServiceNotConfiguredError } from '../lib/errors';

let client: StreamChat | null = null;

function getServerClient(): StreamChat {
  if (!configured.stream()) {
    throw new ServiceNotConfiguredError('Stream (set STREAM_API_KEY and STREAM_API_SECRET)');
  }
  if (!client) {
    client = StreamChat.getInstance(env.stream.apiKey, env.stream.apiSecret);
  }
  return client;
}

export interface StreamGrant {
  token: string;
  apiKey: string;
  identity: string;
  expiresAt: string;
}

/**
 * Mint a Stream user token for the signed-in user. `identity` is the user id;
 * the app uses it as the Stream user id when connecting to a call or channel.
 */
export function mintUserToken(userId: string): StreamGrant {
  const c = getServerClient();
  const expSeconds = Math.floor(Date.now() / 1000) + env.stream.tokenTtl;
  const token = c.createToken(userId, expSeconds);
  return {
    token,
    apiKey: env.stream.apiKey,
    identity: userId,
    expiresAt: new Date(expSeconds * 1000).toISOString(),
  };
}

/** Stream Video call type used for visit rooms (call id = visit/room name). */
export const streamCallType = env.stream.callType;

export interface ChannelMember {
  id: string;
  name?: string;
}

/**
 * Idempotently create a `messaging` channel we own, with both participants as
 * members. `channelId` is our conversation id, so the mobile app watches the
 * same channel and the webhook can map messages back to the conversation.
 */
export async function ensureChannel(
  channelId: string,
  members: ChannelMember[],
  createdById: string,
): Promise<void> {
  const c = getServerClient();
  // Users must exist in Stream before they can be channel members.
  await c.upsertUsers(members.map((m) => ({ id: m.id, name: m.name })) as UserResponse[]);
  const channel = c.channel('messaging', channelId, {
    members: members.map((m) => m.id),
    created_by_id: createdById,
  });
  await channel.create();
}

/** Verify a Stream webhook signature (`X-Signature` header) against the secret. */
export function verifyStreamWebhook(rawBody: string | Buffer, signature: string): boolean {
  return getServerClient().verifyWebhook(rawBody, signature);
}
