# N17 — Fase 7 — Finalização Operacional e Desbloqueio Definitivo

```text
PROOF_RUN_ID=N17_PHASE7_LIVE_20260820T171500Z
STATUS=BLOCKED — NO REAL CANDIDATE PRECONDITION
DECISION=N17 NÃO É OPERATIONAL / READY FOR N18
```

## Resultado executivo

A infraestrutura N17 foi consolidada e publicada pela via autorizada, mas a prova operacional foi interrompida no primeiro bloqueio legítimo. O Supabase não possui nenhum candidato real no momento da verificação. Sem `candidate_id` real, não é possível iniciar legitimamente N13, N14 ou N15 para produzir uma autorização `ACQUIRE_AFFILIATE` `APPROVED`.

Nenhum candidato, evidência, assessment, decisão N15, identidade Shopee ou affiliate URL foi inventado, reutilizado, convertido ou inserido manualmente. A ausência de candidato é tratada como dependência externa e o fail-closed foi preservado.

## SHA, commit, push e deploy

```text
SHA inicial local/preflight=729aac8e3349978c9f0e42d9cf5954256cf123dc
SHA inicial servido pelo Render=729aac8e3349978c9f0e42d9cf5954256cf123dc
SHA final local=458b10878112d6b96d513e68e3929875cf5db497
SHA final em origin/main=458b10878112d6b96d513e68e3929875cf5db497
SHA final servido pelo Render=458b10878112d6b96d513e68e3929875cf5db497
COMMIT=458b10878112d6b96d513e68e3929875cf5db497
PUSH=PASS — origin/main
DEPLOY=PASS — Render servido o SHA final
RENDER_HEALTH=ok
```

O commit contém o wiring N17, a rota administrativa fina, o lookup N15 somente leitura, os testes, a migration já preparada e os artefatos documentais N17. Não houve alteração de N13, N14, N16, Telegram, scheduler, agents ou transporte paralelo da Shopee.

## Wiring publicado

O bootstrap publicado registra explicitamente a composição:

```text
N15 authorization lookup
→ N17 acquireN17
→ N8 acquireAffiliateLink
→ provider oficial affprv-shopee
→ N6 persistN17Acquisition
```

A rota administrativa publicada é:

```text
POST /api/commercial/affiliate/n17/acquire
```

A rota apenas adapta HTTP ao runtime. Ela não decide governança, não implementa transporte GraphQL, não resolve identidade fora do N8, não persiste fora do N6 e não aciona N16, N18, Telegram ou scheduler durante a construção ou o bootstrap.

## Pré-condição N15

A rota oficial N15 auditada permanece:

```text
POST /api/commercial/governance/decide
```

A ação `ACQUIRE_AFFILIATE` é aceita pelo contrato e pela policy N15. A policy exige, entre outros gates, candidato existente, N13 `PASS`, assessment N14 existente e válido, score mínimo, banda válida, proveniência válida, compatibilidade N8 e autorização administrativa.

A verificação somente leitura do Supabase encontrou:

```text
public.candidates=0
public.candidate_evidence=0
public.candidate_assessment=0
N15 ACQUIRE_AFFILIATE APPROVED=NOT_FOUND
```

Consequentemente, os identificadores abaixo não existem para esta prova:

```text
authorization_ref=NOT_CREATED
assessment_id=NOT_CREATED
candidate_id=NOT_AVAILABLE
source_product_id=NOT_AVAILABLE
source_shop_id=NOT_AVAILABLE
public_product_url=NOT_AVAILABLE
idempotency_key=NOT_CREATED
```

Não foi chamada a rota N15 de decisão, pois não havia candidato real para submeter ao fluxo oficial.

## Aquisição e downstream

```text
N15 APPROVED=NOT PROVEN
N17 runtime real=NOT EXECUTED
N8 acquireAffiliateLink=NOT EXECUTED
Shopee API real=NOT CALLED
Identidade Shopee=NOT OBSERVED
affiliate URL oficial=NOT OBSERVED
N6 persistN17Acquisition=NOT EXECUTED
affiliate_link_id=NOT_CREATED
acquisition_ref=NOT_CREATED
response_digest=NOT_CREATED
replay ALREADY_ACQUIRED=NOT EXECUTED
conflito de idempotência BLOCKED=NOT EXECUTED
N16 resolver=NOT EXECUTED
publicação=NOT EXECUTED
N18+=NOT STARTED
Telegram/scheduler/agents/job_queue=NOT ACCESSED
```

A prova foi encerrada antes de qualquer chamada comercial ou escrita downstream. Não houve cleanup porque nenhum dado foi criado nesta fase.

## Baseline Supabase pós-deploy

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

O baseline confirma que o deploy e a verificação não criaram candidatos, evidências, assessments, links, jobs, execuções de publicação ou ciclos comerciais.

## Gates

```text
npm test=PASS — 1405/1405 testes; 92 suites
npx tsc --noEmit=PASS
npm run build=PASS
git diff --check=PASS
git secret scan sanitizado=PASS
Render /health=PASS — status ok e SHA final servido
```

O build emitiu somente o aviso já conhecido de tamanho de chunks. O artefato temporário do catálogo foi conferido e não permaneceu como alteração funcional deste bloco.

## Decisão final

```text
N17=BLOCKED — NO REAL CANDIDATE PRECONDITION
READY FOR N18=NO
N13/N14/N15 execução downstream=NÃO EXECUTADOS
N17 aquisição real=NÃO EXECUTADA
Shopee API=NÃO CHAMADA
N16 resolver=NÃO EXECUTADO
```

O próximo passo mínimo é disponibilizar uma oportunidade/candidato real pelo fluxo oficial, com identidade externa e evidência legítima. Somente depois disso uma nova autorização explícita poderá retomar N13 → N14 → N15 → N17. Nenhuma autorização artificial deve ser criada.
