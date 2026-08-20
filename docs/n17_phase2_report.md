# N17 — Fase 2 — Contrato, Orquestração e Persistência Governada

## Identificação

**PROOF_RUN_ID:** `N17_PHASE2_CONTRACT_ORCHESTRATION_20260820T150952Z`

**SHA analisado:** `40ae71568f2b5f9e484541818912dd18d213cb1c`

**Branch:** `main`

**Status final:** `READY FOR PHASE 3`

Esta fase implementou somente estruturas locais do contrato e do orquestrador N17. Não houve aquisição real, chamada à Shopee, geração de short link, escrita real em banco, migration, publicação, distribuição, tracking, N18+, commit, push ou deploy.

## Arquivos alterados nesta fase

Foram criados os seguintes arquivos funcionais locais:

- `server/commercial/affiliate/n17Contract.ts`
- `server/commercial/affiliate/n17Service.ts`
- `tests/n17Acquisition.test.ts`

Foi criado este relatório:

- `docs/n17_phase2_report.md`

O arquivo `docs/n17_phase1_audit.md` pertence à Fase 1 e não foi alterado nesta fase.

Alterações preexistentes de outras fases foram preservadas. Em particular, o working tree já continha `tests/shopeeAffiliateIntegration.test.ts` e diversos relatórios não rastreados de INFRA-03/N16, além de `public/data/products.json` modificado. Nenhum desses artefatos foi usado para ampliar o escopo do N17.

## Contrato de entrada N17

`N17AcquireRequest` exige `candidate_id`, `marketplace`, `provider_id`, `public_product_url`, `authorization_ref`, `action`, `idempotency_key`, `provenance` e `requested_at`. Para Shopee, `source_product_id` e `source_shop_id` são obrigatórios pelo validador local. `product_id`, `assessment_id` e `tracking_context` são preservados quando disponíveis.

A ação é fechada em `ACQUIRE_AFFILIATE`. O request é rejeitado quando a ação diverge, quando a autorização não existe ou não está APPROVED, quando o candidato diverge da autorização, quando a autorização expirou, quando provider e marketplace não coincidem, quando a URL pública não é oficial, quando os IDs Shopee estão ausentes ou quando a provenance não corresponde ao provider/marketplace/método esperado.

`candidate_id`, `product_id`, `source_product_id` e `source_shop_id` nunca são inventados. O N17 não cria produto canônico e não extrai identidade de uma URL sem a autoridade do N8.

## Contrato de saída N17

`N17AcquireResult` possui os estados fechados `ACQUIRED`, `ALREADY_ACQUIRED`, `BLOCKED`, `FAILED` e `NOT_ELIGIBLE`.

A resposta serializável preserva, quando comprovados, `affiliate_link_id`, `affiliate_url`, `short_url`, `provider_id`, `marketplace`, `listing_id`, `seller_id`, `title_snapshot`, `canonical_url`, `acquisition_ref`, `authorization_ref`, `assessment_id`, `idempotency_key`, `method`, `acquired_at`, `observed_at`, `response_digest`, `provenance`, `error_kind` e `reason_sanitized`. Valores não comprovados permanecem `null`; o N17 não preenche campos por inferência.

A interface futura `N18AcquisitionInput` aceita somente `ACQUIRED` ou `ALREADY_ACQUIRED` e exige a referência do link, URL oficial, provider, marketplace, identidade confirmada, acquisition reference, provenance e timestamps. `BLOCKED`, `FAILED`, `NOT_ELIGIBLE`, `IDENTITY_UNCERTAIN`, ausência de affiliate URL, ausência de provenance ou ausência de identidade confirmada não podem avançar para N18.

## Sequência N15 → N17 → N16

A sequência fechada nesta fase é:

```text
N15 APPROVED / ACQUIRE_AFFILIATE
        ↓
autorização N17
        ↓
N17 valida request, provider e idempotência
        ↓
N8 executa a aquisição técnica
        ↓
N17 valida identidade, URL oficial, método e provenance
        ↓
N17 persiste com confirmação
        ↓
ACQUIRED / ALREADY_ACQUIRED
        ↓
N16 resolve o affiliate link necessário e publica somente após a autorização e os dados resolvidos
```

N16 não foi alterado. Nenhuma chamada N8 foi colocada em `publicationExecutor.ts` ou `n16Service.ts`. N17 também não publica, distribui, anuncia, inicia tracking, chama N18 ou executa qualquer etapa posterior.

A implementação local registra a preferência arquitetural exigida pelo prompt: aquisição e persistência governadas devem ocorrer antes da publicação exigente. A integração de produção entre a nova abstração N17 e as rotas/repositórios existentes permanece fora desta fase.

