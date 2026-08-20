# N17 — Fase 4 — Relatório Final

## 1. Identificação da prova

```text
PROOF_RUN_ID=N17_PHASE4_LIVE_20260820T160134Z
CAPTURED_AT=2026-08-20T16:01:34Z
SHA_INITIAL=40ae71568f2b5f9e484541818912dd18d213cb1c
SHA_FINAL=40ae71568f2b5f9e484541818912dd18d213cb1c
BRANCH=main
```

A Fase 4 foi executada sobre a árvore local existente. O SHA não mudou porque commit, push e deploy foram proibidos. Alterações preexistentes da Fase 3 e de INFRA-03 foram preservadas.

## 2. Objetivo e escopo

O objetivo era validar a etapa operacional N17, incluindo a migration no Supabase real, a composição N17 → N8 → provider oficial Shopee → N6, a autorização N15, uma única aquisição real controlada, persistência, replay, conflito de idempotência e a possibilidade de consumo pelo mecanismo existente do N16.

A execução permaneceu estritamente limitada ao N17. Não foram alterados N13, N14, a governança N15, N16, N18, N19 ou N20. Não foram habilitados agentes, scheduler, job queue, Telegram, social, anúncios ou tracking.

## 3. Auditoria pré-voo

O working tree já continha alterações não consolidadas da Fase 3 e fases anteriores. Os arquivos N17 estavam presentes: `n17Contract.ts`, `n17Service.ts`, `affiliateRepository.ts`, `contract.ts`, a migration `20260821_n17_acquisition_api.sql` e os testes N17.

A auditoria confirmou que o N8 continua sendo a autoridade técnica de aquisição, que o provider oficial Shopee é inicializado no bootstrap quando as credenciais estão disponíveis, e que o N6 continua sendo a autoridade de persistência. O N17 não contém transporte GraphQL, scraping, proxy, browser automation, geração heurística de URL ou endpoint alternativo.

A auditoria também confirmou que o N16 não chama N8 ou N17 diretamente e que não há execução automática de N18+. O bootstrap atual, contudo, ainda não registra `acquireN17` nem uma rota/factory N17 específica. Portanto, a composição runtime N17 → N8 → N6 não foi comprovada como integrada ao processo de produção nesta fase.

## 4. Build e catálogo

O build integral foi executado conforme o prompt.

```text
npm run build=PASS
vite build=PASS
esbuild server.ts=PASS
```

Durante o build, a geração do catálogo obteve 14 produtos da API canônica do backend. O registro adicional `REF-014` foi um efeito conhecido da projeção canônica e foi removido somente do arquivo estático local após o build, preservando o estado pré-voo e sem alterar o Supabase. O catálogo real possui 14 produtos; essa divergência em relação ao baseline histórico de 13 é preexistente/externa e não foi corrigida nesta fase.

O build não foi artificialmente mascarado, o gerador não foi alterado, nenhuma fonte foi substituída e nenhum dado artificial foi usado para declarar sucesso.

## 5. Migration N17

A migration versionada foi aplicada uma única vez no projeto Supabase autorizado `juiychcfdqxgnatffnla`.

```text
MIGRATION=20260821_n17_acquisition_api
RESULT=success=true
```

A revisão e a verificação pós-aplicação confirmaram que as colunas seguintes existem em `public.affiliate_links` e são nullable:

```text
acquisition_ref
authorization_ref
assessment_id
idempotency_key_n17
response_digest_n17
listing_id
seller_id
title_snapshot
canonical_url
method
```

As constraints e os índices relevantes ficaram assim:

```text
method: NULL ou MANUAL ou API
provenance: admin:manual ou n17:api
ux_affiliate_links_idempotency_key_n17: índice único parcial quando a chave não é nula
idx_affiliate_links_listing_n17: índice parcial quando listing_id não é nulo
```

A migration foi aditiva, não executou `DELETE`, não executou `TRUNCATE`, não armazenou secrets e preservou a compatibilidade dos registros legados `admin:manual`/`MANUAL`. Nenhum registro de `affiliate_links` foi criado pela migration.

