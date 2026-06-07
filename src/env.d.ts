/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly PUBLIC_POLYVANE_API_URL?: string;
  readonly PUBLIC_POLYVANE_API_KEY?: string;
  readonly PUBLIC_POLYMARKET_CLOB_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
