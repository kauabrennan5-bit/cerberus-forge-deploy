/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PUBLIC_CATALOG_EDGE_BASE?: string;
  readonly VITE_SERVERLESS_RUNTIME_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
