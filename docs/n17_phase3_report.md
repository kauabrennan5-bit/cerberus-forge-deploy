# N17 — Fase 3 — Integração local do orchestrator com N8/N6

## Identificação

**PROOF_RUN_ID:** `N17_PHASE3_LOCAL_20260820T155126Z`

**SHA analisado:** `40ae71568f2b5f9e484541818912dd18d213cb1c`

**Branch:** `main`

**Status:** `READY FOR REVIEW — BLOCKED BY EXTERNAL CATALOG BUILD DEPENDENCY`

A Fase 3 implementou localmente a persistência mínima e backward-compatible para aquisições API do N17. Não houve chamada real à Shopee, escrita em Supabase, aplicação de migration, aquisição operacional, publicação, commit, push ou deploy.

## Escopo executado

O escopo autorizado foi limitado à extensão aditiva de `affiliate_links`, ao adapter persistente do N6 para o contrato `N17Repository`, aos testes com fake Supabase e aos gates locais.

O N8 continua sendo a única autoridade técnica de aquisição. O adapter N17 não contém transporte, GraphQL, assinatura, resolução de oferta, geração de short link, scraping, proxy, browser ou qualquer bypass. Ele somente recebe um resultado já confirmado pelo N8 e o persiste após validações fail-closed.

O caminho manual existente (`persistLink`) foi preservado. Ele continua separado do caminho N17 e não foi convertido para a proveniência `n17:api`.

## Arquivos alterados pela Fase 3

Foram criados ou modificados os seguintes arquivos relacionados diretamente a esta fase:

```text
supabase/migrations/20260821_n17_acquisition_api.sql
server/commercial/affiliate/affiliateRepository.ts
server/commercial/affiliate/contract.ts
tests/n17AffiliateRepository.test.ts
tests/affiliateProvidersLinks.test.ts
docs/n17_phase3_report.md
```

`n17Contract.ts`, `n17Service.ts` e `tests/n17Acquisition.test.ts` pertencem à Fase 2 e não precisaram de alteração para esta integração. O N17 já recebe o repository por injeção de dependência; a composição real permanece no ponto de chamada do backend e não foi ampliada nesta fase.

Alterações preexistentes de INFRA-03, N16, N17 Fase 2, Mercado Livre e `public/data/products.json` foram preservadas e não foram usadas para ampliar o escopo desta fase.

## Migration aditiva

O arquivo `20260821_n17_acquisition_api.sql` adiciona, com `NULL` permitido, as colunas:

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

A migration mantém as linhas manuais existentes válidas, preserva `admin:manual`, adiciona `n17:api` à constraint de proveniência e adiciona o catálogo de método `MANUAL`/`API` com `method` nullable para compatibilidade retroativa.

A idempotência N17 é protegida por índice único parcial em `idempotency_key_n17` somente quando a chave está preenchida. Assim, as linhas legadas com `NULL` permanecem inalteradas e replays N17 concorrentes podem ser resolvidos pelo índice.

Também foi criado um índice parcial para `listing_id`. Nenhum `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE` ou aplicação da migration foi executado contra Supabase.

## Adapter N17 no repository N6

Foram adicionadas as funções:

```text
findN17ByIdempotencyKey(key)
persistN17Acquisition(record)
n17AffiliateRepository
```

`persistN17Acquisition` valida, antes da escrita, a identidade do candidato, o alvo XOR legado, o marketplace, o provider, a URL oficial, a referência de aquisição, a autorização, a chave de idempotência, o digest, o método API, a proveniência oficial, a identidade de listing/seller/título/URL e os timestamps UTC.

A persistência grava apenas metadados permitidos. `response_digest_n17` representa o digest seguro; a linha não recebe resposta bruta, headers, Authorization, App Secret ou qualquer credencial.

A função diferencia explicitamente:

```text
created
identical_duplicate
conflict
failed
```

Um `IDENTITY_UNCERTAIN` não é transformado pelo adapter em `ACQUIRED`. O adapter não altera o estado do N17; ele apenas retorna o resultado de persistência ao orchestrator, que continua responsável pelo mapeamento fail-closed.

## Testes adicionados

`tests/n17AffiliateRepository.test.ts` usa exclusivamente fake Supabase e cobre, no mesmo fluxo sequencial:

```text
persistência de um registro confirmado;
leitura por idempotency_key_n17;
replay idêntico sem duplicação;
conflito com a mesma chave e conteúdo divergente;
rejeição fail-closed quando seller_id está ausente;
ausência de raw_response na linha persistida.
```

