// functions/worker/handler.ts
import { SQSEvent } from 'aws-lambda';
import { buildKxOrderPayload, postKornitXOrder } from '../../src/services/kornitx.js';
import {
  getClientBySlug,
  isProcessed,
  markProcessed,
  getProductIdsForSkus,
} from '../../src/aws/dynamo.js';
import { getClientSecrets } from '../../src/aws/secrets.js';
import { withRetry } from '../../src/services/retry.js';

type Candidate = { li: any; bits: { printJobId?: string } };

function hasUserFacingProps(li: any): boolean {
  for (const p of li?.properties || []) {
    const name = String(p?.name || '').trim();
    const value = String(p?.value ?? '').trim();
    if (!name || !value) continue;
    if (name.startsWith('_')) continue; // skip private keys like _printJobId/_thumb
    return true;
  }
  return false;
}

export const handler = async (event: SQSEvent) => {
  for (const rec of event.Records) {
    const msg = JSON.parse(rec.body) as {
      slug: string;
      shopDomain: string;
      secretName: string;
      order: any;
      candidates: Candidate[];
    };

    const { slug, shopDomain, secretName, order, candidates } = msg;

    try {
      // Idempotency per order id
      if (await isProcessed(shopDomain, order.id)) {
        console.log('Order already processed; skipping', { shopDomain, orderId: order.id });
        continue;
      }

      const client = await getClientBySlug(slug);
      if (!client) {
        console.error('Client not found at worker', { slug });
        throw new Error('Client not found');
      }
      const secrets = await getClientSecrets(secretName);

      // Build SKU list from all lines we received (personalised + non-personalised)
      const skus: string[] = [];
      for (const c of candidates) {
        const s = String(c.li?.sku || '').trim();
        if (s) skus.push(s);
      }

      // Load mapping for ALL SKUs (lowercased keys)
      const skuToProductId = await getProductIdsForSkus(slug, skus);

      // Determine personalised lines (Type 2 or Type 5) and ensure mapping exists.
      const personalised = candidates.filter(({ li, bits }) => {
        const hasPrintJob = !!bits?.printJobId;
        if (hasPrintJob) return true; // type 2
        // type 5 if no print job but has user-facing props
        return hasUserFacingProps(li);
      });

      // If nothing personalised: mark processed & skip KX
      if (personalised.length === 0) {
        console.log('No personalised items; marking processed, skipping KX create', {
          orderId: order.id,
          slug,
        });
        await markProcessed(shopDomain, order.id, order.name || String(order.id));
        continue;
      }

      // Enforce mapping for personalised SKUs (no default allowed)
      const missing = personalised
        .map((p) => String(p.li?.sku || '').trim().toLowerCase())
        .filter((sku) => sku && skuToProductId[sku] == null);

      if (missing.length > 0) {
        console.error('Missing product_id mapping for personalised SKUs', { slug, missing });
        throw new Error(`Missing product_id mapping: ${missing.join(', ')}`);
      }

      // Build KX payload; this function:
      // - sends Type 2 with only _thumb attributes when print_job_ref exists
      // - sends Type 5 with pass-through user attributes (excl. _ keys)
      // - skips non-personalised lines entirely
      const kxPayload = buildKxOrderPayload({
        order,
        companyRefId: secrets.kxCompanyRefId,
        candidates,          // include all; builder will filter non-personalised
        skuToProductId,      // required; no default
        // defaultProductId: undefined (enforced by throwing above)
      });

      if (!kxPayload.items || kxPayload.items.length === 0) {
        console.log('After filtering, no personalised items; marking processed, skipping KX create', {
          orderId: order.id,
          slug,
        });
        await markProcessed(shopDomain, order.id, order.name || String(order.id));
        continue;
      }

      // Post to KX with retries
      const kxResp = await withRetry(
        () =>
          postKornitXOrder({
            baseUrl: process.env.KX_BASE_URL,
            companyRefId: secrets.kxCompanyRefId,
            apiKey: secrets.kxApiKey,
            payload: kxPayload,
          }),
        {
          attempts: 5,
          baseMs: 1000,
          maxMs: 8000,
          onRetry: (err, attempt) => {
            console.warn('KX post failed; will retry', { slug, orderId: order.id, attempt, err: String(err) });
          },
        }
      );

      await markProcessed(shopDomain, order.id, order.name || String(order.id));
      console.log('KX order created', { slug, orderId: order.id, items: kxPayload.items.length, kxResp });
    } catch (err: any) {
      // Throw to let SQS retry and, if still failing, move to DLQ
      console.error('Worker fatal error; will retry', {
        slug,
        orderId: msg?.order?.id,
        err: String(err?.stack || err),
      });
      throw err;
    }
  }
};
