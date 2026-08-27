import type { SupabaseClient } from "@supabase/supabase-js";
import {
  SOCIAL_LABELS,
  SOCIAL_LINKS,
  type SocialLinkConfig,
  type SocialNetwork,
} from "../../src/config/institutional";
import { supabase as productsSupabase } from "../repositories/productsRepository";

export const SOCIAL_NETWORKS: readonly SocialNetwork[] = Object.keys(SOCIAL_LABELS) as SocialNetwork[];

export type SocialLinksClient = Pick<SupabaseClient, "from">;

type SocialLinkRow = {
  network?: unknown;
  url?: unknown;
};

export type PublicSocialLink = {
  network: SocialNetwork;
  label: string;
  url: string;
};

export function isSocialNetwork(value: unknown): value is SocialNetwork {
  return typeof value === "string" && SOCIAL_NETWORKS.includes(value as SocialNetwork);
}

/**
 * Links sociais são destinos públicos e devem ser HTTPS, sem credenciais
 * embutidas. O valor canônico é preservado depois da validação.
 */
export function normalizeSocialLinkUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || /\s/.test(raw)) return null;

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

export function emptySocialLinkConfig(): SocialLinkConfig {
  return { ...SOCIAL_LINKS };
}

export async function readCanonicalSocialLinks(
  client: SocialLinksClient | null = productsSupabase,
): Promise<SocialLinkConfig> {
  const config = emptySocialLinkConfig();
  if (!client) return config;

  const { data, error } = await client
    .from("social_links")
    .select("network,url")
    .order("network", { ascending: true })
    .limit(20);

  if (error) {
    // Compatibilidade durante rollout: uma versão antiga sem a migration
    // continua funcionando com os espaços sociais vazios. Escritas seguem
    // falhando fechadas em `upsertCanonicalSocialLink`.
    if (error.code === "PGRST205" || error.code === "42P01") return config;
    throw error;
  }

  for (const row of (data || []) as SocialLinkRow[]) {
    if (!isSocialNetwork(row.network)) continue;
    const url = normalizeSocialLinkUrl(row.url);
    if (url) config[row.network] = url;
  }

  return config;
}

export async function listPublicSocialLinks(
  client: SocialLinksClient | null = productsSupabase,
): Promise<PublicSocialLink[]> {
  const config = await readCanonicalSocialLinks(client);
  return SOCIAL_NETWORKS
    .map(network => ({ network, label: SOCIAL_LABELS[network], url: config[network] }))
    .filter(link => Boolean(link.url));
}

export async function upsertCanonicalSocialLink(
  network: SocialNetwork,
  url: string,
  client: SocialLinksClient | null = productsSupabase,
): Promise<void> {
  if (!isSocialNetwork(network)) throw new Error("SOCIAL_NETWORK_INVALID");
  const normalizedUrl = normalizeSocialLinkUrl(url);
  if (!normalizedUrl) throw new Error("SOCIAL_LINK_URL_INVALID");
  if (!client) throw new Error("SOCIAL_LINKS_STORAGE_UNAVAILABLE");

  const { error } = await client
    .from("social_links")
    .upsert({ network, url: normalizedUrl, updated_at: new Date().toISOString() }, { onConflict: "network" });
  if (error) throw error;
}

export async function removeCanonicalSocialLink(
  network: SocialNetwork,
  client: SocialLinksClient | null = productsSupabase,
): Promise<void> {
  if (!isSocialNetwork(network)) throw new Error("SOCIAL_NETWORK_INVALID");
  if (!client) throw new Error("SOCIAL_LINKS_STORAGE_UNAVAILABLE");

  const { error } = await client.from("social_links").delete().eq("network", network);
  if (error) throw error;
}
