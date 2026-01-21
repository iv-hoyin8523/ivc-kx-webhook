// src/services/kornitx.ts
import type { ShopifyOrder } from '../types.js';

export interface KxOrderItem {
  external_ref: string;
  quantity: number;
  type: number;                        // 2 = print job, 5 = textual product
  print_job_ref?: string;              // present when type=2
  sku?: string | null;
  description?: string | null;
  textual_product_id?: number;         // KX product id per your sample
  attributes?: Array<{ name: string; value: string }>;
}

export interface KxOrderPayload {
  external_ref: string;                // Shopify order name or id
  company_ref_id: number;              // KX company ref id
  sale_datetime?: string;              // 'YYYY-MM-DD HH:MM:SS' UTC
  customer_name?: string;
  customer_email?: string;
  customer_telephone?: string;
  shipping_address_1?: string;
  shipping_address_2?: string;
  shipping_address_3?: string;
  shipping_address_4?: string;
  shipping_address_5?: string;
  shipping_postcode?: string;
  shipping_country_code?: string;
  items: KxOrderItem[];
}

export type DesignBits = {
  top?: string;         // kept for legacy extraction, but not auto-injected
  middle?: string;
  bottom?: string;
  printJobId?: string;  // _printJobId
  thumb?: string;       // _thumb (URL)
};

function pad(n: number) { return n < 10 ? `0${n}` : String(n); }

/** Format to 'YYYY-MM-DD HH:MM:SS' in UTC (KX-friendly) */
export function formatUtc(ts?: string | null): string | undefined {
  if (!ts) return undefined;
  const d = new Date(ts);
  if (isNaN(d.getTime())) return undefined;
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** True if the line has at least one non-private property (i.e., relevant for type 5). */
function hasUserFacingProps(li: ShopifyOrder['line_items'][number]): boolean {
  for (const p of li.properties || []) {
    const name = String(p.name || '').trim();
    const value = String(p.value ?? '').trim();
    if (!name || !value) continue;
    if (name.startsWith('_')) continue;
    return true;
  }
  return false;
}

/** Pass through storefront/KX properties verbatim (excludes private '_' keys), add _thumb once if present. */
function passthroughAttributes(
  li: ShopifyOrder['line_items'][number],
  thumb?: string
) {
  const attrs: Array<{ name: string; value: string }> = [];
  const seen = new Set<string>();

  for (const p of li.properties || []) {
    const name = String(p.name || '').trim();
    const value = String(p.value ?? '').trim();
    if (!name || !value) continue;
    if (name.startsWith('_')) continue;       // skip _printJobId, _thumb, etc.
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    attrs.push({ name, value });
  }

  if (thumb && !seen.has('_thumb')) {
    attrs.push({ name: '_thumb', value: thumb });
    seen.add('_thumb');
  }

  return attrs;
}

/** Only include _thumb for type 2 */
function attributesForType2(thumb?: string) {
  const attrs: Array<{ name: string; value: string }> = [];
  if (thumb) attrs.push({ name: '_thumb', value: thumb });
  return attrs;
}

/** Build a KX order payload; mixes type 2 (print job) and type 5 (textual) per line,
 *  and **skips non-personalised items** (no print job & no user-facing properties).
 */
export function buildKxOrderPayload(opts: {
  order: ShopifyOrder;
  companyRefId: string;
  candidates: Array<{
    li: ShopifyOrder['line_items'][number];
    bits: DesignBits;
  }>;
  skuToProductId?: Record<string, number>;  // mapping from normalized SKU to KX product id
  defaultProductId?: number;                // fallback if mapping missing
}): KxOrderPayload {
  const { order, companyRefId, candidates, skuToProductId, defaultProductId } = opts;

  // Customer details
  const custName =
    order.shipping_address?.name || 
    [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(' ') ||
    undefined;

  // Shipping fields
  const ship = order.shipping_address;
  const shipping_address_1 = ship?.address1 || undefined;
  const shipping_address_2 = ship?.address2 || undefined;
  const shipping_address_3 = ship?.city || undefined;
  const shipping_address_4 = ship?.province || undefined;
  const shipping_address_5 = ship?.company || undefined;
  const shipping_postcode = ship?.zip || undefined;
  const shipping_country_code = ship?.country_code || undefined;

  const items: KxOrderItem[] = [];

  for (const { li, bits } of candidates) {
    const normSku = (li.sku || '').trim().toLowerCase();
    const mappedPid = skuToProductId?.[normSku];
    const textual_product_id = mappedPid ?? defaultProductId;

    const hasPrintJob = !!bits.printJobId;

    if (hasPrintJob) {
      // TYPE 2: print job + only _thumb
      items.push({
        external_ref: String(li.id),
        quantity: Number(li.quantity || 1),
        type: 2,
        print_job_ref: String(bits.printJobId),
        sku: li.sku,
        description: li.title,
        textual_product_id,
        attributes: attributesForType2(bits.thumb)
      });
      continue;
    }

    // TYPE 5 candidate only if it has user-facing props
    if (hasUserFacingProps(li)) {
      const attributes = passthroughAttributes(li, bits.thumb);
      if (attributes.length > 0) {
        items.push({
          external_ref: String(li.id),
          quantity: Number(li.quantity || 1),
          type: 5,
          sku: li.sku,
          description: li.title,
          textual_product_id,
          attributes
        });
      }
      // else: if no attributes after filtering, treat as non-personalised -> skip
    }
    // else: non-personalised -> skip
  }

  return {
    external_ref: order.name || String(order.id),
    company_ref_id: Number(companyRefId),
    sale_datetime: formatUtc(order.processed_at || order.created_at),
    customer_name: custName,
    customer_email: order.customer?.email || order.email || undefined,
    customer_telephone: order.customer?.phone || ship?.phone || undefined,
    shipping_address_1,
    shipping_address_2,
    shipping_address_3,
    shipping_address_4,
    shipping_address_5,
    shipping_postcode,
    shipping_country_code,
    items
  };
}

/** POST order to KornitX. Uses global fetch (Node 18/20+). */
export async function postKornitXOrder({
  baseUrl,
  companyRefId,
  apiKey,
  payload
}: {
  baseUrl?: string;               // defaults to KX prod
  companyRefId: string;
  apiKey: string;
  payload: KxOrderPayload;
}) {
  const url = (baseUrl || 'https://api-sl-2-2.kornitx.net') + '/order';
  const auth = Buffer.from(`${companyRefId}:${apiKey}`).toString('base64');

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`KX ${res.status} ${res.statusText} - ${text}`);
  }
  return res.json();
}

