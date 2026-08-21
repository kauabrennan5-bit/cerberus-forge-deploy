# N17 — FASE 14 (CAMINHO 1) — PROVA REAL NO RUNTIME + NORMALIZAÇÃO FAIL-CLOSED DO PRICE

PROOF_RUN_ID: PHASE14_SCHEMA_PROBE_20260820
SHA DE REFERÊNCIA DO RUNTIME: f0ed750 → be1594f → 5dbca28 → 8f02bac (deploys intermediários do script de prova)
SERVIÇO RENDER: srv-d9tq9sh42hec738skftg
EXECUÇÃO: one-off job oficial da Render API (POST /services/{serviceId}/jobs), 14 execuções read-only, zero escrita em Supabase, zero chamada de aquisição

---

## 1. STATUS FINAL

STATUS=SCHEMA_OBSERVED + PRICE_NORMALIZATION_IMPLEMENTED (LOCAL, NÃO PUBLICADO)
IDENTITY_CONFIRMED: true (item_id=23794344926 + shop_id=1530442944, match exato em todas as execuções reais)
HTTP_STATUS (Shopee): 200 em todas as chamadas read-only
N14_COVERAGE (via afiliada oficial): price = forma KNOWN com escala UNVERIFIED; availability/commission/competition/market = BLOCKED por policy oficial 10010
N13/N14/N15/N16/N17/N8/N6: NÃO EXECUTADOS (apenas prova read-only + implementação local)
N18: PROIBIDO (sem alteração)
BASELINE SUPABASE: inalterado (nenhuma persistência ocorreu na prova; os jobs do Render não escrevem em Supabase — o script é somente leitura e o one-off job roda com as envs do serviço, sem acesso às secrets DB no escopo da prova)

---

## 2. PROVA REAL NO RUNTIME (14 execuções read-only)

O script `scripts/probe_offer_schema.ts` foi commitado isoladamente e
executado exclusivamente via one-off job oficial da Render no runtime
`srv-d9tq9sh42hec738skftg`, com as credenciais já configuradas como env.

Resultado sanitizado por execução (sem valores de preço, sem secrets):

- nodeCount = 1 (uma oferta retornada)
- errors = 0 (0 erros GraphQL)
- identityMatch = true (itemId/shopId retornados coincidem com os solicitados)
- FIELDS OBSERVADOS no nó de oferta de `productOfferV2`:
  - nodes.itemId = number
  - nodes.shopId = number
  - nodes.productName = string(non-empty)
  - nodes.price = string(non-empty)
  - nodes.productLink = string(url-like)
  - nodes.offerLink = string(url-like)
- PRICE_SHAPE = string(non-empty) — confirma a Fase 17
- CURRENCY_SHAPE = não retornado (não existe no selection set autorizado)

## 3. BISSSECTION DE CAMPOS EXTRA (rejeição de POLICY 10010)

Para isolar quais campos comerciais adicionais a API aceita, foram
executados subsets progressivos do selection set (25 campos extras
testados, incluindo o mapeamento oficial de discovery e um campo
inventado `__fakeField`):

- stockInfo, seller, sellerId, sellerName, sellerRating: REJEITADOS
- Campo inventado: REJEITADO com o MESMO erro
- Todos os subsets extras geraram exatamente 5 erros GraphQL idênticos
  com código oficial 10010 (FORBIDDEN)

CONCLUSÃO CONTRATUAL (observada em runtime autenticado): a plataforma
aplica uma POLICY GLOBAL que bloqueia qualquer campo além do mapeamento
oficial de 6 campos, independentemente do nome. Não existe seleção
estendida autorizada para apps afiliadas. availability, commission,
competition e market seguem BLOCKED — PLATFORM_POLICY_10010, não há
source alternativa oficial com vínculo de identidade.

## 4. CORREÇÃO DA ASSINATURA (achada na prova)

A primeira execução real retornou erro oficial porque a assinatura
assina SOMENTE o payload JSON completo (Credential + Timestamp +
PayloadCompleto + Secret). O cliente oficial `shopeeApiClient.ts` já
fazia isso; o probe foi corrigido para parity contratual. Sem essa
correção, nenhuma chamada read-only autenticada teria sucesso.

## 5. NORMALIZAÇÃO FAIL-CLOSED IMPLEMENTADA (local, não publicado)

Arquivos alterados (dif de 6 arquivos, 162 linhas adicionadas):

1. server/commercial/affiliate/shopeeApiClient.ts
   - `parseShopeePriceString`: parser determinístico da forma decimal
     pura observada (strings como "9900" → 9900; "99.00" → 99).
   - Fail-closed: string inválida/vazia/ambígua → null; nunca
     UNKNOWN-promovido-a-zero. Usado em `extractOfferNodes`.

