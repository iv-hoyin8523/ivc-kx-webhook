//tools/ping-shopify.js
import crypto from 'node:crypto';
import fetch from 'node-fetch';

const url = 'https://2f9e3xl0w8.execute-api.us-east-1.amazonaws.com/Prod/webhooks/shopify/wobblylife_orders';
const secret = '5a53c715d936a932860a8eaec92348f67b10c423563c2d35b462aa0444a23558'; // same as in Secrets Manager
const shopDomain = 'icsggm-ix.myshopify.com';

const order = {
  id: 999000111,
  name: "#1001",
  order_number: 1001,
  email: "hoyin@iv-creative.co.uk",
  processed_at: new Date().toISOString(),
  line_items: [
    {
      id: 12345, quantity: 1, title: "JURA LABEL", sku: "DPSJURAG-11635890",
      variant_id: 555,
      properties: [
        { name: "Top line", value: "HELLO" },
        { name: "Middle line", value: "FROM" },
        { name: "Bottom line", value: "IVC" },
      ]
    }
  ],
  shipping_address: {
    address1: "1 Test St", address2: "", city: "Lincoln",
    province: "Lincs", zip: "LN1 1AA", country_code: "GB",
    name: "Jane Doe", phone: "+44 7777 000000"
  }
};

const body = Buffer.from(JSON.stringify(order), 'utf8');
const hmac = crypto.createHmac('sha256', secret).update(body).digest('base64');

const res = await fetch(url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Shopify-Hmac-Sha256': hmac,
    'X-Shopify-Shop-Domain': shopDomain
  },
  body
});
console.log(res.status, await res.text());
