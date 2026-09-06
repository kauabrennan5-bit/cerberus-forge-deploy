import fs from "fs";
import path from "path";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import type { PendingReview, TelegramReviewStatus } from "../services/telegramTypes";
import { bindProductSourceIdentityByReview, releaseProductSourceIdentityByReview, reserveProductSourceIdentity } from "./autonomousCuratorRepository";
import { isPublicHttpsImageUrl } from "../../src/lib/productCanonical";

dotenv.config();

const DATA_DIR = path.join(process.cwd(), "data");
const REVIEWS_FILE = path.join(DATA_DIR, "telegram_reviews.json");
const USER_STATES_FILE = path.join(DATA_DIR, "telegram_user_states.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const SESSION_EXPIRATION_MS = 60 * 60 * 1000;

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const supabase: SupabaseClient | null = (supabaseUrl && supabaseServiceRoleKey)
  ? createClient(supabaseUrl, supabaseServiceRoleKey)
  : null;

export type UserStateInput = {
  action: string;
  reviewId?: string;
  productId?: string;
  data?: Record<string, unknown>;
};

export interface UserState extends UserStateInput {
  senderId: string;
  updatedAt: number;
}

function readReviewsFromFile(): Record<string, PendingReview> {
  try {
    if (fs.existsSync(REVIEWS_FILE)) {
      const raw = fs.readFileSync(REVIEWS_FILE, "utf-8");
      return JSON.parse(raw);
    }
  } catch (err) {
    console.error("[Telegram Repo] Erro ao ler telegram_reviews.json:", err);
  }
  return {};
}

function writeReviewsToFile(reviews: Record<string, PendingReview>): void {
  try {
    fs.writeFileSync(REVIEWS_FILE, JSON.stringify(reviews, null, 2), "utf-8");
  } catch (err) {
    console.error("[Telegram Repo] Erro ao salvar telegram_reviews.json:", err);
  }
}

function readUserStatesFromFile(): Record<string, UserState> {
  try {
    if (fs.existsSync(USER_STATES_FILE)) {
      const raw = fs.readFileSync(USER_STATES_FILE, "utf-8");
      return JSON.parse(raw);
    }
  } catch (err) {
    console.error("[Telegram Repo] Erro ao ler telegram_user_states.json:", err);
  }
  return {};
}

function writeUserStatesToFile(states: Record<string, UserState>): void {
  try {
    fs.writeFileSync(USER_STATES_FILE, JSON.stringify(states, null, 2), "utf-8");
  } catch (err) {
    console.error("[Telegram Repo] Erro ao salvar telegram_user_states.json:", err);
  }
}

let testOverrideSavePendingReview: ((review: PendingReview) => Promise<void>) | null = null;
let testOverrideGetPendingReview: ((reviewId: string) => Promise<PendingReview | null>) | null = null;
let testOverrideListReviewsByStatus: ((statuses: TelegramReviewStatus[], limit: number) => Promise<PendingReview[]>) | null = null;
let testOverrideSetUserState: ((senderId: string | number, state: UserStateInput) => Promise<void>) | null = null;
let testOverrideGetUserState: ((senderId: string | number) => Promise<UserStateInput | null>) | null = null;
let testOverrideDeleteUserState: ((senderId: string | number) => Promise<void>) | null = null;

export function setTestSavePendingReview(
  override: ((review: PendingReview) => Promise<void>) | null,
): void {
  testOverrideSavePendingReview = override;
}

export function setTestGetPendingReview(
  override: ((reviewId: string) => Promise<PendingReview | null>) | null,
): void {
  testOverrideGetPendingReview = override;
}

export function setTestListReviewsByStatus(
  override: ((statuses: TelegramReviewStatus[], limit: number) => Promise<PendingReview[]>) | null,
): void {
  testOverrideListReviewsByStatus = override;
}

/** Isola a máquina de estados em testes sem tocar no arquivo/Supabase. */
export function setTestUserStateHandlers(handlers: {
  set?: ((senderId: string | number, state: UserStateInput) => Promise<void>) | null;
  get?: ((senderId: string | number) => Promise<UserStateInput | null>) | null;
  delete?: ((senderId: string | number) => Promise<void>) | null;
} | null): void {
  testOverrideSetUserState = handlers?.set ?? null;
  testOverrideGetUserState = handlers?.get ?? null;
  testOverrideDeleteUserState = handlers?.delete ?? null;
}

function reviewExpiresAt(review: PendingReview): number {
  return review.expiresAt || review.createdAt + SESSION_EXPIRATION_MS;
}

export function isActivePendingReview(review: PendingReview, now = Date.now()): boolean {
  return (review.status === undefined || review.status === "pending") && now < reviewExpiresAt(review);
}

function isExpiredReview(review: PendingReview, now = Date.now()): boolean {
  return review.status === "expired" || ((review.status === undefined || review.status === "pending") && now >= reviewExpiresAt(review));
}

/**
 * Reviews expiradas continuam legíveis para auditoria e para que o Telegram
 * consiga comunicar "review expirada", mas nenhuma mutação posterior pode
 * reativá-las. A única escrita permitida depois do TTL é a transição para
 * status=expired em si.
 */
export function isReviewMutationAllowed(review: PendingReview, now = Date.now()): boolean {
  const expiresAt = reviewExpiresAt(review);
  if (now < expiresAt) return true;
  return review.status === "expired";
}

function normalizeReviewRow(row: any): PendingReview | null {
  if (!row?.data || typeof row.data !== "object") return null;
  const review = { ...row.data } as PendingReview;
  if (row.created_at && !review.createdAt) review.createdAt = Number(row.created_at);
  if (row.expires_at) review.expiresAt = Number(row.expires_at);
  if (row.status) review.status = row.status as TelegramReviewStatus;
  return review;
}

const HUMAN_PUBLICATION_TECHNICAL_IMAGE_BLOCKERS = new Set([
  "IMAGE_MISSING",
  "IMAGE_HOST_INVALID",
  "IMAGE_PLACEHOLDER",
  "IMAGE_INACCESSIBLE",
  "IMAGE_REDIRECT_HOST_INVALID",
  "IMAGE_HTTP_ERROR",
  "IMAGE_BODY_UNREADABLE",
  "IMAGE_EMPTY",
  "IMAGE_TOO_LARGE",
  "IMAGE_BYTES_INVALID",
  "IMAGE_MIME_UNSUPPORTED",
  "IMAGE_DIMENSIONS_UNKNOWN",
  "IMAGE_TOO_SMALL",
  "IMAGE_INVALID",
]);

/**
 * Compatibility view used only when a human is about to act on a review.
 *
 * The legacy confirm_pub handler historically treated imageEditorialStatus as
 * a completeness requirement before ProductPipeline.approve() could establish
 * human authority. For reviews that are explicitly manual (the /shopee manual
 * delivery contract or Autonomous Curator cards), a review_required image is
 * therefore projected in-memory as technically usable when—and only when—we
 * already have a public HTTPS image and no objective image blocker.
 *
 * The original editorial state and reason stay in existingProduct for audit.
 * This function does not publish, does not bind Shopee identity, does not touch
 * price/category/link gates, and does not persist anything by itself. The
 * canonical publication pipeline still revalidates image accessibility and all
 * objective publication invariants after the human click.
 */
export function applyHumanPublicationImageView(review: PendingReview): PendingReview {
  const meta = review.existingProduct && typeof review.existingProduct === "object"
    ? review.existingProduct as Record<string, any>
    : null;
  const hasHumanAuthorityContract = meta?.manualDeliveryContract === true || meta?.source === "autonomous_curator";
  if (!hasHumanAuthorityContract) return review;
  if (review.status && !["pending", "error"].includes(review.status)) return review;
  if (review.imageEditorialStatus === "clean") return review;

  const reasons = Array.isArray(meta?.manualReviewReasons)
    ? meta!.manualReviewReasons.map((value: unknown) => String(value || "").trim()).filter(Boolean)
    : [];
  if (reasons.some(reason => HUMAN_PUBLICATION_TECHNICAL_IMAGE_BLOCKERS.has(reason))) return review;

  const observedImages = [
    review.imagemPrincipal,
    ...(review.imagens || []),
    ...(review.imagensOriginais || []),
    ...(review.imagensGaleria || []),
  ]
    .filter((value): value is string => isPublicHttpsImageUrl(value))
    .map(value => value.trim())
    .filter((value, index, list) => list.indexOf(value) === index);
  const primaryImageUrl = observedImages[0];
  if (!primaryImageUrl) return review;

  const galleryImageUrls = observedImages.filter(url => url !== primaryImageUrl);
  const originalImageEditorialStatus = review.imageEditorialStatus || "unreviewed";
  const originalImageCurationStatus = review.imageCuration?.status || "missing";
  const originalImageCurationReason = review.imageCuration?.reason || null;

  return {
    ...review,
    imagens: observedImages,
    imagensOriginais: observedImages,
    imagemPrincipal: primaryImageUrl,
    imagensGaleria: galleryImageUrls,
    imageEditorialStatus: "clean",
    imageCuration: {
      status: "ready",
      rawImageUrls: observedImages,
      primaryImageUrl,
      galleryImageUrls,
      assessments: review.imageCuration?.assessments || [],
    },
    existingProduct: {
      ...meta,
      humanPublicationImageAuthorityApplied: true,
      originalImageEditorialStatus,
      originalImageCurationStatus,
      originalImageCurationReason,
      manualReviewReasons: reasons,
    },
  };
}

async function syncAutonomousCuratorReviewIdentity(review: PendingReview): Promise<void> {
  const meta = review.existingProduct as any;
  if (meta?.source !== "autonomous_curator") return;
  const shopId = String(meta.shopId || "").trim();
  const itemId = String(meta.itemId || "").trim();
  const runId = String(meta.autonomousCuratorRunId || "").trim();
  if (!shopId || !itemId || !runId || !review.normalizedUrl) {
    throw new Error("AUTONOMOUS_CURATOR_REVIEW_IDENTITY_METADATA_INVALID");
  }
  const status = review.status || "pending";
  if (status === "published") {
    const productId = review.lifecycle?.publishedProductId;
    if (!productId) throw new Error("AUTONOMOUS_CURATOR_REVIEW_PUBLISHED_PRODUCT_MISSING");
    await bindProductSourceIdentityByReview({ reviewId: review.id, productId });
    return;
  }
  if (["rejected", "cancelled", "expired"].includes(status)) {
    await releaseProductSourceIdentityByReview(review.id);
    return;
  }
  const ttlMinutes = Math.max(5, Math.ceil(((review.expiresAt || (Date.now() + SESSION_EXPIRATION_MS)) - Date.now()) / 60_000));
  const reservation = await reserveProductSourceIdentity({
    marketplace: "Shopee",
    shopId,
    itemId,
    sourceProductUrl: review.normalizedUrl,
    runId,
    reviewId: review.id,
    ttlMinutes,
  });
  if (!reservation.reserved) throw new Error("AUTONOMOUS_CURATOR_REVIEW_IDENTITY_CONFLICT");
}

export async function savePendingReview(review: PendingReview): Promise<void> {
  if (testOverrideSavePendingReview) {
    await testOverrideSavePendingReview(review);
    return;
  }
  const createdAt = review.createdAt || Date.now();
  const expiresAt = review.expiresAt || (createdAt + SESSION_EXPIRATION_MS);
  const status = review.status || "pending";

  const normReview: PendingReview = {
    ...review,
    createdAt,
    expiresAt,
    status,
  };

  const reviews = readReviewsFromFile();
  const previous = reviews[normReview.id];
  if (previous?.status === "expired" && normReview.status !== "expired") {
    throw new Error("TELEGRAM_REVIEW_EXPIRED_IMMUTABLE");
  }

  await syncAutonomousCuratorReviewIdentity(normReview);

  reviews[normReview.id] = normReview;
  writeReviewsToFile(reviews);

  if (supabase) {
    try {
      const { error } = await supabase.from("telegram_pending_reviews").upsert({
        id: normReview.id,
        chat_id: String(normReview.chatId),
        sender_id: String(normReview.senderId),
        first_name: normReview.firstName,
        username: normReview.username,
        created_at: normReview.createdAt,
        expires_at: normReview.expiresAt,
        status: normReview.status,
        data: normReview,
      }, { onConflict: "id" });

      if (error && error.code !== "PGRST205") {
        console.warn("[Telegram Repo Warning] Erro ao salvar revisão no Supabase:", error.message);
      }
    } catch (err: any) {
      console.warn("[Telegram Repo Warning] Falha na conexão com Supabase:", err?.message);
    }
  }
}

export async function getPendingReview(reviewId: string): Promise<PendingReview | null> {
  if (testOverrideGetPendingReview) {
    const overridden = await testOverrideGetPendingReview(reviewId);
    return overridden ? applyHumanPublicationImageView(overridden) : null;
  }
  let review: PendingReview | null = null;

  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("telegram_pending_reviews")
        .select("data, created_at, expires_at, status")
        .eq("id", reviewId)
        .single();

      if (!error && data) review = normalizeReviewRow(data);
    } catch {
      // Fallback para arquivo local se Supabase falhar.
    }
  }

  if (!review) {
    const reviews = readReviewsFromFile();
    review = reviews[reviewId] || null;
  }

  if (!review) return null;

  if (!review.createdAt) review.createdAt = Date.now();
  if (!review.expiresAt) review.expiresAt = review.createdAt + SESSION_EXPIRATION_MS;
  if (!review.status) review.status = "pending";

  const now = Date.now();
  if (review.status === "pending" && now >= review.expiresAt) {
    console.log(`[Telegram Repo] Sessão de revisão ${reviewId} expirada; status atualizado para expired.`);
    review.status = "expired";
    await savePendingReview(review);
  }

  // A view de autoridade humana é aplicada somente na leitura individual que
  // antecede ações explícitas; listagens e persistência continuam exibindo a
  // evidência editorial original até o administrador realmente agir.
  review = applyHumanPublicationImageView(review);

  // A review expirada permanece consultável para auditoria e para mensagens
  // específicas de expiração, mas savePendingReview impede reativação/mutação.
  return review;
}

