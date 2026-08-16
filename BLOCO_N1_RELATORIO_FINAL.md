# Bloco N1 — Contratos de Descoberta: Relatório Final de Consolidação

**Autor:** Manus AI | **Data:** 16 de agosto de 2026 | **Produção:** `c51fe26` (Render `dep-da0nbr7avr4c73f6js8g`, build `bld-da0nbr7avr4c73f6js90`)

## 1. Objetivo e Escopo Autorizado

O Bloco N1 estabelece o **Registry de Candidatos**: o registro formal de produtos descobertos **antes** de qualquer promoção ao catálogo canônico. O contrato central é indivisível — `CANDIDATE != FACT CANÔNICO` e `OBSERVATION != FACT CANÔNICO`. Um candidato é uma projeção de um achado, nunca um fato; a conversão em produto canônico pertence a outro fluxo (N3/N5), jamais a este bloco. O escopo autorizado contemplava exclusivamente os contratos de descoberta: migration aditiva, repositório de persistência, rotas administrativas formais, comando `/discover` render-only no cockpit Telegram e a bateria de testes correspondente. Não há scraping automatizado nem descoberta ativa em N1 — somente ingestão manual, conforme o requisito do usuário.

## 2. Arquivos Publicados

| Arquivo | Papel |
|---|---|
| `supabase/migrations/20260816_candidates.sql` | Migration aditiva aplicada em produção: tabela `public.candidates` (RLS ON, zero policies públicas, CHECKs fechados, 6 índices aditivos) |
| `server/repositories/candidatesRepository.ts` | Persistência com idempotência real (`listing_key`), `conflict_rejected`, funil fechado, vereditos com motivo obrigatório para negativos, fail-closed, sanitização de metadata/texto |
| `server/routes/candidateRoutes.ts` | Rotas admin: `POST /api/commercial/candidates`, `GET /api/commercial/candidates[/:id]`, `POST /candidates/:id/review`, `POST /candidates/:id/verdict`, `POST /candidates/:id/promote`; `deleteCandidateForProof` deliberadamente não exposto |
| `server/services/commercialCockpit.ts` | `renderDiscover()` — funil de candidatos render-only (CANDIDATE != FACT CANÔNICO em cada linha) |
| `server/services/telegramBot.ts` | Handler `/discover` roteando para `renderDiscover()` |
| `server.ts` | Injeção do client (`setCandidatesClient`) + registro das rotas sob `requireAdminAuth` |
| `tests/candidates.test.ts` | 66 testes novos/ajustados do registry (suíte total 594/594) |

## 3. Banco de Dados (produção)

A migration foi aplicada em produção **antes** do commit, com uma correção pontual de compatibilidade (o bloco idempotente de políticas usava `pg_policy.policyname`, corrigido para `pg_policies` — mesmo padrão da migration de experiments). Verificação autenticada pós-aplicação confirmou o estado esperado:

| Verificação | Resultado |
|---|---|
| Tabela `public.candidates` existe | Sim (20ª tabela do schema público) |
| RLS ativo | Sim — par com `products`, `experiments` e as 4 tabelas de observações |
| Policies públicas | **0** (zero políticas anon/public) |
| Funil fechado (CHECK) | `status` ∈ {DISCOVERED, REVIEWING, APPROVED, REJECTED, INCONCLUSIVE, WITHDRAWN}; `funnel_stage` ∈ {INTAKE, EVIDENCE_OK, AWAITING_REVIEW, REVIEWED, FUNNEL_END} |
| Idempotência | `candidate_id` PK + `listing_key` UNIQUE |
| Proveniência | `source_url`, `evidence_hash`, `collection_method` (catálogo fechado MANUAL/SCRAPE/API/OTHER), `observed_at`, `metadata` JSONB com CHECK de objeto |
| Sem FK para produtos canônicos | Confirmado — `promoted_product_id` é registro textual opcional, nunca migração de identidade |
| Linhas iniciais | 0 (tabela nova, sem resíduos) |

## 4. Prova Viva em Produção

A prova viva foi executada contra as **rotas reais do backend em produção** (após o deploy `c51fe26`), usando a autenticação administrativa. Todos os contratos foram exercitados ponta a ponta:

| Verificação | Evidência |
|---|---|
| Registro formal | `201 created` — `can-ce05fb4dac4cb09bdca0a302`, `listing_key 5f684217...` |
| Idempotência (replay idêntico) | `201 identical_duplicate` — mesmo `candidate_id`, sem segundo insert |
| Colisão de listing_key (payload divergente) | `409 conflict_rejected` — rejeição explícita com `existing_id` |
| Estado inicial | `DISCOVERED` / `INTAKE` |
| Início de revisão | `200` — stage `EVIDENCE_OK` |
| Veredito negativo **sem** motivo | `409 missing_rejection_reason` — recusa correta |
| Veredito `APPROVED` | `200 verdict_recorded` — stage `REVIEWED` |
| Promote (só registro de vínculo) | `200` — `promoted_product_id` e `promoted_at` persistidos; **nenhum produto canônico foi criado** |
| `REJECTED` **com** motivo | `200` — stage `FUNNEL_END`, `rejection_reason` persistido |
| `/discover` via webhook | Webhook `200` ("Update recebido e enfileirado"), `pendingUpdates: 0`, `webhookLastError: None`, `operatorState: READY` — processado sem erro |
| Limpeza integral | `delete` via MCP SQL; **candidates = 0 confirmado**; `products = 12`, `job_queue = 0`, observações = 0 |

## 5. Gates Finais

| Gate | Resultado |
|---|---|
| TypeScript (`tsc --noEmit`) | Sem erros |
| Build (`npm run build`) | OK (esbuild) |
| Testes | **594/594** (528 anteriores + 66 do N1), 43 suites, 0 falhas |
| `/health` produção | `ok` — versão `c51fe26af2e841f0cbfec7fbdacd3cdd3a0112ae` |
| Render deploy | `succeeded` (build + deploy, eventos confirmados via API Render) |
| Catálogo antes/depois | 12 → 12 produtos canônicos, idênticos |
| Telegram/Operator | `apiHealthy: true`, webhook configurado e coincidente, `operatorState: READY`, `pendingUpdates: 0` |
| job_queue / scheduler | Intactos/desligados (0 linhas) |
| Divergências entre código e produção | Nenhuma |

## 6. Pendências e Riscos Residuais

A única divergência observada foi administrativa: o `pnpm-lock.yaml` gerado localmente foi adicionado ao `.gitignore` (o repositório não versiona lockfiles de pnpm, mantendo apenas `bun.lock` e `package-lock.json`), e a correção de `pg_policy→pg_policies` foi aplicada na migration antes da aplicação em produção. Não há risco crítico residual. Os próximos blocos (N2 — Conectores de Marketplace; N3/N5 — promoção a canônico) permanecem não iniciados por decisão deliberada: ingestão programática e conversão de identidade são escopos separados e exigirão proposta e autorização próprias.

**Resposta objetiva:** o Bloco N1 está **100% consolidado em produção**, com contratos, migration, código, rotas, cockpit, testes e prova viva completos, zero resíduos e catálogo canônico intacto.
