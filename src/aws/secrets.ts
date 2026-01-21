//src/aws/secrets.ts
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const sm = new SecretsManagerClient({});

export async function getClientSecrets(secretName: string) {
  const res = await sm.send(new GetSecretValueCommand({ SecretId: secretName }));
  const str = res.SecretString || Buffer.from(res.SecretBinary ?? []).toString('utf8');
  // expected JSON: { "shopifyWebhookKey": "...", "kxCompanyRefId": "...", "kxApiKey": "..." }
  return JSON.parse(str) as {
    shopifyWebhookKey: string;
    kxCompanyRefId: string;
    kxApiKey: string;
  };
}
