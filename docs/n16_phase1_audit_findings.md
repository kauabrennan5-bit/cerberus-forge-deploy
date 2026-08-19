# N16 Fase 1 — Achados do audit local

Data do audit: 2026-08-19.

## Snapshot

- Branch: `main`, alinhada a `origin/main`.
- HEAD auditado: `630e0a781d28ef37c68ee3d2d818f02d09eed990`.
- Existem arquivos não rastreados preexistentes no worktree: `n13_can2.json`, `n13_can8.json`, `tmp-gov-get.json`, `tmp-n14-can-2ae31a4e8e503f55474efe6f.json`, `tmp-n14-can-8bf88302456c4fcf5192e6b4.json`, `tmp-n15-ADVERTISE-2ae31a.json`, `tmp-n15-PUBLISH-2ae31a.json`. Não fazem parte do N16 e não devem ser removidos ou incluídos.

## Publicação legada N5

- `server/commercial/publication/contract.ts` é o contrato N5 (`PUBLICATION_CONTRACT_VERSION = "1.0"`) e não deve ser substituído.
- `publicationExecutor.ts` implementa o fluxo N5 e tem efeitos colaterais de catálogo: `createCanonicalProduct`, `linkPromotion`, `restoreCreatedProduct` e evento `PUBLICATION_EXECUTED`.
- O executor lê `candidate.status`, assessment actionável, campos de produto, policy decision gravada e `ApprovalStore`; não lê `candidate_assessment` com `filter_version = n15:governance_v1` e não valida autorização N15, digest, action PUBLISH ou TTL N15.
- O executor pode criar produto canônico em `products` e vincular `promoted_product_id`, portanto não pode ser chamado pelo caminho N16 Phase 1.
- O executor resolve affiliate link N7 e pode usar `candidate.sourceUrl` como link do produto quando não há affiliate link; essa semântica é incompatível com o executor N16 desta fase e N16 não deve importar N7.

## Rotas legadas

- `server/routes/publicationRoutes.ts` registra `/api/commercial/candidates/:id/publish/preview`, `/api/commercial/candidates/:id/publish`, status e listagem.
- A rota legada constrói sua própria `PublicationDecision`, chama `evaluatePolicy`, usa `ApprovalStore` e termina em `executePublication`; não consulta a autorização N15.
- A rota N16 deve ser nova e isolada. Não alterar nem reutilizar a rota legada nesta fase.

## Decisão arquitetural para N16

- Criar contrato `n16:publication_v1`, engine puro e provider abstrato.
- N16 deve ler a persistência N15 via `candidateAssessmentRepository`, validar fail-closed e executar somente o provider de publicação, sem criação/alteração de produto canônico.
- Criar `publication_executions` em migration local não aplicada à produção, com `UNIQUE(execution_key)` e RLS sem policies públicas.
- Não importar N17/N18/N19/N20, Telegram, scheduler, agents ou `job_queue`.
