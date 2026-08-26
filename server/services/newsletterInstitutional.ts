import {
  INSTITUTIONAL_PATHS,
  SOCIAL_LABELS,
  SOCIAL_LINKS,
  type SocialNetwork,
} from "../../src/config/institutional";
import type { NewsletterSocialLink } from "./newsletterCampaignTemplate";

export function resolvePublicSiteUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = (env.PUBLIC_SITE_URL || "https://cerberusfinds.com").trim();
  try {
    const url = new URL(configured);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("PUBLIC_SITE_URL_PROTOCOL_INVALID");
    return url.toString().replace(/\/$/, "");
  } catch {
    return "https://cerberusfinds.com";
  }
}

export function buildInstitutionalUrl(path: string, env: NodeJS.ProcessEnv = process.env): string {
  return new URL(path, `${resolvePublicSiteUrl(env)}/`).toString();
}

export function buildNewsletterAssetUrl(path: string, env: NodeJS.ProcessEnv = process.env): string {
  return new URL(path.replace(/^\/+/, ""), `${resolvePublicSiteUrl(env)}/`).toString();
}

const NEWSLETTER_SOCIAL_ICON_PATHS: Record<SocialNetwork, string> = {
  instagram: "assets/newsletter/social/instagram.png",
  tiktok: "assets/newsletter/social/tiktok.png",
  facebook: "assets/newsletter/social/facebook.png",
  youtube: "assets/newsletter/social/youtube.png",
  x: "assets/newsletter/social/x.png",
  pinterest: "assets/newsletter/social/pinterest.png",
};

const NEWSLETTER_CLEAN_HERO_PATHS: Record<string, string> = {
  "prod-1787414659793": "assets/newsletter/products/luminaria-bauhaus-clean.png",
};

export function getNewsletterHeroImageUrl(productId: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const path = NEWSLETTER_CLEAN_HERO_PATHS[productId];
  return path ? buildNewsletterAssetUrl(path, env) : undefined;
}

export function getNewsletterInstitutionalOptions(env: NodeJS.ProcessEnv = process.env): {
  privacyUrl: string;
  termsUrl: string;
  socialLinks: NewsletterSocialLink[];
} {
  const networks = Object.keys(SOCIAL_LINKS) as SocialNetwork[];
  return {
    privacyUrl: buildInstitutionalUrl(INSTITUTIONAL_PATHS.privacy, env),
    termsUrl: buildInstitutionalUrl(INSTITUTIONAL_PATHS.terms, env),
    socialLinks: networks.map(network => ({
      label: SOCIAL_LABELS[network],
      url: SOCIAL_LINKS[network].trim(),
      iconUrl: buildNewsletterAssetUrl(NEWSLETTER_SOCIAL_ICON_PATHS[network], env),
    })),
  };
}
