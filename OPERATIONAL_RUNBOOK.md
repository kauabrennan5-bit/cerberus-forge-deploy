# Cerberus Finds — Runbook Operacional

## Contrato de correlação

As operações críticas recebem um identificador correlacionável: `PUB-*` para publicação de produto, `SYNC-*` para sincronização de catálogo, `HC-*` para health checks e `HEAL-*` quando uma ação de recuperação precisar ser acrescentada ao contrato. O identificador pode aparecer em lifecycle, logs sanitizados, resultado da sincronização e incidente; ele nunca contém segredo.

## Cadeia de publicação

```text
Telegram autorizado → lifecycle APPROVED
→ public.products (approved/inativo)
→ promoção controlada para published/ativo
→ exportação de public/data/products.json
→ commit GitHub/main com SHA retornado
→ validação de IDs no Static Site
```

O catálogo só é considerado publicado quando o JSON público contém exatamente os IDs de produtos `published` e `ativo`. IDs faltantes ou órfãos constituem divergência. Se a validação pública falhar, o produto é marcado como `error` e inativo; o pipeline tenta sincronizar essa compensação sem exclusão física.

| Etapa | Código de falha | Ação esperada |
|---|---|---|
| Leitura/gravação canônica | `SUPABASE_PERSISTENCE_ERROR` | Investigar configuração, RLS, conectividade ou schema sem usar fallback local. |
| Exportação | `CATALOG_GENERATION_ERROR` | Revalidar filtros e artefato local. |
| Autenticação GitHub | `GITHUB_AUTH_ERROR` | Confirmar token server-side e permissão mínima Contents R/W. |
| Escrita GitHub | `GITHUB_SYNC_ERROR` | Investigar API, conflito ou branch main. |
| Catálogo público | `PUBLIC_CATALOG_VALIDATION_ERROR` | Conferir SHA, Static Site e propagação; não declarar publicação. |

## Health checks e recovery

O Operator verifica Backend, Supabase, Produtos, Catálogo, Lifecycle, Tracking, Analytics, Telegram, Site, Deploy e GitHub. Tracking e Analytics fazem apenas `SELECT ... LIMIT 1`; nenhum health check gera clique, produto ou alteração no Supabase.

O estado de Deploy é deliberadamente `UNKNOWN` sem uma integração autenticada da API do Render. Site e catálogo são indicadores separados e não autorizam inferir que um deploy específico foi concluído.

As ações de auto-heal pertencem a um registry fechado. Elas possuem risco, pré-condições, timeout, retry, cooldown, circuit breaker, validação e rollback quando aplicável. Ações não registradas, shell, SQL dinâmico, secrets, schema e exclusão em massa não são suportados. Uma recuperação é válida somente após health check pós-ação com o componente afetado em `HEALTHY`.

## Telegram como centro operacional

Todos os callbacks e comandos administrativos passam pela whitelist configurada. Publicações não exibem exceções brutas: falhas estruturadas apresentam código, operation ID, etapa, dependência, impacto e recuperabilidade. O painel administrativo consulta o health check real, e não estados fixos.

## Segurança e limitações

Supabase Service Role, GitHub token, Telegram bot token, segredo de webhook, Meta access token e JSON de Service Account GA4 pertencem somente ao ambiente server-side. O repositório contém apenas nomes de variáveis em `.env.example`.

`TELEGRAM_WEBHOOK_SECRET` é opcional para compatibilidade, mas recomendado. Quando estiver configurado no Render, o webhook exige o header oficial do Telegram e o endpoint de configuração o envia como `secret_token`. A criação do segredo e a rotação de token são responsabilidades administrativas fora do repositório.

O histórico, incidentes e aprovações do Operator permanecem em memória. Uma reinicialização do Web Service remove esse histórico; não substitui produtos, cliques ou catálogo como fontes de verdade.
