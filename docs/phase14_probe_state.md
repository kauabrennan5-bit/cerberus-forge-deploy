# FASE 14 — OPÇÃO B — ESTADO DA PROVA ÚNICA READ-ONLY

## Autorização
O usuário autorizou APENAS a Opção B: uma única chamada read-only à productOfferV2, registrando estritamente nomes/paths/tipos dos campos do nó de oferta. PROIBIDO nesta chamada: valores de preço reais, secrets/credenciais, qualquer efeito colateral (nada de candidate/evidence/assessment). Nenhuma implementação de parser foi autorizada — o usuário exigirá ver o schema confirmado antes de autorizar a implementação final.

## Parâmetros da chamada
- Endpoint: https://open-api.affiliate.shopee.com.br/graphql
- Operation: productOfferV2(itemId: 23794344926, shopId: 1530442944, limit: 1)
- Selection set: nodes { itemId shopId productName price productLink offerLink }
- Item: mesmo já validado nas fases anteriores (INFRA-03 Fase 14–17): item_id=23794344926, shop_id=1530442944
- Credenciais: processo.env SHOPEE_AFFILIATE_APP_ID / SHOPEE_AFFILIATE_APP_SECRET (presença somente)

## Artefato
- Script: scripts/probe_offer_schema.ts (criado nesta fase; não commitado)
  - SANITIZAÇÃO: sanitizeError redacta Credential/Signature/hex>=32 chars
  - observeSchema: registra {path, type, present} por campo; NUNCA valores
  - identityMatch: compara itemId/shopId com os pedidos (somente igualdade)
  - price NÃO é logado; type descreve price como "string"/"number"/"null"
  - Saída: docs/phase14_schema_probe_result.json (local apenas)
- PROOF_RUN_ID: PHASE14_SCHEMA_PROBE_20260820

## Contexto do bloqueio (para a proposta)
- contract.ts:193 MIN_DIMENSIONS_KNOWN=2; Shopee atual: 0 dimensões KNOWN → INSUFFICIENT
- price real = STRING (Fase 17); unidade/moeda/escala não comprovadas (Fase 19)
- availability/seller/commission/market/competition: sem contrato Affiliate
- Proposta futura (a submeter ao usuário): parse determinístico fail-closed do price string p/ number com currency=BRL, promovendo price KNOWN (só 1 dimensão) — se o schema mostrar price number, normalização direta; se mostrar string com semântica observável (ex.: formato "X.YY"), aplicar regex estrita; caso contrário UNKNOWN.
- Necessárias 2 dimensões para SUFFICIENT; price sozinho NÃO desbloqueia N14. Segunda dimensão candidata: availability observada real (se campo existir no schema) ou seller rating.

## Execução
- Rodar em ambiente local: npx tsx scripts/probe_offer_schema.ts — o ambiente local NÃO possui as envs do Render (verificação de presença: se ABSENT → SKIPPED, sem chamar API).
- Para executar contra a API, usar o runtime Render NÃO é possível localmente; alternativa: chamada HTTPS com curl e credenciais do Render NÃO disponíveis localmente. Verificar presença com node -e antes.

## GATES
- npm test / tsc / build ainda NÃO executados (sem alteração funcional).
- Nenhuma alteração no banco. Baseline esperado inalterado.
