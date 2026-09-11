# Cerberus — auditoria de migração (2026-09-11)

## Estado confirmado

- Storefront público: Cloudflare Pages `cerberus-finds.pages.dev`, deploy por GitHub Actions.
- Render static e backend: suspensos por billing; não são considerados runtime de produção.
- Supabase novo: projeto `ppsxlclycyinhhoqijvz`; Edge Function `cerberus-public-api` ativa.
- Catálogo legado sanitizado: 30 produtos em `public/data/products.json`.
- Banco novo: 30 linhas em `public.products`, todas `status=published`, `ativo=false`; zero autorizações persistidas em `product_publication_authorizations`.

## Implementado nesta etapa

1. O deploy Cloudflare publica `deploy-meta.json` com o SHA exato e valida root, catálogo e metadados após cada deploy.
2. O gate de promoção de catálogo deixa de aguardar Render e passa a aguardar o mesmo SHA em Cloudflare Pages.
3. Builds sem uma fonte canônica explicitamente configurada preservam o snapshot versionado em vez de tentar o projeto Supabase antigo.
4. Workflows ainda dependentes do backend Render ficam fail-closed para execução automática enquanto `CERBERUS_RENDER_RUNTIME_ENABLED` não for explicitamente `true`; dispatch manual continua disponível onde já existia.
5. O verificador de SHA do Render passa a ficar inativo por padrão, evitando falhas em cada merge de `main`.
6. A Edge Function pública do Supabase passa a exigir o mesmo princípio de elegibilidade: revisão editorial estrita para linhas não governadas por Telegram/Curator, ou prova humana atual e ligada à imagem para linhas governadas.

## Ainda não migrado

- Telegram: a função Edge `cerberus-telegram-gateway` do repositório ainda encaminha para Render e não está implantada no Supabase novo.
- Curator: os jobs ainda chamam endpoints internos do backend Node; não existe runner serverless independente.
- Newsletter/Audience/Operator/Watchdog: mesma dependência do backend Node. Os agendamentos automáticos legados ficam desativados por padrão nesta fase para não chamar um Render suspenso.
- APIs dinâmicas do frontend (newsletter signup, click tracking, Meta CAPI, social links e admin) ainda não possuem substituto serverless completo.
- Supabase novo ainda não tem prova histórica suficiente para reativar os 30 produtos: `created_by`, `human_editorial_review_id` e `human_editorial_authorization_id` estão ausentes, e `product_publication_authorizations` está vazio. Não deve haver backfill inventado.
- O ledger de migrations do projeto novo não representa o histórico do repositório; o schema deve ser reconciliado sem reaplicar migrations destrutivamente.
- Domínio customizado `cerberusfinds.com` ainda precisa de cutover/validação separado.

## Regra de segurança

Nenhum produto deve ser ativado no Supabase novo sem evidência válida de autorização humana. Nenhuma newsletter real deve ser enviada durante a migração.