## 6. Validação do repository N6

O schema real do N6 foi validado antes e depois da migration. O adapter N17 existente no repository local permanece fail-closed, usa `provenance=n17:api`, `method=API`, `idempotency_key_n17` e `response_digest_n17`, e não modifica o caminho manual `persistLink()`.

Não foi criado registro de teste artificial no Supabase real. A persistência real de uma aquisição não poderia ser exercitada legitimamente sem uma autorização N15 válida e sem uma aquisição N8 confirmada. A leitura agregada confirmou `affiliate_links=0` antes e depois.

## 7. Autorização N15

Foi realizada consulta somente leitura à fonte real de avaliações N15, filtrando a decisão governada para `ACQUIRE_AFFILIATE`. O conjunto retornado foi vazio.

```text
N15_ACQUIRE_AFFILIATE_APPROVED=NOT_FOUND
AUTHORIZATION_REF=NOT_AVAILABLE
ASSESSMENT_ID=NOT_AVAILABLE
```

A implementação atual de N15 persiste avaliações em `candidate_assessment`, mas não expõe um lookup nativo por `authorization_ref` para o contrato N17. O carregador existente de autorização é específico para `PUBLISH`; não existe uma autorização N15 legítima observável que possa ser reutilizada para aquisição.

Pela regra fail-closed, nenhuma autorização foi criada artificialmente e nenhuma aquisição foi executada.

## 8. Produto de teste

Nenhum produto foi selecionado para prova viva. Sem autorização N15 `ACQUIRE_AFFILIATE` válida não existe oportunidade governada elegível, mesmo que o provider, as credenciais e um item Shopee real estejam disponíveis.

Não foram inventados `candidate_id`, `source_product_id`, `source_shop_id`, `authorization_ref`, `assessment_id`, elegibilidade ou identidade.

## 9. Composição N17 → N8 → Shopee

A composição conceitual e os contratos locais estão presentes:

```text
N15 autorização
  ↓
N17 acquireN17
  ↓
N8 acquireAffiliateLink
  ↓
provider Shopee oficial / productOfferV2
  ↓
N8 AcquireResult
  ↓
N17 valida identidade, URL oficial, provenance e digest
  ↓
N6 n17AffiliateRepository.persistN17Acquisition
```

A composição runtime final não foi registrada no bootstrap nesta fase. O `server.ts` atual registra N8/N6, mas não registra `acquireN17`, uma `authorizationStore` N17 por `authorization_ref` ou uma rota N17. Adicionar uma autorização ou fazer wiring improvisado para contornar a ausência de contrato N15 seria incompatível com o fail-closed e com a proibição de inventar governança.

## 10. Resultado N8 e resultado N17

```text
N8_REAL_ACQUISITION=NOT_EXECUTED
SHOPEE_API_CALLS=0
N8_RESULT=NOT_AVAILABLE — pré-condição N15 ausente
N17_RESULT=BLOCKED — NO VALID N15 AUTHORIZATION
IDENTITY=NOT_EXECUTED
AFFILIATE_URL=NOT_OBSERVED
ACQUISITION_REF=NOT_OBSERVED
RESPONSE_DIGEST=NOT_GENERATED_FOR_REAL_ACQUISITION
PROVENANCE_API=NOT_PRODUCED
```

Nenhum resultado `IDENTITY_UNCERTAIN` foi promovido a `ACQUIRED`. Nenhum `productLink`, `productUrl` ou `offerLink` foi tratado como prova de aquisição.

## 11. Replay e conflito

Como não houve aquisição real nem registro N17 no banco, os testes de replay real, retorno `ALREADY_ACQUIRED`, preservação do mesmo `affiliate_link_id`, preservação do mesmo `acquisition_ref` e conflito de identidade não foram executados contra produção.

A idempotência e o conflito continuam cobertos pelos testes locais do contrato e do adapter N17. A validação real fica bloqueada até existir uma autorização N15 legítima e uma composição runtime N17 registrada.

