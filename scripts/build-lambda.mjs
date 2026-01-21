// scripts/build-lambda.mjs
import { build } from 'esbuild';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const outdir = 'dist';
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

/** Shared esbuild opts: CJS for Lambda to avoid ESM/require issues */
const base = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',                    // <<< IMPORTANT
  sourcemap: true,
  minify: false,
  legalComments: 'none',
  logLevel: 'info',
  external: [],                     // fully bundle @aws-sdk & deps
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production'),
  },
};

await build({
  ...base,
  entryPoints: {
    'functions/api/handler': 'functions/api/handler.ts',
    'functions/worker/handler': 'functions/worker/handler.ts',
  },
  outdir,
});

console.log('Lambda code bundled to', outdir);
