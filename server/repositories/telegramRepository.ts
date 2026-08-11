import fs from "fs";
import path from "path";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { PendingReview } from "../services/telegramBot";

dotenv.config();

const DATA_DIR = path.join(process.cwd(), "data");
const REVIEWS_FILE = path.join(DATA_DIR, "telegram_reviews.json");
const USER_STATES_FILE = path.join(DATA_DIR, "telegram_user_states.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Expiração Padrão da Sessão de Revisão: 1 hora (3.600.000 ms)
const SESSION_EXPIRATION_MS = 60 * 60 * 1000;

// Supabase Client Initialization
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

export const supabase: SupabaseClient | null = (supabaseUrl && supabaseKey)
  ? createClient(supabaseUrl, supabaseKey)
  : null;

export interface UserState {
  senderId: string;
  action: "awaiting_price";
  reviewId: string;
  updatedAt: number;
}

/**
 * Lê do arquivo de revisões com fallback seguro
 */
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

/**
 * Grava no arquivo de revisões
 */
function writeReviewsToFile(reviews: Record<string, PendingReview>): void {
  try {
    fs.writeFileSync(REVIEWS_FILE, JSON.stringify(reviews, null, 2), "utf-8");
  } catch (err) {
    console.error("[Telegram Repo] Erro ao salvar telegram_reviews.json:", err);
  }
}

/**
 * Lê estados dos usuários do arquivo
 */
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

/**
 * Grava estados dos usuários no arquivo
 */
function writeUserStatesToFile(states: Record<string, UserState>): void {
  try {
    fs.writeFileSync(USER_STATES_FILE, JSON.stringify(states, null, 2), "utf-8");
  } catch (err) {
    console.error("[Telegram Repo] Erro ao salvar telegram_user_states.json:", err);
  }
}

// --- MÉTODOS PÚBLICOS DE PERSISTÊNCIA ---

/**
 * Salva ou atualiza uma revisão pendente (no arquivo e Supabase se disponível)
 */
export async function savePendingReview(review: PendingReview): Promise<void> {
  // 1. Salva no arquivo local
  const reviews = readReviewsFromFile();
  reviews[review.id] = review;
  writeReviewsToFile(reviews);

  // 2. Tenta salvar no Supabase se configurado
  if (supabase) {
    try {
      const { error } = await supabase.from("telegram_pending_reviews").upsert({
        id: review.id,
        chat_id: String(review.chatId),
        sender_id: String(review.senderId),
        first_name: review.firstName,
        username: review.username,
        created_at: review.createdAt,
        data: review
      }, { onConflict: "id" });

      if (error && error.code !== "PGRST205") { // Ignora se tabela não existir ainda
        console.warn("[Telegram Repo Warning] Erro ao salvar revisão no Supabase:", error.message);
      }
    } catch (err: any) {
      console.warn("[Telegram Repo Warning] Falha na conexão com Supabase:", err?.message);
    }
  }
}

/**
 * Obtém uma revisão pendente por ID (verifica expiração de 1 hora)
 */
export async function getPendingReview(reviewId: string): Promise<PendingReview | null> {
  let review: PendingReview | null = null;

  // 1. Tenta buscar no Supabase
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("telegram_pending_reviews")
        .select("data, created_at")
        .eq("id", reviewId)
        .single();

      if (!error && data?.data) {
        review = data.data as PendingReview;
      }
    } catch (err) {
      // Fallback para arquivo local se Supabase falhar
    }
  }

  // 2. Se não encontrou no Supabase, busca no arquivo local
  if (!review) {
    const reviews = readReviewsFromFile();
    review = reviews[reviewId] || null;
  }

  if (!review) return null;

  // 3. Validação de expiração (1 hora)
  const now = Date.now();
  if (now - review.createdAt > SESSION_EXPIRATION_MS) {
    console.log(`[Telegram Repo] Sessão de revisão ${reviewId} expirou (${Math.round((now - review.createdAt)/1000)}s decorridos). Deletando.`);
    await deletePendingReview(reviewId);
    return null;
  }

  return review;
}

/**
 * Obtém a revisão pendente mais recente para um determinado usuário ou chat (não expirada)
 */
