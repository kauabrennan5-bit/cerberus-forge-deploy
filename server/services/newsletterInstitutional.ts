import {
  INSTITUTIONAL_PATHS,
  SOCIAL_LABELS,
  type SocialNetwork,
} from "../../src/config/institutional";
import type { Product } from "../../src/types";
import { resolveCanonicalProductImage } from "../../src/lib/productCanonical";
import type { NewsletterSocialLink } from "./newsletterCampaignTemplate";
import { emptySocialLinkConfig, readCanonicalSocialLinks, SOCIAL_NETWORKS, type SocialLinksClient } from "./socialLinks";

export const DEFAULT_PUBLIC_SITE_URL = "https://cerberus-design-static.onrender.com";

export function resolvePublicSiteUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = (env.PUBLIC_SITE_URL || DEFAULT_PUBLIC_SITE_URL).trim();
  try {
    const url = new URL(configured);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("PUBLIC_SITE_URL_PROTOCOL_INVALID");
    return url.toString().replace(/\/$/, "");
  } catch {
    return DEFAULT_PUBLIC_SITE_URL;
  }
}

export function buildInstitutionalUrl(path: string, env: NodeJS.ProcessEnv = process.env): string {
  return new URL(path, `${resolvePublicSiteUrl(env)}/`).toString();
}

export const DEFAULT_NEWSLETTER_ASSET_BASE_URL = "https://cerberus-forge-deploy-backend.onrender.com";

export function resolveNewsletterAssetBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = (env.NEWSLETTER_PUBLIC_ASSET_BASE_URL || env.NEWSLETTER_PUBLIC_BASE_URL || DEFAULT_NEWSLETTER_ASSET_BASE_URL).trim();
  try {
    const url = new URL(configured);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("NEWSLETTER_ASSET_BASE_URL_PROTOCOL_INVALID");
    return url.toString().replace(/\/$/, "");
  } catch {
    return DEFAULT_NEWSLETTER_ASSET_BASE_URL;
  }
}

export function buildNewsletterAssetUrl(path: string, env: NodeJS.ProcessEnv = process.env): string {
  return new URL(path.replace(/^\/+/, ""), `${resolveNewsletterAssetBaseUrl(env)}/`).toString();
}

const NEWSLETTER_SOCIAL_ICON_PATHS: Record<SocialNetwork, string> = {
  instagram: "assets/newsletter/social/instagram.png",
  tiktok: "assets/newsletter/social/tiktok.png",
  facebook: "assets/newsletter/social/facebook.png",
  youtube: "assets/newsletter/social/youtube.png",
  x: "assets/newsletter/social/x.png",
  pinterest: "assets/newsletter/social/pinterest.png",
};

/**
 * Resolve o hero diretamente do registro canônico do produto. A ordem de
 * `products.imagens` é a convenção de prioridade; não existe cadastro manual
 * por product ID nem dependência de asset editorial para um produto aparecer.
 */
export function getNewsletterHeroImageUrl(
  product: Pick<Product, "imagens">,
  _env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return resolveCanonicalProductImage(product).primaryImageUrl;
}

export async function getNewsletterInstitutionalOptions(
  env: NodeJS.ProcessEnv = process.env,
  socialClient?: SocialLinksClient | null,
): Promise<{
  privacyUrl: string;
  termsUrl: string;
  socialLinks: NewsletterSocialLink[];
}> {
  let socialConfig = emptySocialLinkConfig();
  try {
    socialConfig = await readCanonicalSocialLinks(socialClient);
  } catch (error: any) {
    console.warn("[Institutional] Links sociais indisponíveis; usando configuração vazia:", error?.code || "read_failed");
  }
  return {
    privacyUrl: buildInstitutionalUrl(INSTITUTIONAL_PATHS.privacy, env),
    termsUrl: buildInstitutionalUrl(INSTITUTIONAL_PATHS.terms, env),
    socialLinks: SOCIAL_NETWORKS.map(network => ({
      label: SOCIAL_LABELS[network],
      url: socialConfig[network].trim(),
      iconUrl: buildNewsletterAssetUrl(NEWSLETTER_SOCIAL_ICON_PATHS[network], env),
    })),
  };
}