## 12. Consumo pelo N16

Não houve registro N17 persistido para resolver. Portanto, o consumo real pelo resolver N7/N16 não foi executado e não pode ser declarado como comprovado.

```text
N16_CONSUMPTION=NOT_EXECUTED — sem affiliate_link N17 real
PUBLICATION=NOT_EXECUTED
TELEGRAM=NOT_EXECUTED
```

Nenhum código de N16 foi alterado e nenhuma publicação foi iniciada.

## 13. Gates finais

```text
npm test=PASS — 1398/1398
npx tsc --noEmit=PASS
npm run build=PASS
vite build=PASS
esbuild server.ts=PASS
git diff --check=PASS
secret scan nas superfícies da Fase 4=PASS — 0 ocorrências
```

A varredura não imprimiu valores secretos. Nenhuma credencial, assinatura, token, header sensível, resposta bruta ou `raw_response` foi persistido no relatório ou no adapter.

## 14. Banco antes/depois

O baseline agregado real imediatamente antes da prova e após a decisão de bloqueio permaneceu:

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

`products=14` diverge do baseline histórico esperado de 13 porque `REF-014` já existe na projeção real do catálogo. Nenhuma remoção ou alteração foi feita no banco. A migration alterou apenas o schema de `affiliate_links`; nenhuma linha de negócio foi criada ou alterada.

## 15. Segurança e escopo

```text
N13=NOT_EXECUTED
N14=NOT_EXECUTED
N15=CONSULTADO SOMENTE COMO AUTORIDADE; nenhuma autorização criada
N16=NOT_EXECUTED; somente consumo planejado, sem publicação
N17=EXECUTADO ATÉ O BLOQUEIO PRÉ-AQUISIÇÃO
N18=NOT_EXECUTED
N19=NOT_EXECUTED
N20=NOT_EXECUTED

Shopee real=0 chamadas
Telegram=NOT_EXECUTED
social=NOT_EXECUTED
anúncios=NOT_EXECUTADOS
tracking=NOT_EXECUTADO
scheduler=NOT_EXECUTADO
job_queue=NOT_EXECUTADA
agentes=NOT_EXECUTADOS
```

Não houve scraping, proxy, browser automation, endpoint não oficial, transporte GraphQL duplicado, publicação, distribuição ou alteração de N13–N16.

## 16. Arquivos e Git

Alterações de implementação N17 e a migration já estavam presentes como trabalho local não consolidado da Fase 3. Na Fase 4 foram produzidos/atualizados os artefatos de evidência e este relatório. O efeito colateral temporário do build em `public/data/products.json` foi removido, deixando esse arquivo sem diff adicional ao final.

```text
SHA_FINAL=40ae71568f2b5f9e484541818912dd18d213cb1c
COMMIT=NOT_PERFORMED
PUSH=NOT_PERFORMED
DEPLOY=NOT_PERFORMED
PRODUÇÃO_COM_CÓDIGO_N17=NOT_DEPLOYED
MIGRATION_SUPABASE=APPLIED
```

## 17. Decisão final

```text
DECISION=BLOCKED — NO VALID N15 AUTHORIZATION
N17=READY FOR REVIEW / BLOCKED BY MISSING AUTHORIZATION
N18=NOT EXECUTED
```

O N17 não pode ser declarado `OPERATIONAL`, `COMPLETE` ou `READY FOR N18`. A decisão é fail-closed porque não existe autorização N15 `ACQUIRE_AFFILIATE` observável e vinculável por `authorization_ref` no Supabase real. A composição runtime N17 ainda também precisa ser registrada de forma explícita, sem inventar um adapter de autorização que N15 não fornece.

O próximo passo mínimo é disponibilizar uma autorização N15 legítima para `ACQUIRE_AFFILIATE`, com vínculo verificável a candidato, assessment e oportunidade, e aprovar o wiring runtime N17 correspondente. Somente depois disso a prova única Shopee, o replay, o conflito e o consumo N16 poderão ser executados. N18, N19 e N20 permanecem fora do escopo.
