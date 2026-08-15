# Bloco 13 — Contrato de implementação local

## Decisão arquitetural

O problema resolvido é a ausência de uma camada durável para registrar evidências temporais sobre um produto sem converter a evidência em verdade canônica. A camada responsável é um repository aditivo sobre quatro tabelas auxiliares em `public`, sem alterar o lifecycle, os endpoints de products, o catálogo, o Operator, o Telegram ou a job_queue.

A fonte canônica continua sendo `public.products`. As novas tabelas armazenam observações contextualizadas e reversíveis, associadas a `product_id`, com timestamp, fonte, correlação, idempotência, confiança e metadados sanitizados. Nenhuma função da nova camada atualiza products ou sincroniza o catálogo.

## Arquivos autorizados nesta etapa local

| Arquivo | Motivo |
|---|---|
| `supabase/migrations/20260816_product_observations.sql` | Migration aditiva, RLS, zero policies públicas, constraints, índices e comentários de semântica não canônica. |
| `server/repositories/productObservationsRepository.ts` | Persistência idempotente, validação da associação ao product, sanitização e leituras por produto. |
| `tests/productObservationsRepository.test.ts` | Testes determinísticos de contrato, isolamento e falhas explícitas. |
| `bloco13_implementation_contract.md` | Registro do desenho aprovado localmente e das fronteiras de escopo. |

Não serão alterados `productsRepository.ts`, `server.ts`, `productLifecycle.ts`, `jobQueueRepository.ts`, `jobQueueScheduler.ts`, `operationalEvents.ts`, dados, catálogo, Telegram, Operator ou configurações de produção.

## Migration proposta

As quatro tabelas serão `product_price_observed`, `product_availability_observed`, `product_source_observed` e `product_image_observed`. Todas terão `observation_id` como chave primária, `product_id` como referência ao produto canônico, campos de origem e tempo, `correlation_id`, `idempotency_key` nullable com unique index por tabela, `confidence`, `metadata` JSONB de objeto, `schema_version` e `created_at`. O preço terá `observed_price` e `currency`; disponibilidade terá `observed_availability`; source terá `source_kind`; imagem terá `image_url` e hash opcional.

O vínculo ao produto usa FK `on delete restrict` porque o projeto arquiva products por lifecycle em vez de apagar registros; isso protege a proveniência sem adicionar mutação ao fluxo existente. A migration não executa backfill e não insere dados reais.

## Regras de parada

A implementação local será interrompida se houver necessidade de mudar products, catálogo, job_queue, Operator, Telegram, autoridade, políticas públicas, ou qualquer contrato não previsto. O processo chegará no máximo a `READY FOR REVIEW`; não haverá commit, push, migration em produção ou deploy nesta etapa.
