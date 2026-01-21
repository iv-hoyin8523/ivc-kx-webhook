//src/aws/dynamo.ts
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, BatchGetCommand } from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({});
export const ddb = DynamoDBDocumentClient.from(client);

const CLIENTS = process.env.CLIENTS_TABLE!;
const PROCESSED = process.env.PROCESSED_TABLE!;
const SKU_MAP = process.env.SKU_MAP_TABLE || "ivc-kx-sku-map"; // fallback if not injected

export async function getClientBySlug(slug: string) {
  const res = await ddb.send(new GetCommand({ TableName: CLIENTS, Key: { slug } }));
  return res.Item as (null | {
    slug: string;
    shopDomain: string;
    secretName: string;
    topKeysJson?: string;
    middleKeysJson?: string;
    bottomKeysJson?: string;
    defaultKxProductId?: number; // optional: set in the item if you want a fallback
  });
}

export async function isProcessed(shopDomain: string, orderId: string | number) {
  const shopOrderKey = `${shopDomain}#${orderId}`;
  const res = await ddb.send(new GetCommand({ TableName: PROCESSED, Key: { shopOrderKey } }));
  return !!res.Item;
}

export async function markProcessed(shopDomain: string, orderId: string | number, kxExternalId: string) {
  const shopOrderKey = `${shopDomain}#${orderId}`;
  await ddb.send(new PutCommand({
    TableName: PROCESSED,
    Item: { shopOrderKey, kxExternalId, processedAt: new Date().toISOString() }
  }));
}

/** Batch fetch product_ids for a set of SKUs under a slug.
 *  Returns a map of normalizedSKU -> product_id (number).
 */
export async function getProductIdsForSkus(slug: string, skus: string[]) {
  const normalized = Array.from(new Set(
    skus.filter(Boolean).map(s => s.trim().toLowerCase())
  ));
  if (normalized.length === 0) return {};

  // BatchGet max is 100 items per request; our sets are usually small
  const keys = normalized.map(s => ({ slug, sku: s }));
  const res = await ddb.send(new BatchGetCommand({
    RequestItems: { [SKU_MAP]: { Keys: keys } }
  }));

  const out: Record<string, number> = {};
  for (const item of (res.Responses?.[SKU_MAP] || [])) {
    const sku = String(item.sku || '').toLowerCase();
    const pid = Number(item.product_id);
    if (sku && Number.isFinite(pid)) out[sku] = pid;
  }
  return out;
}