export async function getLatestPendingReviewForUser(
  senderId: string | number,
  chatId?: string | number
): Promise<PendingReview | null> {
  const sId = String(senderId);
  const cId = chatId ? String(chatId) : null;
  const now = Date.now();

  // 1. Tenta buscar no Supabase se disponível
  if (supabase) {
    try {
      let query = supabase
        .from("telegram_pending_reviews")
        .select("data, created_at")
        .order("created_at", { ascending: false });

      if (cId) {
        query = query.or(`sender_id.eq.${sId},chat_id.eq.${cId}`);
      } else {
        query = query.eq("sender_id", sId);
      }

      const { data, error } = await query.limit(1);

      if (!error && data && data.length > 0 && data[0].data) {
        const rev = data[0].data as PendingReview;
        if (now - rev.createdAt <= SESSION_EXPIRATION_MS) {
          return rev;
        }
      }
    } catch {
      // Fallback para o arquivo local
    }
  }

  // 2. Fallback para arquivo local
  const reviews = readReviewsFromFile();
  const userReviews = Object.values(reviews).filter((r) => {
    const matchUser = String(r.senderId) === sId || (cId && String(r.chatId) === cId);
    const valid = now - r.createdAt <= SESSION_EXPIRATION_MS;
    return matchUser && valid;
  });

  if (userReviews.length === 0) return null;

  userReviews.sort((a, b) => b.createdAt - a.createdAt);
  return userReviews[0];
}

/**
 * Remove uma revisão pendente (após publicação ou cancelamento)
 */
export async function deletePendingReview(reviewId: string): Promise<void> {
  // 1. Remove do arquivo local
  const reviews = readReviewsFromFile();
  if (reviews[reviewId]) {
    delete reviews[reviewId];
    writeReviewsToFile(reviews);
  }

  // 2. Remove do Supabase
  if (supabase) {
    try {
      await supabase.from("telegram_pending_reviews").delete().eq("id", reviewId);
    } catch (err) {
      // Ignora erro de exclusão no Supabase
    }
  }
}

/**
 * Define o estado do usuário (ex: aguardando digitação de preço)
 */
export async function setUserState(senderId: string | number, state: { action: "awaiting_price"; reviewId: string }): Promise<void> {
  const sId = String(senderId);
  const userStateObj: UserState = {
    senderId: sId,
    action: state.action,
    reviewId: state.reviewId,
    updatedAt: Date.now()
  };

  // 1. Salva no arquivo local
  const states = readUserStatesFromFile();
  states[sId] = userStateObj;
  writeUserStatesToFile(states);

  // 2. Salva no Supabase se disponível
  if (supabase) {
    try {
      await supabase.from("telegram_user_states").upsert({
        sender_id: sId,
        action: state.action,
        review_id: state.reviewId,
        updated_at: userStateObj.updatedAt
      }, { onConflict: "sender_id" });
    } catch (err) {
      // Ignora erro no Supabase
    }
  }
}

/**
 * Obtém o estado atual do usuário
 */
export async function getUserState(senderId: string | number): Promise<{ action: "awaiting_price"; reviewId: string } | null> {
  const sId = String(senderId);
  let stateObj: UserState | null = null;

  // 1. Busca no Supabase
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
          updatedAt: data.updated_at || Date.now()
        };
      }
    } catch (err) {
      // Fallback
    }
  }

  // 2. Fallback para arquivo local
  if (!stateObj) {
    const states = readUserStatesFromFile();
    stateObj = states[sId] || null;
  }

  if (!stateObj) return null;

  // 3. Expira estados mais antigos que 1 hora
  if (Date.now() - stateObj.updatedAt > SESSION_EXPIRATION_MS) {
    await deleteUserState(senderId);
    return null;
  }

  return { action: stateObj.action, reviewId: stateObj.reviewId };
}

/**
 * Remove o estado do usuário
 */
export async function deleteUserState(senderId: string | number): Promise<void> {
  const sId = String(senderId);

  // 1. Remove do arquivo local
  const states = readUserStatesFromFile();
  if (states[sId]) {
    delete states[sId];
    writeUserStatesToFile(states);
  }

  // 2. Remove do Supabase
  if (supabase) {
    try {
      await supabase.from("telegram_user_states").delete().eq("sender_id", sId);
    } catch (err) {
      // Ignora
    }
  }
}