O teste de contrato N6 em `tests/affiliateProvidersLinks.test.ts` foi ajustado somente para reconhecer explicitamente o novo valor `n17:api`; as expectativas do caminho `admin:manual` permaneceram intactas.

## Gates locais

```text
npm test                              PASS — 1398/1398
npx tsc --noEmit                      PASS
npm run build                         BLOCKED BY DEPENDENCY
npx vite build                        PASS
npx esbuild server.ts ...             PASS
git diff --check                      PASS
secret scan escopado                  PASS — nenhum match nos arquivos da Fase 3
```

O `npm run build` executa primeiro `scripts/generate-static-catalog.js`. No ambiente local da prova, a fonte canônica Supabase não estava disponível para o processo e a tentativa de fallback na API backend falhou por desconexão TLS. O build integral, portanto, não foi declarado como PASS. O Vite e o empacotamento isolado do servidor passaram, demonstrando que a alteração N17 compila e é empacotável; isso não substitui a dependência canônica requerida pelo build oficial.

A falha é classificada como:

```text
BLOCKED BY DEPENDENCY — canonical catalog source unavailable in local build
```

Não foi feita alteração especulativa no gerador de catálogo, no catálogo canônico, no `.env`, no Supabase ou no backend remoto para contornar essa dependência.

## Baseline e efeitos operacionais

Baseline conhecido antes da fase:

```text
products=13
candidates=0
candidate_evidence=0
candidate_assessment=0
affiliate_links=0
job_queue=0
publication_executions=0
commercial_cycles=0
```

Baseline depois da fase:

```text
products=13
candidates=0
candidate_evidence=0
candidate_assessment=0
affiliate_links=0
job_queue=0
publication_executions=0
commercial_cycles=0
```

A igualdade é uma conclusão de escopo local: nenhum banco foi acessado para escrita e nenhuma chamada real de aquisição foi realizada. A migration não foi aplicada em produção.

## Pipeline não executado

```text
N13 = NOT_EXECUTED
N14 = NOT_EXECUTED
N15 = NOT_EXECUTED
N16 = NOT_EXECUTED
N17 acquisition = NOT_EXECUTED
N18+ = NOT_EXECUTED
```

Os testes do adapter são testes locais de persistência simulada e não constituem prova de aquisição, identidade externa, autorização N15, publicação ou receita. Nenhum resultado foi promovido a PASS operacional, KNOWN, APPROVED, PUBLISHED ou ACQUIRED real.

## Produção e Git

```text
real Shopee API call = NOT PERFORMED
real Supabase write = NOT PERFORMED
migration applied to production = NOT PERFORMED
commit = NOT PERFORMED
push = NOT PERFORMED
deploy = NOT PERFORMED
N18 start = NOT PERFORMED
```

A produção permanece no SHA anterior. O SHA informado é apenas o SHA analisado localmente; não representa novo commit nem novo deploy.

## Gaps e dependências remanescentes

A prova de aquisição real, a composição do N17 com o N8 em runtime, a aplicação controlada da migration e a validação do repository contra Supabase real permanecem deferidas para a Fase 4, mediante autorização explícita.

O gate integral de build permanece dependente de uma fonte canônica local ou de conectividade funcional com a API backend. Esse bloqueio não foi mascarado pelos builds isolados.

Não há autorização para iniciar N18, alterar N13–N16, executar aquisição real, aplicar migration, fazer commit, fazer push ou fazer deploy nesta fase.

## Decisão final

```text
READY FOR REVIEW — FASE 3 IMPLEMENTADA LOCALMENTE

Adapter N17: IMPLEMENTADO E TESTADO COM FAKE SUPABASE
Migration: CRIADA, ADITIVA E NÃO APLICADA
Suíte de testes: PASS — 1398/1398
TypeScript: PASS
Build integral: BLOCKED BY DEPENDENCY EXTERNA DO CATÁLOGO CANÔNICO
Aquisição real: NÃO EXECUTADA
Produção: INALTERADA
Commit/push/deploy: NÃO REALIZADOS
Próximo passo: aguardar revisão e autorização explícita para a Fase 4
```

## Referências internas

[1]: `../ARCHITECTURE_CONTRACT.md` — contrato arquitetural do repositório, incluindo a fonte canônica de produtos e a cadeia do build.
[2]: `./n17_phase2_report.md` — contrato e orquestrador N17 implementados na Fase 2.
[3]: `../supabase/migrations/20260816_affiliate_infrastructure.sql` — schema N6 vigente antes da migration aditiva.