## Matriz N8 → N17

`SUCCESS` do N8 somente vira `ACQUIRED` após validação de identidade, URL oficial, método compatível, acquisition reference, digest, provenance e persistência confirmada.

`SUCCESS` com replay idêntico e identidade coincidente vira `ALREADY_ACQUIRED` sem nova chamada N8.

`IDENTITY_UNCERTAIN` vira `BLOCKED`.

`AUTH_REQUIRED` vira `BLOCKED`, sem retry arbitrário.

`NOT_SUPPORTED` vira `BLOCKED`.

`MANUAL_REQUIRED` vira `BLOCKED` no request API; não há operação manual autorizada nesta fase.

`PRODUCT_NOT_ELIGIBLE` vira `NOT_ELIGIBLE`.

`PROVIDER_NOT_ACTIVE` vira `BLOCKED`.

`RESOLUTION_FAILED` vira `FAILED`.

Exceção do N8 vira `FAILED` com razão sanitizada. Resultado SUCCESS incompleto, affiliate URL não oficial, identidade incompleta ou método divergente vira `BLOCKED`. Conflito de persistência vira `BLOCKED`; falha de persistência vira `FAILED`. Nenhum desses estados persiste ou retorna `ACQUIRED`.

O Mercado Livre não recebeu aquisição API. O comportamento permanece `MANUAL`/`NOT_SUPPORTED` conforme o contrato existente.

## Idempotência e concorrência

A chave determinística é construída antes da chamada externa como:

```text
n17-idem:sha256(JSON.stringify({
  action,
  authorization_ref,
  candidate_id,
  marketplace,
  product_id: product_id ?? null,
  provider_id,
  source_product_id: source_product_id ?? null,
  source_shop_id: source_shop_id ?? null
}))
```

O JSON é codificado em UTF-8 e o digest é hexadecimal SHA-256. O N17 rejeita chave ausente, inválida ou diferente da chave determinística calculada.

O fluxo local consulta o repository antes de chamar N8. Registro existente com identidade esperada produz `ALREADY_ACQUIRED`; registro existente com identidade divergente produz `BLOCKED`. Depois da chamada, a persistência retorna `created`, `identical_duplicate`, `conflict` ou `failed`.

A persistência real atual não garante ainda, para API, uma transação/constraint de negócio completa com todos os campos de N17. Por isso, a Fase 2 marca `MIGRATION_REQUIRED` antes de qualquer integração de produção. A solução local usa `N17Repository` injetado para testar a máquina de estados sem fingir que o repositório N6 atual já suporta a semântica API.

## Provenance

A provenance local de N17 exige `provider`, `marketplace`, `method`, `source_operation` e `source_url_origin`. Para o fluxo Shopee API, o método esperado é `API`, a operação é `productOfferV2` e a origem da URL é `official_provider`.

O N17 rejeita provenance divergente. A aquisição API nunca é registrada como `admin:manual` nem como `MANUAL`. Nenhum Authorization, token, secret, signature, cookie, header sensível ou resposta bruta com credenciais é persistido.

A persistência de produção ainda precisa suportar explicitamente a proveniência API e seus campos de auditoria. A Fase 2 não executou migration.

## Response digest

O digest é `sha256:<64 hex chars>` sobre JSON canônico UTF-8 contendo somente:

- `acquisition_ref`;
- `affiliate_url`;
- `canonical_url`;
- `identity_confirmed=true`;
- `listing_id`;
- `marketplace`;
- `method`;
- `provider_id`;
- `seller_id`;
- `title_snapshot`.

O helper não recebe resposta bruta, headers, Authorization, tokens, secrets, cookies ou signatures. O digest não substitui a resposta estruturada nem é usado para fabricar campos ausentes.

## Candidate/product linkage e migration necessária

O contrato local N17 preserva simultaneamente `candidate_id` e `product_id` quando ambos existem, mantendo a rastreabilidade `candidate → assessment → authorization N15 → product → acquisition N17 → affiliate_link`.

O schema/repositório atual de `affiliate_links` aplica `candidate_id XOR product_id` e força limitações de `resolution_method`/provenance compatíveis com registros manuais. Isso não representa integralmente uma aquisição API autorizada, principalmente quando o fluxo exige candidate e product simultaneamente.

A produção exigirá migration e revisão de constraint, no mínimo para:

