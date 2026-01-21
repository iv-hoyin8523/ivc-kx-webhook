// src/index.ts
import Fastify from 'fastify';
import rawBody from 'fastify-raw-body';
import env from '@fastify/env';
import { prisma } from './db.js';
import { verifyShopifyHmac } from './services/shopify.js';
import { extractProps, getDesignBits } from './services/line-props.js';
import { buildKxOrderPayload, postKornitXOrder } from './services/kornitx.js';
import { withRetry } from './services/retry.js';
import type { ShopifyOrder } from './types.js';

const envSchema = {
  type: 'object',
  required: ['PORT'],
  properties: {
    PORT: { type: 'string', default: '3001' },
    KX_BASE_URL: { type: 'string', default: 'https://api-sl-2-2.kornitx.net' },
  },
} as const;

function toSlug(s: string) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')     // normalize
    .replace(/-{2,}/g, '-')            // collapse --
    .replace(/^[-_]+|[-_]+$/g, '');    // trim -_
}

function parseClientSlug(clientHook: string | undefined) {
  if (!clientHook) return null;
  // expected like "<slug>_orders"
  // allow "-orders" or "/orders" variants just in case
  const m = String(clientHook).match(/^(.+?)[\-_]orders$/i);
  const slug = m ? m[1] : clientHook;
  return toSlug(slug);
}

async function start() {
  const app = Fastify({ logger: true });

  await app.register(env, { dotenv: true, schema: envSchema });
  await app.register(rawBody, {
    field: 'rawBody',
    global: false,
    runFirst: true,
    encoding: 'utf8',
  });

  app.get('/health', async () => ({ ok: true }));

  // NEW: dynamic client endpoint, e.g. /webhooks/shopify/iv-creative_orders
  app.post('/webhooks/shopify/:clientHook', { config: { rawBody: true } }, async (req, reply) => {
    const clientHook = (req.params as any)?.clientHook as string | undefined;
    const slug = parseClientSlug(clientHook);
    const shopDomainHeader = (req.headers['x-shopify-shop-domain'] as string) || '';
    const hmacHeader = (req.headers['x-shopify-hmac-sha256'] as string) || '';

    if (!slug) {
      req.log.warn({ clientHook }, 'Invalid client hook');
      return reply.code(404).send({ error: 'Invalid endpoint' });
    }

    // Lookup by slug
    const client = await prisma.client.findUnique({ where: { slug } });
    if (!client) {
      req.log.warn({ slug, clientHook }, 'Unknown client slug');
      return reply.code(404).send({ error: 'Unknown client' });
    }

    // Optional cross-check: warn if header domain doesn’t match what we expect
    if (shopDomainHeader && shopDomainHeader !== client.shopDomain) {
      req.log.warn({ expected: client.shopDomain, got: shopDomainHeader, slug }, 'Shop domain mismatch');
      // We continue, because HMAC will validate with the client’s secret anyway
    }

    // Verify HMAC with this client’s webhook secret
    const ok = verifyShopifyHmac({
      rawBody: (req as any).rawBody as Buffer,
      hmacHeader,
      secret: client.shopifyWebhookKey,
    });
    if (!ok) {
      req.log.warn({ slug, shopDomainHeader }, 'Invalid HMAC');
      return reply.code(401).send({ error: 'Invalid HMAC' });
    }

    // Parse Shopify order
    let order: ShopifyOrder;
    try {
      order = JSON.parse((req as any).rawBody.toString('utf8'));
    } catch (e) {
      req.log.error({ err: e, slug }, 'Invalid JSON');
      return reply.code(400).send({ error: 'Invalid JSON' });
    }

    // Idempotency
    const already = await prisma.processedOrder.findUnique({
      where: { id: String(order.id) },
    });
    if (already) {
      return reply.code(200).send({ ok: true, deduped: true });
    }

    // Select printable candidates
    const candidates = order.line_items
      .map((li) => {
        const props = extractProps(li.properties);
        const bits = getDesignBits(props, {
          topKeysJson: client.topKeysJson,
          middleKeysJson: client.middleKeysJson,
          bottomKeysJson: client.bottomKeysJson,
        });
        return { li, bits };
      })
      .filter((x) => !!x.bits.printJobId);

    if (candidates.length === 0) {
      req.log.info({ slug, orderId: order.id }, 'No printable items found; marking processed');
      await prisma.processedOrder.create({
        data: { id: String(order.id), shopDomain: client.shopDomain, kxExternalId: order.name || String(order.id) },
      });
      return reply.code(200).send({ ok: true, itemsWithPrintJobs: 0 });
    }

    // Build and post KornitX order
    const payload = buildKxOrderPayload({
      order,
      companyRefId: client.kxCompanyRefId,
      candidates,
    });

    try {
      const kxResp = await withRetry(
        () =>
          postKornitXOrder({
            baseUrl: process.env.KX_BASE_URL,
            companyRefId: client.kxCompanyRefId,
            apiKey: client.kxApiKey,
            payload,
          }),
        {
          attempts: 5,
          baseMs: 1000,
          maxMs: 8000,
          onRetry: (err, attempt) => {
            req.log.warn({ err: String(err), attempt, slug }, 'KX post failed; will retry');
          },
        }
      );

      req.log.info({ slug, orderId: order.id, kxResp }, 'KX order created');

      await prisma.processedOrder.create({
        data: { id: String(order.id), shopDomain: client.shopDomain, kxExternalId: order.name || String(order.id) },
      });

      return reply.code(200).send({ ok: true, postedToKX: true, items: candidates.length });
    } catch (err) {
      req.log.error({ err: String(err), slug, orderId: order.id, payload }, 'KX post permanently failed');
      // Not marking processed: let Shopify retry webhook
      return reply.code(500).send({ error: 'KornitX post failed' });
    }
  });

  app.listen({ port: Number(process.env.PORT) }, (err, address) => {
    if (err) {
      app.log.error(err);
      process.exit(1);
    }
    app.log.info(`Listening on ${address}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
