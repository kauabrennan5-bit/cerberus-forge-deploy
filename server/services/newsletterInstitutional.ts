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
    })),
  };
}
