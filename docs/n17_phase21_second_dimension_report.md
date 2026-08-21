# N17 — Investigação Exclusiva da 2ª Dimensão Comercial Shopee

**PROOF_RUN_ID:** `N17_PHASE21_SECOND_DIMENSION_20260820`
**Data:** 20 de agosto de 2026
**Execução:** exclusivamente auditoria documental e de código local, sobre a evidência real já coletada nas Fases 14 e 21–24. **Nenhuma alteração de código, nenhuma nova chamada Shopee, nenhum commit, push ou deploy.** Não foram executados N2–N15, N16, N17, N18, nenhuma aquisição e nenhum N15 como se aprovado. `MIN_DIMENSIONS_KNOWN=2` e toda a política N14/N15 permanecem intocadas.

## 1. Resultado

> **SECOND_DIMENSION = NOT_AVAILABLE**

Nenhuma segunda dimensão comercial pode ser legitimamente marcada como KNOWN para uma oportunidade Shopee Affiliate real com os acessos e contratos existentes. As evidências coletadas nas fases autorizadas anteriores, agora consolidadas com a auditoria completa das superfícies do projeto, provam que a API oficial afiliada fornece exatamente **uma** dimensão comercial utilizável: `price` (com escala UNVERIFIED).

## 2. Auditoria das superfícies oficiais (prompt, segunda parte)

Antes de concluir, foi verificado se existe dimensão que o N14 já considera KNOWN por definição, mas que não está sendo transportada pelo Evidence Bridge. A varredura cobriu `candidate_evidence` (contrato e adapter), `evidenceSignals.ts`, o adapter Shopee, o selection set real, a derivação de sinais do Commercial Brain e os contratos de provenance/field_state.

| Fonte | Campo | Estado hoje | Motivo do não-transporte |
| --- | --- | --- | --- |
| Evidence Bridge (`TRANSPORTABLE_FIELDS = [price, seller, availability]`) | `price` | Transportado (Fase 20) | — |
| Evidência oficial | `title` (productName) | KNOWN na evidência | Deliberadamente excluído por design — regra estabelecida: title não é dimensão comercial do N14 |
| Evidência oficial | `rating`, `review_count`, `category`, `images` | UNKNOWN (adapter registra ausência) | O selection set oficial não fornece esses dados; o adapter já os trata como `UNKNOWN_NOT_RETURNED_BY_OFFICIAL_SHOPEE_OPERATION` |
| Identidade | `itemId`, `shopId` | Verificada no N13 | Identidade é pré-condição de curadoria, não dimensão comercial do N14 |
| Evidência oficial | `productLink`, `offerLink` | KNOWN (URLs) | URLs de aquisição/rota, sem dimensão correspondente em `CommercialSignalsInput` |
| Comercial | `currency` | UNKNOWN | Não retornado pela API (inexistente no selection set autorizado) — corretamente permanece UNKNOWN |

**Conclusão:** não existe dimensão KNOWN legítima presa no Evidence Bridge sem transporte. O único KNOWN comercial real (price) já é transportado; todo o restante não pode ser transportado porque não existe como evidência KNOWN.

## 3. Matriz final por dimensão (classificação A–E do prompt)

A classificação abaixo consolida o probe real em runtime autenticado da Fase 14 (expansão máxima do selection set: 25 campos extras testados por bissection, todos rejeitados com o erro oficial `10010` — inclusive um campo inventado, comprovando policy global, não seleção) com as auditorias documentais das Fases 21–24.

| field | API / operation | real_observed | identity_confirmed | official_contract | policy_status | same_item_proven | safe_for_N14 | Categoria |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `price` | productOfferV2 | true (string) | true | A — mapeamento oficial de 6 campos | permitido | yes | **YES (única)** | A |
| `offerLink` | productOfferV2 | true (string url-like) | true | A — mapeamento oficial | permitido | yes | NO (é a própria aquisição N8, não dimensão) | A |
| `productName` | productOfferV2 | true (string) | true | A — mapeamento oficial | permitido | yes | NO (excluído por design) | A |
| `seller` | productOfferV2 | false | — | — | **10010 FORBIDDEN** (stockInfo, seller, sellerId, sellerName, sellerRating rejeitados na bissection da Fase 14) | — | NO | **D** |
| `availability` | productOfferV2 | false | — | — | Não existe no mapeamento; Fase 21: BLOCKED — CONTRACT UNSPECIFIED | — | NO | **D/E** |
| `commission` | productOfferV2 | false | — | — | Fase 22: BLOCKED — CONTRACT UNSPECIFIED | — | NO | **E** |
| `competition` | productOfferV2 | false | — | — | Fase 23: BLOCKED — CONTRACT UNSPECIFIED | — | NO | **E** |
| `market` | productOfferV2 | false | — | — | Fase 24: BLOCKED — CONTRACT UNSPECIFIED | — | NO | **E** |

