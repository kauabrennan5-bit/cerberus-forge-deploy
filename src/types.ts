export type ProductStatus = "pending" | "approved" | "published" | "paused" | "archived" | "error";

export type PromotionOfferCondition = "pix" | "pix_with_coupon" | "coupon" | "other";

/** Oferta observada e confirmada pelo administrador; nunca substitui `preco`. */
export interface PromotionOffer {
  price: number;
  condition: PromotionOfferCondition;
  benefits: string[];
  source: "admin_confirmed";
  confirmedAt: number;
}

export interface Product {
  id: string;
  ref?: string;
  /** Título canônico atual; preservado para compatibilidade e auditoria. */
  produto: string;
  /** Título bruto observado na fonte, nunca prioritário na vitrine. */
  rawTitle?: string;
  /** Título editorial em português, aprovado pela curadoria. */
  displayTitle?: string;
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
  ofertaPromocional?: PromotionOffer;
  /** Nota editorial opcional escrita pelo curador; não renderiza se ausente. */
  curatorNote?: string;
  rawRowIndex?: number;
  lifecycleState?: string;
  lifecycleUpdatedAt?: string;
  createdAt?: string;
}

export interface AppConfig {
  csvUrl: string;
  appsScriptUrl: string;
  metaPixelId: string;
  tikTokPixelId: string;
  metaAccessToken?: string;
  adminPassword: string;
}

export type ViewMode = 'catalog' | 'admin' | 'product-detail' | 'privacy' | 'terms';

export interface ExtractionResult {
  produto: string;
  preco: number | null;
  imagens: string[];
}
