export type ProductStatus = "pending" | "approved" | "published" | "paused" | "archived" | "error";

export interface Product {
  id: string;
  ref?: string;
  produto: string;
  categoria: string;
  preco: number;
  imagens: string[];
  link: string;
  ativo: boolean;
  destaque: boolean;
  status?: ProductStatus;
  createdBy?: string;
  slug?: string;
  descricao?: string;
  paginaPonteUrl?: string;
  rawRowIndex?: number;
  lifecycleState?: string;
  lifecycleUpdatedAt?: string;
}

export interface AppConfig {
  csvUrl: string;
  appsScriptUrl: string;
  metaPixelId: string;
  tikTokPixelId: string;
  metaAccessToken?: string;
  adminPassword: string;
}

export type ViewMode = 'catalog' | 'admin' | 'product-detail';

export interface ExtractionResult {
  produto: string;
  preco: number | null;
  imagens: string[];
}
