// src/services/line-props.ts
type KV = Record<string, string>;

export function extractProps(
  props: Array<{ name: string; value: string }> | undefined
): KV {
  const out: KV = {};
  for (const p of props || []) out[p.name] = String(p.value ?? '');
  return out;
}

export function findFirstKey(obj: KV, candidates: string[]): string | undefined {
  if (!candidates?.length) return undefined;
  const lowerToReal: Record<string, string> = {};
  for (const k of Object.keys(obj)) lowerToReal[k.toLowerCase()] = k;
  for (const cand of candidates) {
    const real = lowerToReal[cand.toLowerCase()];
    if (real && obj[real]) return obj[real];
  }
  return undefined;
}

// --- NEW: accept arrays OR JSON string and normalize ---
type KeyCfg =
  | { topKeys?: string[] | string | null; middleKeys?: string[] | string | null; bottomKeys?: string[] | string | null }
  | { topKeysJson?: string | null; middleKeysJson?: string | null; bottomKeysJson?: string | null };

function toArray(maybeArrOrJson?: string[] | string | null): string[] {
  if (Array.isArray(maybeArrOrJson)) return maybeArrOrJson;
  const s = typeof maybeArrOrJson === 'string' ? maybeArrOrJson.trim() : '';
  if (!s) return [];
  // Try JSON first; fallback to comma-split convenience
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed)) return parsed.filter((x) => typeof x === 'string');
  } catch {}
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

function normalizeKeyCfg(cfg: KeyCfg) {
  // Support either ...Keys (arrays/strings) or ...KeysJson (string)
  const top = 'topKeys' in cfg ? cfg.topKeys : (cfg as any).topKeysJson;
  const mid = 'middleKeys' in cfg ? cfg.middleKeys : (cfg as any).middleKeysJson;
  const bot = 'bottomKeys' in cfg ? cfg.bottomKeys : (cfg as any).bottomKeysJson;
  return {
    topKeys: toArray(top),
    middleKeys: toArray(mid),
    bottomKeys: toArray(bot),
  };
}

export function getDesignBits(obj: KV, cfg: KeyCfg) {
  const norm = normalizeKeyCfg(cfg);

  return {
    top:    findFirstKey(obj, norm.topKeys)    ?? obj['Top line'],
    middle: findFirstKey(obj, norm.middleKeys) ?? obj['Middle line'],
    bottom: findFirstKey(obj, norm.bottomKeys) ?? obj['Bottom line'],
    printJobId:
      obj['_printJobId'] ||
      obj['_printjobid'] ||
      obj['print_job_ref'],
    thumb:
      obj['_thumb'] ||
      obj['_thumbnail'] ||
      obj['thumbnail'],
  };
}
