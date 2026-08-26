export const INSTITUTIONAL_PATHS = {
  privacy: "/politica-de-privacidade",
  terms: "/termos-e-condicoes",
} as const;

export type SocialNetwork = "instagram" | "tiktok" | "facebook" | "youtube" | "x" | "pinterest";

export type SocialLinkConfig = Record<SocialNetwork, string>;

/**
 * URLs sociais deliberadamente vazias até que os perfis oficiais sejam
 * informados. O template ignora valores vazios e nunca cria links fictícios.
 */
export const SOCIAL_LINKS: SocialLinkConfig = {
  instagram: "",
  tiktok: "",
  facebook: "",
  youtube: "",
  x: "",
  pinterest: "",
};

export const SOCIAL_LABELS: Record<SocialNetwork, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  facebook: "Facebook",
  youtube: "YouTube",
  x: "X",
  pinterest: "Pinterest",
};

export function getConfiguredSocialLinks(config: SocialLinkConfig = SOCIAL_LINKS): Array<{ label: string; url: string; network: SocialNetwork }> {
  return (Object.keys(config) as SocialNetwork[])
    .map(network => ({ network, label: SOCIAL_LABELS[network], url: config[network].trim() }))
    .filter(link => /^https?:\/\/[^\s]+$/i.test(link.url));
}
