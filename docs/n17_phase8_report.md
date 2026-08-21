# N17 — Fase 8 — Relatório final

```text
PROOF_RUN_ID=N17_PHASE8_REAL_FLOW_20260820T174500Z
DECISION=BLOCKED — N15 INSUFFICIENT/BLOCKED
N17=NOT_OPERATIONAL_FOR_REAL_ACQUISITION
READY_FOR_N18=NO
```

## Escopo executado

Foi utilizado o fluxo oficial já existente, sem INSERT manual, sem criação artificial de identificadores e sem bypass de N13, N14 ou N15. A oportunidade veio de um produto Shopee real já persistido no catálogo e foi encaminhada pela rota administrativa normal de discovery.

A cadeia executada foi:

```text
produto Shopee real persistido
→ discovery oficial N2
→ research/evidence oficial N3
→ curadoria oficial N13
→ Commercial Brain oficial N14
→ Governance oficial N15 ACQUIRE_AFFILIATE
→ parada fail-closed
```

A cadeia N17→N8→provider→N6 não foi acionada porque N15 não produziu autorização APPROVED legítima.

## Identidade da oportunidade

```text
candidate_id=can-ece13fcbc69dad6e46eb8abe
marketplace=Shopee
external_listing_id=shopee-423833774-25690571694
source_product_id=423833774
source_shop_id=25690571694
```

Os identificadores acima foram observados no registro real criado pelo discovery oficial. Nenhum identificador foi inventado.

## Resultados por bloco

```text
N2 discovery=PASS — candidato real criado pela entrada oficial
N3 research=EXECUTED — evidence real criada
N13=PASS
N13 assessment_id=cur-d8d21e73b212ced4d79974c028e116e8e0713c3d
N14=INSUFFICIENT
N14 assessment_id=cb-ece13fcbc69dad6e46eb8abe
N15 action=ACQUIRE_AFFILIATE
N15=BLOCKED
N15 assessment_id=gov-ece13fcbc69dad6e46eb8abe-ACQUIRE_AFFILIATE-sha256:2e8e69b761d423ffe83be7905e495726f7f793704ce0514f5ec5c839375c81f3
authorization_ref=NOT_CREATED — decisão não APPROVED
N17=NOT_EXECUTED
N8/Shopee API=NOT_CALLED
affiliate_link_id=NOT_CREATED
acquisition_ref=NOT_CREATED
response_digest=NOT_CREATED
replay=NOT_EXECUTED
conflict=NOT_EXECUTED
N16 resolver=NOT_EXECUTED
publication=NOT_EXECUTED
N18/N19/N20=NOT_STARTED
```

## Diagnóstico do bloqueio

O N14 retornou `INSUFFICIENT` porque a oportunidade real não possuía dimensões comerciais Shopee suficientemente comprovadas para sustentar uma decisão afirmativa. Nenhum score, preço, disponibilidade, comissão, competição ou market foi inventado ou promovido de `UNKNOWN` para `KNOWN`.

Também foi observado um desalinhamento estrutural de proveniência entre o discovery e a governança. O discovery persistiu `metadata.provenance=n10:discovery`, mas também persistiu `metadata.source` com um valor de origem de campo, como `marketplace_page` ou `unknown`. O N14 deriva a proveniência comercial de `metadata.source`, e o snapshot N15 prioriza esse mesmo campo antes de `metadata.provenance`. Consequentemente, a policy N15 avaliou `provenance_valid=false` e registrou `provenance_invalid`.

Esse desalinhamento não foi corrigido nesta fase. Alterá-lo sem uma decisão arquitetural explícita poderia mudar a semântica de proveniência de N14/N15 e não resolveria, por si só, a insuficiência comercial do N14. O comportamento correto permaneceu fail-closed.

## Cleanup seletivo

O cleanup foi executado somente para `candidate_id=can-ece13fcbc69dad6e46eb8abe`, na ordem governada:

```text
1. publication_executions vinculadas ao candidato: 0 removidas
2. candidate_assessment do candidato: 3 removidos
3. candidate_evidence do candidato: 9 removidas
4. candidates do candidato: 1 removido
```

Nenhum produto canônico foi alterado. Nenhum affiliate link, job, publicação ou ciclo comercial foi criado pela prova.

## Baseline Supabase

```text
ANTES:
products=14
candidates=0
candidate_evidence=0
candidate_assessment=0
affiliate_links=0
job_queue=0
publication_executions=0
commercial_cycles=0

DEPOIS:
products=14
candidates=0
candidate_evidence=0
candidate_assessment=0
affiliate_links=0
job_queue=0
publication_executions=0
commercial_cycles=0
```

## Gates

```text
npm test=PASS — 1405/1405
npx tsc --noEmit=PASS
npm run build=PASS
git diff --check=PASS
secret scan sanitizado=PASS
Render /health=PASS
Render SHA servido=458b10878112d6b96d513e68e3929875cf5db497
```

Os gates foram executados após a implementação e publicação do wiring N17. A Fase 8 não alterou código; portanto não houve novo commit funcional durante esta prova.

## Commit, push e deploy

```text
commit funcional N17=458b10878112d6b96d513e68e3929875cf5db497
push=CONCLUÍDO
Render deploy=CONCLUÍDO
SHA servido=458b10878112d6b96d513e68e3929875cf5db497
```

## Decisão final

```text
DECISION=BLOCKED — N15 NÃO PRODUZIU APPROVED ACQUIRE_AFFILIATE
N17=NOT_OPERATIONAL_FOR_REAL_ACQUISITION
READY_FOR_N18=NO
```

A correção mínima necessária é tratar, em uma fase própria e autorizada, o contrato de proveniência entre N2, N14 e N15 e ampliar a cobertura comercial Shopee somente com evidência contratual válida. Mesmo após essa correção, a execução só poderá prosseguir se o N14 produzir uma avaliação suficiente e o N15 produzir legitimamente `APPROVED / ACQUIRE_AFFILIATE`. Não foi iniciada aquisição real, replay, conflito, resolução N16, publicação ou N18+.
