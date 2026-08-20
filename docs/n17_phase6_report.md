# N17 — Fase 6 — Desbloqueio de Governança N15 e Wiring Runtime

**PROOF_RUN_ID:** `N17_PHASE6_LIVE_20260820T163331Z`
**SHA local de referência:** `40ae71568f2b5f9e484541818912dd18d213cb1c`
**Ambiente:** código local; verificação Supabase somente leitura
**Decisão:** `BLOCKED — NO VALID N15 AUTHORIZATION`

## Escopo executado

A Fase 6 implementou exclusivamente o lookup somente leitura de uma decisão N15 já persistida e a composição não-executável do runtime N17. A cadeia registrada no bootstrap é:

> **N15 authorization → N17 acquireN17 → N8 acquireAffiliateLink → provider oficial → N6 persistN17Acquisition**

A factory não executa aquisição durante a construção. Não foi adicionada rota N17, porque a superfície HTTP de afiliados existente continua sendo N6/N8; o runtime foi apenas injetado para consumo posterior autorizado.

## Implementação

`server/commercial/affiliate/n17AuthorizationStore.ts` implementa `createN17AuthorizationStore`. O adapter consulta `listCandidateAssessments`, filtra a versão exata `GOVERNANCE_FILTER_VERSION`, exige `dimensions.action=ACQUIRE_AFFILIATE`, `dimensions.status=APPROVED`, `input_snapshot.governance.action=ACQUIRE_AFFILIATE` e `input_snapshot.governance.status=APPROVED`, e usa `input_snapshot.governance.decision_id` como `authorization_ref`, com fallback somente para `assessment_id` quando o `decision_id` não estiver presente.

O lookup também exige `candidate_id`, `assessment_id`, `created_at` e `expires_at` explicitamente presentes no snapshot de governança. Rejeita datas inválidas, decisões futuras, decisões com mais de **168 horas** e decisões expiradas. O `candidate_id` do request N17 é passado ao lookup para impedir que uma autorização de outro candidato seja aceita. Qualquer erro de leitura ou campo ausente retorna `null`, preservando o fail-closed.

`server/commercial/affiliate/n17Runtime.ts` implementa `createN17RuntimeDeps`. A factory compõe o `authorizationStore` N15, `getProvider` do repositório N6, `n17AffiliateRepository` para `persistN17Acquisition` e `acquireAffiliateLink` do N8 com `getAffiliateApiSource` já inicializado pelo bootstrap. Nenhum transporte, GraphQL, scraping, proxy ou lógica de provider foi duplicado.

`server.ts` registra a factory depois de `registerAffiliateRoutes`. O wiring ocorre somente quando o client Supabase existe; quando não existe, o runtime é explicitamente desconectado. A construção não inicia aquisição, não cria jobs, não aciona N16, não aciona N18+ e não publica.

`n17Contract.ts` recebeu apenas a extensão opcional `candidateId` em `authorizationStore.getByRef`. `n17Service.ts` passa o `request.candidate_id` ao lookup sem alterar a validação existente de autorização, identidade, expiração ou persistência.

## Testes adicionados

`tests/n17Authorization.test.ts` adiciona sete testes locais, sem rede e sem banco real. Foram cobertos: autorização ausente; action divergente; candidate divergente; autorização expirada; autorização N15 válida projetada por `decision_id`; sequência N15→N17→N8→N6 com persistência N6; e construção da factory sem execução de aquisição.

O teste de wiring registrou a ordem efetiva `N15.getByRef → N6.getProvider → N8.acquireAffiliateLink → N6.persistN17Acquisition`. O resultado `IDENTITY_UNCERTAIN` não é convertido em sucesso pelo novo código; a lógica existente do N17 permanece intacta.

## Gates

```text
npm test       PASS — 1405/1405 testes; 92 suites
npx tsc --noEmit PASS
npm run build  PASS — catálogo/projeções gerados temporariamente pelo gate; public/data/products.json foi restaurado ao estado anterior
 git diff --check PASS
git secret scan sanitizado PASS
```

