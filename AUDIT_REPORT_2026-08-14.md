# Cerberus Finds Archive — Relatório de Auditoria Operacional Profunda

**Data:** 14 de agosto de 2026  
**Escopo:** consolidação técnica dos Blocos 1–7, sem criação de produtos, cliques artificiais, alterações de schema ou fallback local de dados.  
**Branch auditada e publicada:** `main`  
**Commits publicados:** [`138e135`](https://github.com/kauabrennan5-bit/cerberus-forge-deploy/commit/138e1352891c2a6f3183a188b860ccc32c8221b3) (correções) e [`348c288`](https://github.com/kauabrennan5-bit/cerberus-forge-deploy/commit/348c288552d5caa724fda0d2035663438ced8a20) (evidência de produção).

> **Conclusão executiva:** a base local foi fortalecida de forma material. A publicação deixa de tratar commit GitHub, HTTP genérico ou término de ação como sucesso final; agora ela exige diagnóstico de etapa, correlação operacional e confirmação bilateral do catálogo público. A vitrine, a API e `products.json` foram confirmados em leitura com **10 produtos**. A identificação do deploy exato do Render e a disponibilidade do domínio personalizado permanecem pendências explicitamente registradas, sem alegação de sucesso não comprovado.

## 1. Estado comprovado no início e na conclusão

| Elemento | Estado confirmado |
|---|---|
| Repositório | `kauabrennan5-bit/cerberus-forge-deploy` |
| Branch operacional | `main` |
| Fonte canônica de produtos e cliques | Supabase (`public.products` e `public.product_clicks`) |
| Projeção pública | `public/data/products.json` versionado e servido pelo Static Site |
| API de produção consultada | `https://cerberus-forge-deploy-backend.onrender.com/api/products` |
| Resultado da API | `success: true`, 10 produtos, incluindo `REF-009` e `REF-010` |
| JSON público consultado | 10 IDs, `REF-009` e `REF-010` uma vez cada |
| Vitrine estática consultada | `ACERVO (10)` e cards 001–010 renderizados |

A evidência detalhada e somente leitura encontra-se em [`AUDIT_PRODUCTION_READONLY_EVIDENCE.md`](./AUDIT_PRODUCTION_READONLY_EVIDENCE.md). A auditoria não enviou mensagens ao Telegram, não publicou produtos, não registrou cliques e não realizou operação destrutiva no Supabase.

## 2. Divergências e riscos encontrados

| Área | Achado comprovado | Risco anterior | Tratamento aplicado |
|---|---|---|---|
| Diagnósticos | Erros distintos eram condensados em mensagens genéricas de conectividade. | Investigação lenta e falso entendimento de disponibilidade. | Criado contrato tipado de diagnósticos, dependência, etapa, impacto, causa provável, HTTP status e recuperabilidade. |
| Publicação | O pipeline podia persistir como `published` antes da validação pública final. | Produto com estado canônico incompatível com a vitrine. | Criação em `approved`/inativo, promoção controlada, validação pública e compensação não destrutiva para `error`/inativo quando necessário. |
| Catálogo | A validação verificava apenas IDs ausentes. | Produto órfão poderia continuar visível após remoção/arquivamento. | Validação bilateral: IDs publicados ausentes **e** IDs públicos órfãos impedem sucesso. |
| GitHub | Writer retornava booleano, sem SHA ou taxonomia de falha. | Bot poderia comunicar resultado sem prova de commit. | Resultado estruturado com SHA do commit e distinção entre `GITHUB_AUTH_ERROR` e `GITHUB_SYNC_ERROR`. |
| Health check | Tracking era declarado saudável de modo sintético; Deploy era inferido pelo JSON público. | Falso positivo operacional. | Tracking consulta `public.product_clicks` em modo leitura; Deploy fica `UNKNOWN` sem API autenticada do Render. |
| Recovery | Ação `SUCCESS` encerrava incidente sem confirmar efeito. | Auto-heal declarado concluído sem recuperação real. | Health check pós-ação obrigatório; incidente só é `RESOLVED` se o componente retornar `HEALTHY`. |
| Reativação | Reativação aplicava estado `approved`. | Produto ativo podia permanecer fora da projeção publicada. | Reativação passa a usar `published`. |
| Segurança do scraper | Redirecionamentos eram seguidos sem validação de cada destino. | SSRF e ingestão fora da allowlist. | Redirecionamento manual, limite de três saltos, validação de protocolo/rede privada e allowlist por etapa. |
| Credenciais | Havia token Telegram em documentação versionada. | Exposição de credencial. | Referência removida, token rotacionado pelo administrador e varredura final sem padrões de token em arquivos versionados. |

## 3. Contrato operacional implementado

Cada operação recebe identificação correlacionável: `PUB-*`, `SYNC-*`, `HC-*` ou `HEAL-*`. O valor é anexado a lifecycle, sincronização, incidentes e mensagens administrativas, sem incorporar segredo.

| Etapa operacional | Código de falha | Significado |
|---|---|---|
| Supabase | `SUPABASE_PERSISTENCE_ERROR` | Persistência ou leitura canônica não confirmada. |
| Exportação | `CATALOG_GENERATION_ERROR` | `products.json` não foi gerado de forma válida. |
| Autenticação GitHub | `GITHUB_AUTH_ERROR` | Token ausente, inválido, expirado ou sem permissão mínima. |
| Escrita GitHub | `GITHUB_SYNC_ERROR` | Commit/atualização em `main` não confirmado. |
| Catálogo público | `PUBLIC_CATALOG_VALIDATION_ERROR` | Static Site não confirmou a projeção esperada. |
| Persistência de lifecycle | `PERSISTENCE_ERROR` | Produto ou transição canônica não persistiu. |

O fluxo de catálogo agora é serializado para reduzir competição entre mutações concorrentes. O sucesso exige a cadeia `Supabase → exportação → GitHub/main → Static Site`, com correspondência exata entre os IDs publicados e o conteúdo público. Não existe fallback local para catálogo ou analytics.

## 4. Cerberus Operator e Telegram

O Operator registra incidentes com `operationId`, etapa, dependência, causa provável, impacto, recuperabilidade e HTTP status quando disponível. Incidentes abertos incluem os estados `OPEN`, `INVESTIGATING`, `AUTO_FIXING`, `REQUIRES_APPROVAL` e `ESCALATED` na deduplicação, evitando a criação de incidentes repetidos durante uma correção em andamento.

O Action Registry permanece fechado e determinístico. Ações possuem risco, pré-condições, timeout, retry, cooldown, circuit breaker, validação e rollback quando aplicável. Não foram introduzidos shell arbitrário, SQL dinâmico, execução de código em texto, modificação automática de credenciais ou alteração de schema.

O painel administrativo Telegram deixou de exibir um resumo com estados fixos: ele consulta o health check real e mostra o operation ID. Falhas de publicação usam o diagnóstico estruturado em vez de repassar exceções brutas.

## 5. Segurança aplicada

As rotas de produtos passam a falhar explicitamente com `503` e `SUPABASE_PERSISTENCE_ERROR` quando a fonte canônica não pode ser lida; elas não retornam mais uma lista vazia que possa ser interpretada como catálogo saudável. O endpoint de tracking rejeita produto desconhecido e não cria analytics para IDs arbitrários.

Foram acrescentados timeouts às chamadas da API Telegram, Meta CAPI, Google Apps Script e proxy CSV. O webhook Telegram aceita o header de segredo oficial quando `TELEGRAM_WEBHOOK_SECRET` estiver configurado no ambiente; nenhum valor foi criado automaticamente. A rota de dados estáticos limita a resolução ao diretório `dist/data`, e rotas de status não expõem IDs de usuários autorizados ou prefixo de Deploy Hook.

## 6. Validações executadas

| Validação | Resultado |
|---|---|
| `npm install` | Concluído; 295 pacotes auditados, 0 vulnerabilidades reportadas pelo npm. |
| `npm run lint` | PASSOU (`tsc --noEmit`). |
| `npm test` | PASSOU: 41 testes, 41 aprovados, 0 falhas. |
| `npm run build` | PASSOU: geração do catálogo, Vite e bundle `dist/server.cjs`. |
| Artefato final | `dist/data/products.json` presente com 10 produtos. |
| `git diff --check` | PASSOU, sem erro de whitespace. |
| Varredura de segredo em arquivos rastreados | Nenhum padrão de token/chave privada encontrado após a redação documental. |
| GitHub | Branch `main` aponta para `348c288`; o commit principal de código é `138e135`. |
| API pública | PASSOU em leitura: 10 produtos. |
| JSON público | PASSOU em leitura: 10 IDs. |
| Vitrine estática | PASSOU em leitura visual: 10 cards. |

## 7. Limitações e pendências residuais

| Limitação | Impacto | Próximo passo seguro |
|---|---|---|
| Render Deploy | Sem API autenticada do Render, o Operator corretamente usa `UNKNOWN`; não prova qual deploy está ativo. | Configurar uma integração de leitura do Render apenas se o administrador desejar essa evidência. |
| Bundle do Static Site | Na última comparação, o hash do bundle público diferia do hash do build local. A vitrine atual funciona, mas não foi possível provar que o bundle corresponde exatamente ao commit `138e135`. | Aguardar/consultar o deploy automático pelo painel ou API do Render; não fazer deploy manual sem solicitação. |
| Domínio `cerberusfinds.com` | Não resolveu DNS no ambiente de auditoria e retornou HTTP `000`; não pode ser declarado operacional. | Revisar DNS e domínio no Render externamente, sem alterar configuração durante esta auditoria. |
| Histórico do Operator | Incidentes, logs e estado de autonomia ainda vivem em memória do Web Service. | Se for desejado, projetar persistência no Supabase em uma etapa separada, com migration justificada. |
| `TELEGRAM_WEBHOOK_SECRET` | O código suporta segredo, mas nenhum valor foi criado automaticamente. | Criar/armazenar o segredo protegido no Render e registrar novamente o webhook por fluxo administrativo. |

## 8. Arquivos centrais alterados

| Arquivo | Resultado |
|---|---|
| `server/services/operationalDiagnostics.ts` | Novo contrato de diagnóstico, sanitização e operation IDs. |
| `server/services/catalogSync.ts` | Fila de sync, validação bilateral, timeout e resultado estruturado. |
| `server/services/githubCatalogSync.ts` | SHA verificável, erro de auth separado e logs sanitizados. |
| `server/services/productPipeline.ts` | Publicação em etapas e compensação sem exclusão física. |
| `server/services/cerberusOperator.ts` | Health checks reais, incidentes ricos e recovery pós-validação. |
| `server/services/telegramBot.ts` | Timeout Telegram, mensagens estruturadas e painel com estado real. |
| `server.ts` | Falha fechada da API, tracking canônico, webhook secret, timeouts e path guard. |
| `server/services/scraper.ts` | Allowlist e redirecionamento seguro. |
| `OPERATIONAL_RUNBOOK.md` | Runbook fiel à implementação e limites conhecidos. |

## 9. Referências

[1] [Commit principal da auditoria — GitHub](https://github.com/kauabrennan5-bit/cerberus-forge-deploy/commit/138e1352891c2a6f3183a188b860ccc32c8221b3)  
[2] [Commit de evidência de produção — GitHub](https://github.com/kauabrennan5-bit/cerberus-forge-deploy/commit/348c288552d5caa724fda0d2035663438ced8a20)  
[3] [API pública de produtos](https://cerberus-forge-deploy-backend.onrender.com/api/products)  
[4] [Catálogo estático público](https://cerberus-static-catalog.onrender.com/data/products.json)  
[5] [Vitrine estática pública](https://cerberus-static-catalog.onrender.com)
