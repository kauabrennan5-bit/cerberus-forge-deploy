import type { LifecycleRecord } from "./productPipeline";
import type { ShopeePromotionEvidence } from "./scraper";

export type TelegramReviewStatus =
  | "pending"
  | "publishing"
  | "published"
  | "cancelled"
  | "expired"
  | "rejected"
  | "error";

export interface PendingReview {
  id: string;
  chatId: number;
  senderId: number | string;
  firstName: string;
  username: string;
  createdAt: number;
  expiresAt?: number;
  produto: string;
  rawTitle?: string;
  displayTitle?: string;
  curatorNote?: string;
  categoria: string;
  preco: number;
  imagens: string[];
  imagensOriginais?: string[];
  imagemPrincipal?: string;
  imagensGaleria?: string[];
  imageEditorialStatus?: "clean" | "review_required" | "overlay_suspected";
  normalizedUrl: string;
  descricao?: string;
  status?: TelegramReviewStatus;
  cardMessageId?: number;
  existingProduct?: any;
  lifecycle?: LifecycleRecord;
  promotionEvidence?: ShopeePromotionEvidence | null;
  promotionReview?: {
    price: number;
    condition: "pix" | "pix_with_coupon" | "coupon" | "other";
    benefits: string[];
    source: "admin_confirmed";
    confirmedAt: number;
  } | null;
  promotionDraft?: {
    price: number;
    condition: "pix" | "pix_with_coupon" | "coupon" | "other" | null;
    benefits: string[];
  } | null;
}
