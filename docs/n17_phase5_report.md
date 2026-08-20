# N17 — Fase 5 — Relatório de Prova Operacional

## Decisão final

`DECISION=BLOCKED — NO VALID N15 AUTHORIZATION`

A Fase 5 foi encerrada fail-closed após a consulta somente leitura da fonte persistente de governança. Não foi criada autorização artificial, não foi convertido um assessment de outra ação, não foi inventado candidato, oportunidade, produto, identidade Shopee, URL ou identificador externo.

A ausência de uma decisão N15 observável e legítima para `ACQUIRE_AFFILIATE` é uma condição de parada explícita do prompt. Portanto, não houve chamada à Shopee, não houve teste de replay ou conflito e não houve consumo pelo N16.

## Identificação

`PROOF_RUN_ID=N17_PHASE5_LIVE_20260820T162636Z`

`SHA_INITIAL=40ae71568f2b5f9e484541818912dd18d213cb1c`

`SHA_FINAL=40ae71568f2b5f9e484541818912dd18d213cb1c`

`BRANCH=main`

`UTC_TIMESTAMP=2026-08-20T16:26:36Z`

`ENVIRONMENT=local audit with authorized Supabase read-only access; no production runtime or deploy changed`

`SUPABASE_PROJECT_ID=juiychcfdqxgnatffnla`

`PROVIDER_TESTED=affprv-shopee / marketplace=Shopee`

## Objetivo e escopo

O objetivo era resolver exclusivamente os dois bloqueios identificados na Fase 4: localizar uma autorização N15 real para `ACQUIRE_AFFILIATE` e registrar wiring runtime explícito `N15 → N17 → N8 → provider oficial → N6`. Somente depois dessas pré-condições seria permitida uma única aquisição real Shopee, seguida de replay idêntico, teste de conflito de idempotência e resolução do link pelo N16 sem publicação.

A fase permaneceu limitada ao N17 e à sua integração imediata. N13, N14 e a lógica de decisão do N15 não foram alterados. N16 não publicou. N18, N19 e N20 não foram iniciados. Scheduler, job queue, Telegram, agentes, tracking, social, anúncios, distribuição e publicação permaneceram fora da execução.

## Auditoria N15

Foi executada em 2026-08-20T16:28:32Z uma consulta somente leitura em `public.candidate_assessment`, filtrando decisões persistidas cujo `action` em `dimensions` ou no snapshot de governança fosse `ACQUIRE_AFFILIATE`. O resultado foi um conjunto vazio (`[]`).

Não foi observado nenhum vínculo verificável completo:

`candidate_id → assessment_id → authorization_ref → opportunity/product`

Também não foi observada autorização N15 com status `APPROVED`, ação `ACQUIRE_AFFILIATE`, validade e identidade de oportunidade compatíveis. A fonte N15 atual persiste assessments e decisões, mas o contrato público consultado não expõe um `authorization_ref` N17 específico que pudesse ser usado legitimamente para a prova.

A ausência foi tratada como dependência bloqueante. Nenhuma decisão `PUBLISH` foi reutilizada ou convertida em `ACQUIRE_AFFILIATE`.

## Provider e oportunidade

Foi executada em 2026-08-20T16:28:54Z uma consulta somente leitura do provider oficial. O resultado sanitizado foi:

`provider_id=affprv-shopee`

`provider_code=shopee`

`status=ACTIVE`

`marketplace=Shopee`

O provider estava ativo, mas isso não substitui uma autorização N15. Nenhuma oportunidade foi selecionada, porque não havia autorização legítima que estabelecesse o vínculo necessário com candidato, assessment, marketplace, provider, produto, `source_product_id` e `source_shop_id`.

## Wiring runtime

`N17_RUNTIME_WIRING=NOT_IMPLEMENTED_IN_PHASE5`

O bootstrap ainda não registra uma composição runtime acessível de `acquireN17` com uma fonte explícita de autorização N15. A fase foi encerrada antes de criar qualquer factory, rota ou adapter adicional, pois o prompt determina parada imediata quando a autorização N15 legítima está ausente. Não foi criado wiring improvisado para contornar a autoridade do N15.

A fronteira arquitetural permaneceu preservada:

`N15 authorization → N17 acquireN17 → N8 acquireAffiliateLink → Shopee official provider → N6 persistN17Acquisition`

Nenhum transporte GraphQL, cliente Shopee, provider, scraping, proxy, browser automation ou endpoint paralelo foi duplicado.

## Migration e estado do banco

