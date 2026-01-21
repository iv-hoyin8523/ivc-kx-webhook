import crypto from 'node:crypto';

export function verifyShopifyHmac({
  rawBody,
  hmacHeader,
  secret
}: {
  rawBody: Buffer;
  hmacHeader: string | undefined;
  secret: string;
}) {
  if (!hmacHeader) return false;
  const digest = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('base64');

  // constant-time compare
  const a = Buffer.from(digest);
  const b = Buffer.from(hmacHeader);
  return crypto.timingSafeEqual(a, b);
}