O build apresentou somente os avisos já existentes de tamanho de chunks. O artefato local `public/data/products.json` chegou a refletir o produto extra observado no endpoint de catálogo durante a geração, mas foi restaurado imediatamente; não permanece alteração desse arquivo no working tree.

## Verificação Supabase

Foi consultado o projeto `juiychcfdqxgnatffnla` em modo somente leitura, selecionando apenas `assessment_id`, `candidate_id`, `filter_version`, action/status, `decision_id`, `expires_at` e `created_at` de assessments N15 `ACQUIRE_AFFILIATE` `APPROVED`.

Resultado observado: lista vazia. Portanto, não existe atualmente uma autorização N15 legítima `APPROVED` para `ACQUIRE_AFFILIATE` que possa ser validada pelo N17. Nenhum dado artificial foi criado, nenhuma decisão foi reutilizada e nenhuma conversão de status foi feita.

O baseline Supabase observado permaneceu:

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

O valor `products=14` é a linha de base real observada no Supabase nesta fase; a alteração incidental local do catálogo foi revertida. As demais contagens permaneceram zeradas. Não foram executados INSERT, UPDATE, DELETE, migration ou cleanup.

## Limitações e dependências

O contrato N17 atual expõe `candidate_id`, `assessment_id`, `authorization_ref`, action, status e expiração. A oportunidade, marketplace e provider continuam sendo validados pelas informações do request N17, pelo `providerStore` N6 e pela comparação de identidade no fluxo N8/N17; não foi criado um novo campo de autoridade N15 nem alterada a decisão N15 para inventar um vínculo que não esteja persistido. Uma autorização real futura deverá conter a projeção N15 necessária e passar todas as validações existentes antes de qualquer aquisição.

A ausência de uma autorização N15 real impede a prova operacional da cadeia e impede qualquer classificação como `READY FOR PHASE 7`. O provider `affprv-shopee` ativo e as credenciais presentes não substituem a autorização N15.

## Itens proibidos e não executados

```text
N13: NÃO EXECUTADO
N14: NÃO EXECUTADO
N15: NÃO EXECUTADO; apenas leitura de assessments já persistidos
N16: NÃO EXECUTADO
N17 aquisição real: NÃO EXECUTADA
Shopee API real: NÃO CHAMADA
Replay/conflito N17: NÃO EXECUTADOS
N18+: NÃO INICIADO
Publicação: NÃO EXECUTADA
Telegram/scheduler/agents/job_queue: NÃO ACIONADOS
Migration: NÃO EXECUTADA
Commit: NÃO REALIZADO
Push: NÃO REALIZADO
Deploy: NÃO REALIZADO
```

## Arquivos da Fase 6

```text
server/commercial/affiliate/n17AuthorizationStore.ts  [novo]
server/commercial/affiliate/n17Runtime.ts              [novo]
server/commercial/affiliate/n17Contract.ts             [alterado: candidateId opcional no lookup]
server/commercial/affiliate/n17Service.ts              [alterado: passa candidate_id ao lookup]
server.ts                                               [alterado: imports e wiring não-executável]
tests/n17Authorization.test.ts                          [novo]
docs/n17_phase6_report.md                               [novo]
```

O working tree contém também alterações não commitadas de fases anteriores, conforme o snapshot preflight. Elas não foram consolidadas nem reescritas nesta fase.

## Conclusão

A implementação local do lookup e do wiring está concluída e os gates passaram. Entretanto, a pré-condição de autoridade não existe no Supabase: `N15 ACQUIRE_AFFILIATE APPROVED = NOT_FOUND`. O estado correto é:

```text
BLOCKED — NO VALID N15 AUTHORIZATION
READY FOR PHASE 7 = NÃO
```

**Próximo passo:** aguardar uma autorização N15 legítima `ACQUIRE_AFFILIATE` produzida pelo fluxo oficial N15, sem fabricar ou promover dados manualmente. Após sua existência, uma nova fase explicitamente autorizada poderá apenas validar a autorização e, se todas as pré-condições forem satisfeitas, realizar a prova controlada do N17.