A migration `20260821_n17_acquisition_api` já havia sido aplicada uma única vez durante a Fase 4 no projeto Supabase autorizado. Ela não foi reaplicada na Fase 5.

A verificação pós-migration confirmou as colunas nullable N17 em `affiliate_links`, os checks para `method IN ('MANUAL','API')` e `provenance IN ('admin:manual','n17:api')`, além do índice único parcial de `idempotency_key_n17`. Nenhuma alteração de schema ocorreu na Fase 5.

O snapshot real conhecido permaneceu:

```text
products=14
candidates=0
candidate_evidence=0
candidate_assessment=0
affiliate_links=0
job_queue=0
publication_executions=0
commercial_cycles=0
```

A contagem `products=14` continua divergente do baseline histórico de 13, com `REF-014` já observado anteriormente. Essa divergência foi preservada; não houve correção, exclusão ou alteração de catálogo.

Nenhuma escrita real foi executada na Fase 5. `affiliate_links` permaneceu sem aquisição N17.

## Aquisição e validações não executadas

`FIRST_ACQUISITION=NOT_EXECUTED`

`SHOPEE_REAL_CALLS=0`

`N8_RESULT=NOT_AVAILABLE — fluxo bloqueado antes da aquisição`

`N17_RESULT=NOT_AVAILABLE — fluxo bloqueado antes da aquisição`

`IDENTITY=NOT_OBSERVED`

`AFFILIATE_URL=NOT_OBSERVED`

`ACQUISITION_REF=NOT_OBSERVED`

`AUTHORIZATION_REF=NOT_OBSERVED`

`ASSESSMENT_ID=NOT_OBSERVED`

`RESPONSE_DIGEST=NOT_OBSERVED`

`PROVENANCE=NOT_OBSERVED`

`METHOD=NOT_OBSERVED`

A ausência de resultado não foi convertida em `ACQUIRED`, `ALREADY_ACQUIRED`, `KNOWN` ou qualquer outro sucesso funcional.

O replay idêntico não foi executado. O teste de conflito de idempotência não foi executado. A resolução de link pelo N16 não foi executada. Nenhuma publicação foi realizada.

## Gates

Os gates completos da Fase 4, executados antes desta auditoria e sem alteração de código posterior, permaneceram registrados como aprovados: `npm test` com 1398/1398 testes, `npx tsc --noEmit`, `npm run build`, `npx vite build`, compilação independente do servidor com esbuild e `git diff --check`.

Na Fase 5, após a criação do snapshot e atualização da evidência sanitizada, `git diff --check` passou. A varredura refinada de segredos nas superfícies da Fase 5 passou com zero ocorrências de valores secretos, tokens, credenciais ou cabeçalhos sensíveis. A primeira varredura ampla produziu apenas um falso positivo pela palavra textual `Telegram` no bloco de escopo; ela foi corrigida por uma segunda varredura precisa, sem qualquer segredo identificado.

Os gates de execução pós-live não foram executados porque a prova live não começou. Essa decisão preserva a condição de parada do prompt e evita declarar uma prova operacional inexistente.

## Controles de escopo e segurança

`N13=NOT_EXECUTED`

`N14=NOT_EXECUTED`

`N15=CONSULTED_ONLY / AUTHORIZATION SOURCE`

`N16=NOT_EXECUTED`

`N17=LIVE TEST NOT EXECUTED`

`N18=NOT_EXECUTED`

`N19=NOT_EXECUTED`

`N20=NOT_EXECUTED`

Não houve scraping, proxy, browser automation, endpoint não oficial, transporte GraphQL duplicado, scheduler, job queue, Telegram, social, anúncios, tracking, agentes ou publicação. Nenhum secret foi lido, persistido ou exposto.

## Git e deploy

`COMMIT=NOT_PERFORMED`

`PUSH=NOT_PERFORMED`

`DEPLOY=NOT_PERFORMED`

O SHA final permanece igual ao SHA inicial. As alterações locais da Fase 3 e os documentos de evidência anteriores não foram commitados nem publicados como parte desta fase.

## Próximo passo mínimo

O próximo passo mínimo é disponibilizar, por meio do fluxo legítimo do N15 e sem alterar sua lógica, uma decisão persistida `APPROVED` para `ACQUIRE_AFFILIATE` com vínculo verificável a `candidate_id`, `assessment_id`, `authorization_ref`, oportunidade, marketplace e provider. Até que isso exista e possa ser consultado sem inferência, qualquer prova N17 Shopee deve permanecer bloqueada.

N18 permanece `NOT_EXECUTED` e não deve ser iniciado automaticamente.