/**
 * Obtém somente a revisão PENDENTE mais recente do usuário/chat.
 * Reviews publicadas, rejeitadas, canceladas ou expiradas nunca são retornadas.
 */
export async function getLatestPendingReviewForUser(
  senderId: string | number,
  chatId?: string | number,
): Promise<PendingReview | null> {
  const sId = String(senderId);
  const cId = chatId !== undefined && chatId !== null ? String(chatId) : null;
  const now = Date.now();

  if (supabase) {
    try {
      let query = supabase
        .from("telegram_pending_reviews")
        .select("data, created_at, expires_at, status")
        .eq("status", "pending")
        .order("created_at", { ascending: false });

      if (cId) {
        query = query.or(`sender_id.eq.${sId},chat_id.eq.${cId}`);
      } else {
        query = query.eq("sender_id", sId);
      }

      const { data, error } = await query.limit(10);
      if (!error && data) {
        for (const row of data) {
          const review = normalizeReviewRow(row);
          if (review && isActivePendingReview(review, now)) return review;
        }
      }
    } catch {
      // Fallback local quando Supabase estiver indisponível.
    }
  }

  const reviews = Object.values(readReviewsFromFile())
    .filter((review) => {
      const matchUser = String(review.senderId) === sId || (cId !== null && String(review.chatId) === cId);
      return Boolean(matchUser) && isActivePendingReview(review, now);
    })
    .sort((a, b) => b.createdAt - a.createdAt);

  return reviews[0] || null;
}

