/**
 * Object storage on Cloudflare R2 (S3-compatible API). Used for provider
 * verification documents (gov ID) and profile photos. The backend never
 * receives the file bytes — it hands the client a short-lived presigned PUT
 * URL, and the client uploads straight to R2.
 */
import { randomUUID } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { configured, env } from '../config/env';
import { ServiceNotConfiguredError } from '../lib/errors';

let s3: S3Client | null = null;

function getClient(): S3Client {
  if (!configured.r2()) {
    throw new ServiceNotConfiguredError(
      'Cloudflare R2 (set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET)',
    );
  }
  if (!s3) {
    s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${env.r2.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: env.r2.accessKeyId,
        secretAccessKey: env.r2.secretAccessKey,
      },
    });
  }
  return s3;
}

export interface PresignResult {
  uploadUrl: string;
  key: string;
  publicUrl: string | null;
  expiresIn: number;
}

/** Presign a PUT for `<prefix>/<uuid>`; the client uploads the bytes directly. */
export async function presignUpload(prefix: string, contentType: string): Promise<PresignResult> {
  const client = getClient();
  const key = `${prefix}/${randomUUID()}`;
  const expiresIn = 600;
  const uploadUrl = await getSignedUrl(
    client,
    new PutObjectCommand({ Bucket: env.r2.bucket, Key: key, ContentType: contentType }),
    { expiresIn },
  );
  const publicUrl = env.r2.publicBaseUrl ? `${env.r2.publicBaseUrl.replace(/\/$/, '')}/${key}` : null;
  return { uploadUrl, key, publicUrl, expiresIn };
}
