export type ShopifyOrder = {
  id: number;
  name: string;                  // e.g. "#1234"
  order_number: number;
  email: string | null;
  customer?: { first_name?: string | null; last_name?: string | null; email?: string | null; phone?: string | null; };
  processed_at?: string | null;  // ISO timestamp
  created_at?: string | null;
  line_items: Array<{
    id: number;
    quantity: number;
    title: string;
    sku: string | null;
    variant_id: number | null;
    properties?: Array<{ name: string; value: string }>;
  }>;
  shipping_address?: {
    company?: string | null;
    address1?: string | null;
    address2?: string | null;
    city?: string | null;
    province?: string | null;
    zip?: string | null;
    country_code?: string | null;
    name?: string | null;
    phone?: string | null;
  };
  billing_address?: {
    name?: string | null;
    company?: string | null;
    address1?: string | null;
    address2?: string | null;
    city?: string | null;
    province?: string | null;
    zip?: string | null;
    country_code?: string | null;
  };
};