/**
 * Lista reviews por status real. É a consulta-base para painéis de pendentes,
 * aprovados e auditoria; não mistura status diferentes silenciosamente.
 */
export async function listReviewsByStatus(
  statuses: TelegramReviewStatus[],
  limit = 20,
): Promise<PendingReview[]> {
  const uniqueStatuses = Array.from(new Set(statuses)).filter(Boolean);
  if (uniqueStatuses.length === 0) return [];
  const safeLimit = Math.min(Math.max(1, Math.trunc(limit || 20)), 100);

  if (testOverrideListReviewsByStatus) {
    return testOverrideListReviewsByStatus(uniqueStatuses, safeLimit);
  }

  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("telegram_pending_reviews")
        .select("data, created_at, expires_at, status")
        .in("status", uniqueStatuses)
        .order("created_at", { ascending: false })
        .limit(safeLimit);
      if (!error && data) {
        const now = Date.now();
        return data
          .map(normalizeReviewRow)
          .filter((review): review is PendingReview => Boolean(review))
          .filter(review => review.status !== "pending" || isActivePendingReview(review, now));
      }
    } catch {
      // Fallback local quando a tabela operacional estiver indisponível.
    }
  }

  const statusSet = new Set<TelegramReviewStatus>(uniqueStatuses);
  const now = Date.now();
  return Object.values(readReviewsFromFile())
    .filter((review) => {
      const status = review.status || "pending";
      if (!statusSet.has(status)) return false;
      return status !== "pending" || isActivePendingReview(review, now);
    })
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, safeLimit);
}

