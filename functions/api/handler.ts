// functions/api/handler.ts
import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { extractProps, getDesignBits } from '../../src/services/line-props.js';
import { verifyShopifyHmac } from '../../src/services/shopify.js';
import type { ShopifyOrder } from '../../src/types.js';
import { getClientBySlug } from '../../src/aws/dynamo.js';
import { getClientSecrets } from '../../src/aws/secrets.js';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

const sqs = new SQSClient({});
const QUEUE_URL = process.env.QUEUE_URL!; // set by template

function toSlug(s: string) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '');
}

function parseClientSlug(clientHook?: string | null) {
    
  if (!clientHook) return null;
  const m = String(clientHook).match(/^(.+?)[\-_]orders$/i);
  const slug = m ? m[1] : clientHook;
  return toSlug(slug);
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const clientHook = event.pathParameters?.clientHook || null;
    const slug = parseClientSlug(clientHook);
    if (!slug) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Invalid endpoint' }) };
    }

    const shopDomainHeader =
      (event.headers['x-shopify-shop-domain'] as string) ||
      (event.headers['X-Shopify-Shop-Domain'] as string) ||
      '';
    const hmacHeader =
      (event.headers['x-shopify-hmac-sha256'] as string) ||
      (event.headers['X-Shopify-Hmac-Sha256'] as string) ||
      '';

    // Body (supports Base64)
    const rawBody = Buffer.from(event.body || '', event.isBase64Encoded ? 'base64' : 'utf8');

    // Client + secrets
    const client = await getClientBySlug(slug);
    if (!client) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Unknown client' }) };
    }
    const secrets = await getClientSecrets(client.secretName);

    // Optional cross-check (don’t fail; HMAC is the real gate)
    if (shopDomainHeader && shopDomainHeader !== client.shopDomain) {
      console.warn('Shop domain mismatch', { expected: client.shopDomain, got: shopDomainHeader, slug });
    }

    // Verify HMAC
    const ok = verifyShopifyHmac({
      rawBody,
      hmacHeader: String(hmacHeader || ''),
      secret: secrets.shopifyWebhookKey,
    });
    if (!ok) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Invalid HMAC' }) };
    }

    // Parse order
    let order: ShopifyOrder;
    try {
      order = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }

    // Build candidates for ALL lines; worker decides type 2 vs type 5 vs skip
    const candidates = (order.line_items || []).map((li) => {
      const props = extractProps(li.properties);
      const bits = getDesignBits(props, {
        topKeysJson: client.topKeysJson,
        middleKeysJson: client.middleKeysJson,
        bottomKeysJson: client.bottomKeysJson,
      });
      return { li, bits };
    });

    // Even if no candidates, acknowledge to stop Shopify retries
    // (Worker will handle "zero personalised lines" properly anyway.)
    const msgBody = JSON.stringify({
      slug,
      shopDomain: client.shopDomain,
      secretName: client.secretName,
      order,
      candidates,
    });

    // Support both Standard and FIFO queues
    const isFifo = /\.(fifo)$/i.test(QUEUE_URL);
    const cmd = new SendMessageCommand(
      isFifo
        ? {
            QueueUrl: QUEUE_URL,
            MessageBody: msgBody,
            MessageGroupId: client.shopDomain,
            MessageDeduplicationId: `${client.shopDomain}#${order.id}`,
          }
        : {
            QueueUrl: QUEUE_URL,
            MessageBody: msgBody,
          }
    );

    await sqs.send(cmd);

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, enqueued: true, items: candidates.length }),
    };
  } catch (err: any) {
    console.error('API handler fatal error', { err: String(err?.stack || err) });
    // Return 200 to Shopify to avoid repeated webhook spam if our infra is misconfigured;
    // You can change to 500 if you prefer Shopify retry behavior for API-layer failures.
    return { statusCode: 200, body: JSON.stringify({ ok: false }) };
  }
};