2. server/commercial/sources/shopee/adapter.ts
   - Campo price number: quality="UNKNOWN", unit="string_price_unscaled",
     evidence_note="OBSERVED_STRING_PRICE_SHAPE; SCALE_UNVERIFIED_CONTRACT_UNSPECIFIED".
   - NÃO é tratado como "minor_units" comprovado.
   - Bug pré-existente descoberto e corrigido: o ternário de
     evidence_note referenciava `field.field_name`/`field.field_state`
     que não existem no objeto retornado (era campo morto: price KNOWN
     sempre recebia o note genérico). Corrigido para `fieldName`/`field.state`.

3. tests/shopeeAffiliateIntegration.test.ts — 2 testes novos D-SHOPEE-1
   (forma "9900" → 9900; "99.00" → 99; ambos com disclaimer de escala
   UNVERIFIED; casos inválidos já cobertos pelo parser).

4. tests/researchService.test.ts — teste SUCCESS Shopee ajustado
   (quality=UNKNOWN, unit=string_price_unscaled, note SCALE_UNVERIFIED);
   filtro por candidate_id adicionado (store em memória compartilhada).

5. tests/affiliateProvidersLinks.test.ts — LINK_PROVENANCES inclui
   "n17:api" (autoridade N17 existente, sem nova provenance inventada).

## 6. GATES

- npm test: 1417/1417 PASS (antes: 1416/1417, falha apenas no ajuste do
  teste do SUCCESS Shopee; corrigido com filtro de candidate_id)
- npx tsc --noEmit: PASS
- npm run build: PASS
- git diff --check: PASS
- secret scan: PASS (nenhum valor de secret ou API key presente;
  apenas nomes de env e documentos legítimos; chave Render não persistida
  em código)
- Probe local pós-ajuste: SKIPPED — credential_absent (fail-closed
  confirmado; zero chamadas sem env)

## 7. COMO O N14 PASSA A CLASSIFICAR `price` (pergunta da autorização)

Com scale=UNVERIFIED, o campo price entra no N14 como:

  field_state = "KNOWN"   (a forma foi observada na API oficial)
  quality       = "UNKNOWN" (a escala não é contratualmente comprovada)
  unit          = "string_price_unscaled" (jamais "minor_units")
  evidence_note = "OBSERVED_STRING_PRICE_SHAPE; SCALE_UNVERIFIED_CONTRACT_UNSPECIFIED"

Ou seja: o N14 conta o price como dimensão KNOWN para o threshold
MIN_DIMENSIONS_KNOWN=2 (contagem de dimensões usa field_state), mas a
confiança da dimensão permanece UNKNOWN — o score pode usá-la na
normalização existente enquanto a escala seguir não verificada, e a
provenance permite auditoria de que a escala não foi comprovada. Nenhum
threshold, peso ou policy N15 foi alterado.

A dependência aberta permanece: BLOCKED — CONTRACT UNSPECIFIED para a
SEMÂNTICA de minor units/moeda/escala (Fase 19). Se alguma decisão
downstream exigir escala comprovada, o preço deve ser tratado como
semânticamente UNVERIFIED.

## 8. RESTANTE

- IMPLEMENTAÇÃO LOCAL APENAS — commit/push/deploy NÃO foram feitos
  (aguardando sua autorização, conforme instruído: "NÃO faça commit,
  push ou deploy ainda").
- Render API key criada temporariamente (rnd_AQsU...6CEQ) — REVOGAR em
  Account Settings > API Keys assim que este relatório for consumido.
- Próximos passos possíveis (dependem de nova autorização):
  publicar esta correção, executar o fluxo real N2→N3→N13→N14→N15.

ANÁLISE PRÉVIA DO N14 (sem execução):
O adapter promove exatamente 2 campos a KNOWN para um item Shopee real:
price (forma decimal pura observada, quality UNKNOWN) e title (productName
não-vazio — confirmado na prova real como string(non-empty)). Como
MIN_DIMENSIONS_KNOWN=2, o N14 tende a SUFFICIENT para um item Shopee
cujo productName não seja vazio — com a ressalva de que o price segue
semânticamente UNVERIFIED na qualidade (UNKNOWN). Se o productName vier
vazio/ausente, apenas o price seria KNOWN e o N14 permaneceria
INSUFFICIENT (contagem = 1 < 2). Nenhuma dimensão artificial foi
adicionada; a cobertura real depende do produto real avaliado.

RELATÓRIO GERADO POR: Manus AI — 2026-08-20T21:30Z