export async function listPendingReviews(limit = 20): Promise<PendingReview[]> {
  const reviews = await listReviewsByStatus(["pending"], limit);
  return reviews.sort((a, b) => a.createdAt - b.createdAt);
}

export async function deletePendingReview(reviewId: string): Promise<void> {
  const reviews = readReviewsFromFile();
  if (reviews[reviewId]) {
    delete reviews[reviewId];
    writeReviewsToFile(reviews);
  }

  if (supabase) {
    try {
      await supabase.from("telegram_pending_reviews").delete().eq("id", reviewId);
    } catch {
      // Best effort; o registro operacional pode já não existir.
    }
  }
}

export async function setUserState(
  senderId: string | number,
  state: UserStateInput,
): Promise<void> {
  if (testOverrideSetUserState) {
    await testOverrideSetUserState(senderId, state);
    return;
  }
  const sId = String(senderId);
  const userStateObj: UserState = {
    senderId: sId,
    action: state.action,
    reviewId: state.reviewId,
    productId: state.productId,
    data: state.data,
    updatedAt: Date.now(),
  };

  const states = readUserStatesFromFile();
  states[sId] = userStateObj;
  writeUserStatesToFile(states);

  if (supabase) {
    try {
      await supabase.from("telegram_user_states").upsert({
        sender_id: sId,
        action: state.action,
        review_id: state.reviewId,
        product_id: state.productId,
        data: state.data || {},
        updated_at: userStateObj.updatedAt,
      }, { onConflict: "sender_id" });
    } catch {
      // Fallback local já foi persistido.
    }
  }
}