- permitir o método API de aquisição sem falsificar provenance manual;
- representar provider, marketplace, source operation, acquisition reference, authorization reference, assessment reference e timestamps;
- armazenar `observed_at`, `acquired_at`, `response_digest` e identidade confirmada;
- preservar `affiliate_url` e separar `short_url` somente quando explicitamente retornada;
- permitir a relação candidate/product exigida pelo fluxo, sem quebrar registros legados;
- impor unicidade/idempotência de negócio para provider, oportunidade, autorização e ação;
- garantir inserção idempotente e detecção de duplicata idêntica/conflito sob concorrência;
- manter RLS e não armazenar qualquer segredo do provider.

Nenhuma migration foi criada ou executada nesta fase.

## Short URL e Shopee

O N17 mantém `affiliate_url` e `short_url` como campos distintos. Não assume que `offerLink` é short URL nem que affiliate URL e short URL são equivalentes. Não foi gerada short link real.

Quando uma futura execução for autorizada, o N17 deverá delegar ao adapter oficial existente, que por sua vez reutiliza `shopeeAffiliateProvider.ts`, `shopeeApiClient.ts`, `productOfferV2` e, quando permitido pelo adapter existente, `generateShortLink`. Nenhuma query GraphQL, endpoint, transporte ou parser paralelo foi criado.

## Testes locais adicionados

Foi adicionada uma suíte sem rede real em `tests/n17Acquisition.test.ts`. Os testes cobrem request inválido, autorização ausente/não APPROVED/divergente/expirada, action inválida, provenance divergente, URL não oficial, IDs Shopee ausentes, idempotency key inválida, provider ausente/inativo, marketplace incompatível, sucesso com URL oficial e identidade confirmada, provenance API, digest seguro, replay idêntico sem nova chamada N8, conflito de identidade, todos os estados de falha N8 relevantes, SUCCESS incompleto, URL afiliada não oficial, método divergente, conflito/falha de persistência e exceção sanitizada.

A suíte verifica explicitamente que o N17 delega ao N8 por dependência injetada e não cria transporte Shopee próprio. Também verifica que persistence failure nunca retorna ACQUIRED. O contrato futuro N18 é apenas uma interface; N18 não é chamado.

## Gates locais

Os gates foram executados após as correções de tipos e fixtures:

- `npm test`: PASS — 1397 testes, 0 falhas.
- `npx tsc --noEmit`: PASS.
- `npm run build`: PASS.
- `git diff --check`: PASS.
- Verificação sanitizada de secrets: PASS, sem exposição de credenciais.
- Inspeção do diff: PASS para o escopo funcional N17.

Nenhum gate realizou chamada real à Shopee. Os testes usam provider, autorização, N8 e repository falsos/injetados.

## Working tree e controles de escopo

O SHA analisado permanece `40ae71568f2b5f9e484541818912dd18d213cb1c`. Não foi feito commit, push ou deploy.

O working tree contém alterações preexistentes e arquivos não rastreados de fases anteriores. Os arquivos funcionais novos desta Fase 2 são os dois módulos N17 e a suíte `tests/n17Acquisition.test.ts`; o relatório é o único artefato documental criado nesta etapa.

INFRA-03 não foi alterado. Não houve mudança no selection set, parser de price, Evidence Bridge, N13, N14, N15 ou N16. Não houve banco alterado, migration, job queue, scheduler, Telegram, publicação, anúncio ou tracking.

N18, N19 e N20 permanecem `NOT EXECUTED`.

## Decisão final

**STATUS = READY FOR PHASE 3**.

O contrato local do N17 está definido, os estados são fechados, N15 continua autoridade de autorização, N8 continua autoridade técnica de aquisição, a idempotência é pré-chamada, a provenance e o digest são fail-closed, o vínculo candidate/product foi explicitado, a lacuna de persistência foi marcada como `MIGRATION_REQUIRED`, o contrato futuro do N18 foi definido e os testes locais passaram.

A Fase 2 termina aqui. Não iniciar Fase 3, migration, prova real, commit, push ou deploy sem nova autorização explícita.

## Referências internas

[1]: `server/commercial/affiliate/n17Contract.ts`
[2]: `server/commercial/affiliate/n17Service.ts`
[3]: `tests/n17Acquisition.test.ts`
[4]: `server/commercial/affiliate/acquisitionService.ts`
[5]: `server/commercial/affiliate/acquisitionContract.ts`
[6]: `server/commercial/affiliate/affiliateRepository.ts`
[7]: `server/commercial/affiliate/contract.ts`
[8]: `server/commercial/publication/publicationExecutor.ts`
[9]: `server/commercial/publication/n16Service.ts`
[10]: `docs/n17_phase1_audit.md`
[11]: `Pasted_content_100.txt`, seção N17 — Fase 2 — Contrato, Orquestração e Persistência Governada
