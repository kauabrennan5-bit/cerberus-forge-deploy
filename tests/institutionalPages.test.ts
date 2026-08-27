import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InstitutionalPage } from "../src/components/InstitutionalPage.tsx";
import { getConfiguredSocialLinks, INSTITUTIONAL_PATHS, SOCIAL_LINKS } from "../src/config/institutional.ts";

const pageProps = {
  onBackToSite: () => undefined,
  onNavigate: () => undefined,
};

test("privacy page renders institutional sections and explicit legal placeholders", () => {
  const html = renderToStaticMarkup(React.createElement(InstitutionalPage, { ...pageProps, kind: "privacy" }));
  assert.match(html, /Política de Privacidade/);
  assert.match(html, /Newsletter, consentimento e descadastro/);
  assert.match(html, /operação individual apresentada publicamente sob a marca Cerberus Finds/);
  assert.equal(html.includes("[INSERIR RAZÃO SOCIAL]"), false);
  assert.equal(html.includes("[INSERIR CNPJ]"), false);
  assert.equal(html.includes("[INSERIR ENDEREÇO]"), false);
  assert.equal(html.includes("[INSERIR E-MAIL DE CONTATO]"), false);
  assert.match(html, /link individual de descadastro/);
  assert.doesNotMatch(html, /BREVO_API_KEY|Supabase|Brevo/);
  assert.match(html, /Política de Privacidade foi atualizada em/);
});

test("terms page renders required editorial and third-party sections without invented jurisdiction", () => {
  const html = renderToStaticMarkup(React.createElement(InstitutionalPage, { ...pageProps, kind: "terms" }));
  assert.match(html, /Termos e Condições/);
  assert.match(html, /Produtos, ofertas e preços/);
  assert.match(html, /Links de terceiros e afiliados/);
  assert.match(html, /operação individual apresentada publicamente sob a marca Cerberus Finds/);
  assert.equal(html.includes("[INSERIR RAZÃO SOCIAL E CNPJ]"), false);
  assert.equal(html.includes("[INSERIR APÓS CONFIRMAÇÃO DA OPERAÇÃO E DA JURISDIÇÃO]"), false);
  assert.match(html, /Termos e Condições foram atualizados em/);
  assert.match(html, new RegExp(INSTITUTIONAL_PATHS.privacy.replaceAll("/", "\\/")));
  assert.match(html, new RegExp(INSTITUTIONAL_PATHS.terms.replaceAll("/", "\\/")));
});

test("institutional page renders configured social links as real anchors", () => {
  const html = renderToStaticMarkup(React.createElement(InstitutionalPage, {
    ...pageProps,
    kind: "privacy",
    socialLinks: [{ network: "instagram", label: "Instagram", url: "https://instagram.com/cerberusfinds" }],
  }));
  assert.match(html, /href="https:\/\/instagram\.com\/cerberusfinds"/);
  assert.match(html, /Instagram/);
  assert.doesNotMatch(html, /href=""/);
});

test("social configuration starts empty and does not produce broken links", () => {
  assert.deepEqual(SOCIAL_LINKS, {
    instagram: "",
    tiktok: "",
    facebook: "",
    youtube: "",
    x: "",
    pinterest: "",
  });
  assert.deepEqual(getConfiguredSocialLinks(), []);
  const html = renderToStaticMarkup(React.createElement(InstitutionalPage, { ...pageProps, kind: "privacy" }));
  assert.equal(html.includes('href=""'), false);
  assert.match(html, /Instagram ainda não configurado/);
  assert.match(html, /TikTok ainda não configurado/);
  assert.match(html, /Facebook ainda não configurado/);
});