export async function getUserState(
  senderId: string | number,
): Promise<UserStateInput | null> {
  if (testOverrideGetUserState) return testOverrideGetUserState(senderId);
  const sId = String(senderId);
  let stateObj: UserState | null = null;

  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("telegram_user_states")
        .select("*")
        .eq("sender_id", sId)
        .single();

      if (!error && data) {
        stateObj = {
          senderId: data.sender_id,
          action: data.action,
          reviewId: data.review_id,
          productId: data.product_id,
          data: data.data && typeof data.data === "object" && !Array.isArray(data.data) ? data.data : {},
          updatedAt: Number(data.updated_at) || Date.now(),
        };
      }
    } catch {
      // Fallback local.
    }
  }

  if (!stateObj) {
    const states = readUserStatesFromFile();
    stateObj = states[sId] || null;
  }

  if (!stateObj) return null;

  if (Date.now() - stateObj.updatedAt > SESSION_EXPIRATION_MS) {
    await deleteUserState(senderId);
    return null;
  }

  return { action: stateObj.action, reviewId: stateObj.reviewId, productId: stateObj.productId, data: stateObj.data };
}

export async function deleteUserState(senderId: string | number): Promise<void> {
  if (testOverrideDeleteUserState) {
    await testOverrideDeleteUserState(senderId);
    return;
  }
  const sId = String(senderId);

  const states = readUserStatesFromFile();
  if (states[sId]) {
    delete states[sId];
    writeUserStatesToFile(states);
  }

  if (supabase) {
    try {
      await supabase.from("telegram_user_states").delete().eq("sender_id", sId);
    } catch {
      // Best effort.
    }
  }
}