A Fase 14 registrou textualmente a conclusão contratual observada em runtime autenticado:

> "a plataforma aplica uma POLICY GLOBAL que bloqueia qualquer campo além do mapeamento oficial de 6 campos, independentemente do nome. Não existe seleção estendida autorizada para apps afiliadas. availability, commission, competition e market seguem BLOCKED — PLATFORM_POLICY_10010, não há source alternativa oficial com vínculo de identidade."

## 4. Decisão sobre a prova real

O prompt permitia uma prova read-only real caso existisse candidato. **Não foi executada nenhuma nova prova**, e essa decisão é objetiva: a Fase 14 já executou a expansão máxima legítima do selection set em runtime autenticado com credenciais reais, cobrindo o mapeamento oficial de discovery e 25 campos extras por bissection. A policy é global — qualquer campo adicional, conhecido ou inventado, retorna o mesmo erro `10010`. Executar nova prova significaria inventar nomes de campo sem contrato, exatamente o que o prompt proíbe ("Não inventar campo", "Não inferir dimensão"). Não há candidato razoável para prova; repetir a Fase 14 não produziria informação nova.

## 5. Menor mudança necessária

**Nenhuma.** Dentro do contrato Shopee atual não existe modificação mínima de adapter, bridge ou N14 capaz de promover uma segunda dimensão a KNOWN — não é lacuna de código, é limite contratual da plataforma. Qualquer "mudança" nesse sentido violaria as regras absolutas (heuristicas, conversão de UNKNOWN, dimensão inventada).

## 6. Dependência externa exata

Para que `N14 = SUFFICIENT` seja alcançável com evidência real, é necessária **exatamente uma** das seguintes dependências externas, ambas fora do controle do projeto:

| # | Dependência externa | O que resolveria | Como obtê-la |
| --- | --- | --- | --- |
| 1 | **Campo adicional oficial na Affiliate API `productOfferV2`** (ex.: disponibilidade/estoque) autorizado para o mapeamento de afiliados | 2ª dimensão KNOWN com contrato e identity binding nativos (mesmo nó do item) | A Shopee liberar campos além do mapeamento de 6 — hoje bloqueado por policy global `10010`. Depende de contato com o programa de afiliados da Shopee BR ou mudança de política da plataforma. |
| 2 | **Outra API Shopee oficial com vínculo de identidade comprovável** para o mesmo `(item_id, shop_id)` e contrato explícito dos campos | 2ª dimensão KNOWN de fonte alternativa oficial | Ex.: Seller API — exige uma conta **seller** própria com autorização e, principalmente, a demonstração do identity binding entre a conta seller e o `(item_id, shop_id)` da conta afiliada. Sem esse vínculo demonstrável, a fonte alternativa é rejeitável pelo N14 (o prompt proíbe "campo de outra API Shopee sem prova de identidade e autorização"). |

A resolução da incerteza de **escala do price** (especificação oficial de moeda/unidade da string) é uma dependência externa complementar e válida, mas **não resolve o N14**: converteria price para KNOWN com `priceMinorUnits` verificado, permanecendo 1 dimensão contra `MIN_DIMENSIONS_KNOWN=2`.

## 7. Confirmações de governança

Nenhuma linha de código foi alterada; `git diff` vazio (nada a commitar); nenhum fluxo N2–N15 executado; nenhuma aquisição N8/N17/N6; N16/N18 não executados; catálogo canônico não tocado (baseline: 14 products, 0 candidatos/evidências/assessments); thresholds, pesos, `MIN_DIMENSIONS_KNOWN=2` e a política N15 permanecem exatamente como estão. O N15 segue corretamente `BLOCKED` para qualquer oportunidade Shopee até que a dependência externa acima seja obtida.
