━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
INFRA-02 — FASE 2 — RELATÓRIO FINAL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

PROOF_RUN_ID:
INFRA02_PHASE2_20260819T220732Z

STATUS:
INFRA-02 — FASE 2 CONCLUÍDA COM LIMITAÇÕES
ADAPTADOR OFICIAL IMPLEMENTADO
TESTES LOCAIS PASS
VALIDAÇÃO REAL SKIPPED — DEPENDÊNCIA EXTERNA
READY FOR REVIEW
READY FOR FASE 3 SOMENTE APÓS CREDENCIAIS/PERMISSÕES OFICIAIS

1. OBJETIVO

Implementar localmente um adaptador isolado para a API REST oficial do Mercado Livre, anterior ao N13, capaz de consultar um ITEM_ID, validar a identidade retornada, normalizar somente campos observados, registrar provenance segura e falhar fechado diante de qualquer erro de autenticação, transporte, HTTP, JSON ou schema.

2. ESCOPO EXECUTADO

Foi implementado somente o namespace INFRA-02. O adaptador não possui integração com banco, candidates, candidate_evidence, candidate_assessment, N13, N14, N15, N16, N17, affiliate_links, job_queue, Telegram, scheduler, agents ou publicação.

Não foi implementada chamada real. Não foram configuradas credenciais. Não houve migration, alteração de schema, alteração de produção, commit, push ou deploy.

3. AUDITORIA INICIAL

Snapshot antes da implementação:

UTC=2026-08-19T22:07:28Z
HEAD=44a31d687ae06d2398e6651ad1009e3acfbeefbd
ORIGIN_MAIN=44a31d687ae06d2398e6651ad1009e3acfbeefbd

O working tree já continha relatórios não rastreados de blocos anteriores. Nenhum arquivo rastreado foi alterado pelo INFRA-02. Os novos arquivos estão separados dos artefatos preexistentes.

4. ARQUITETURA

O fluxo local é:

input itemId/sourceUrl
→ validação estrita de ITEM_ID
→ construção do endpoint oficial /items?ids=...&attributes=...
→ transporte HTTP injetável
→ Authorization: Bearer <access token>
→ classificação HTTP/transport/error
→ validação do envelope verbose documentado
→ confirmação de body.id contra o ITEM_ID solicitado
→ normalização de campos observados
→ response_digest do conteúdo
→ REAL_API_OBSERVATION ou falha COLLECTION_FAILED

A implementação permanece como camada de fonte/evidência. Ela não julga suficiência comercial e não autoriza nem executa publicação.

5. ARQUIVOS CRIADOS/MODIFICADOS

Criados:

server/commercial/sources/mercadoLivre/contracts.ts
server/commercial/sources/mercadoLivre/adapter.ts
server/commercial/sources/mercadoLivre/fixtures.ts
tests/mercadoLivreOfficialAdapter.test.ts
docs/infra02_phase2_report.md

Nenhum arquivo existente de N1–N16 foi modificado. Em particular, não foram alterados n13, n14, n15, n16, governance, publication, publication_executions, server.ts, products, candidates ou jobs.

6. ENDPOINT OFICIAL

Base padrão:
https://api.mercadolibre.com

Recurso:
GET /items?ids={ITEM_ID}&attributes=id,site_id,title,seller_id,category_id,price,currency_id,initial_quantity,available_quantity,date_created,last_updated

A lista de atributos é limitada aos campos documentados e necessários para a evidência. Nenhuma URL de imagem ou link comercial é construído pelo adaptador.

7. AUTENTICAÇÃO

O adaptador recebe accessToken por opção injetada. A chamada real usaria:

Authorization: Bearer <access token>
Accept: application/json

Token ausente resulta em AUTH_REQUIRED sem request. O token não é devolvido, persistido, incluído no digest ou impresso nos testes. Não foram adicionados envs, secrets ou integração de produção.

8. NORMALIZAÇÃO

Campos normalizados quando presentes e válidos:

item_id
site_id
title
seller_id
category_id
price
currency_id
initial_quantity
available_quantity_observed
availability_semantics
date_created
last_updated

available_quantity é mantido como available_quantity_observed e recebe availability_semantics=REFERENCE_OR_RANGE. Não é convertido em estoque exato.

Campos opcionais ausentes permanecem null no objeto normalizado e UNKNOWN no field_states. O valor null não substitui o estado: o estado é registrado separadamente.

seller_name, seller_reputation, rating, review_count, category_name, commission, competition e market_demand permanecem UNKNOWN. Nenhum enriquecimento ou inferência foi implementado.

9. PROVENANCE

Em sucesso, a provenance contém:

source_type=api
collection_method=API
external_listing_id=body.id confirmado
observed_at=timestamp UTC
http_status=status HTTP observado
response_digest=SHA-256 do conteúdo observado
field_state=KNOWN
field_states=estado individual por campo

Em falha de coleta, external_listing_id e response_digest permanecem null e os campos recebem COLLECTION_FAILED. O ITEM_ID enviado não é tratado como identidade confirmada até que o body.id da API coincida após normalização canônica.

10. RESPONSE_DIGEST

O digest é SHA-256 de uma serialização JSON determinística do payload de conteúdo observado. Objetos têm propriedades ordenadas lexicograficamente e arrays preservam a ordem. O digest não inclui access token, refresh token, client secret, Authorization, cookies, headers, request IDs ou observed_at.

Fixtures semanticamente idênticas com ordem de propriedades diferente geram o mesmo digest. Mudança de conteúdo gera digest diferente.

11. TRATAMENTO DE ERROS

ITEM_ID inválido: INVALID_ITEM_ID, sem request.

Access token ausente: AUTH_REQUIRED, sem request.

HTTP 401: AUTH_ERROR.

HTTP 403: FORBIDDEN, fail-closed.

HTTP 404: NOT_FOUND.

HTTP 429: RATE_LIMITED, fail-closed, sem retry automático.

Demais HTTP não-2xx: HTTP_ERROR.

Timeout: TIMEOUT.

Falha de conexão, DNS ou TLS: NETWORK_ERROR.

Corpo não JSON: INVALID_JSON.

Envelope verbose ausente, código inválido, body ausente ou schema inesperado: INVALID_SCHEMA.

ID retornado diferente do solicitado: IDENTITY_MISMATCH.

Qualquer exceção não catalogada permanece fail-closed como UNKNOWN_ERROR.

Nenhuma falha vira candidato, evidência persistida, assessment, score, autorização ou publicação.

12. FIXTURES

Foram criadas fixtures explicitamente marcadas como MOCK, FIXTURE e NOT PRODUCTION:

FIX-01 item completo.
FIX-02 campos opcionais ausentes.
FIX-03 available_quantity com semântica referencial.
FIX-04 HTTP 401.
FIX-05 HTTP 403.
FIX-06 HTTP 404.
FIX-07 HTTP 429.
FIX-08 HTTP 500.
FIX-09 JSON inválido.
FIX-10 schema inesperado.
FIX-11 campos extras.
FIX-12 e FIX-13 mesma semântica com ordens diferentes.
FIX-14 preço e moeda válidos.
FIX-15 preço ausente.

Nenhuma fixture foi apresentada como resposta real.

13. TESTES

Suíte específica:
20 testes passados, 0 falhas, 0 skipped.

A suíte cobre:

ITEM_ID válido e inválido;
request não realizado para ID inválido;
HTTP 200, 401, 403, 404, 429 e 500;
timeout e falha de conexão;
JSON inválido e schema inválido;
campos ausentes, extras e UNKNOWN;
price KNOWN e UNKNOWN;
seller_id e category_id;
available_quantity sem extrapolação semântica;
digest determinístico e sensível a mudança de conteúdo;
credenciais fora do digest e do output;
provenance, external_listing_id e observed_at UTC;
http_status preservado;
COLLECTION_FAILED;
CONTRADICTED não inventado;
isolamento sem chamadas N13–N17 ou efeitos colaterais.

Suíte completa:
1341/1341 testes passados, 0 falhas.

14. SEGURANÇA

Secret scan dos novos arquivos:

CONFIG_NAME_OR_CODE_HITS=17
EXPLICIT_PLACEHOLDER_OR_FIXTURE_HITS=55
POSSIBLE_REAL_SECRET_PATTERN_HITS=0

Os hits de nomes são referências de tipos, headers e campos de configuração. Os hits de placeholder são fixtures sintéticas ou marcadores NOT PRODUCTION. Nenhum padrão compatível com secret real foi encontrado nos arquivos novos.

Qualquer secret preexistente fora do escopo permanece separado e não foi removido nesta fase.

15. ISOLAMENTO

O adaptador é testado sem banco e sem bootstrap. O transporte HTTP é injetável. Não há import de N13, N14, N15, N16, N17, publicação, affiliate, Telegram, scheduler, agents ou job_queue.

Os testes não criam products, candidates, evidências, assessments, affiliate_links, jobs ou publication_executions.

16. INTEGRAÇÃO REAL

SKIPPED — DEPENDÊNCIA EXTERNA.

Não havia aplicação Mercado Livre, access token válido e permissão confirmada disponíveis para uma chamada real autorizada nesta Fase 2. Nenhuma credencial foi descoberta, solicitada, configurada ou utilizada.

Este resultado não prova que a API real respondeu 200 para o item de controle. Prova somente que o adaptador local está preparado para tratar a resposta oficial e seus erros de forma governada.

17. LIMITAÇÕES

A validação real permanece pendente de aplicação oficial, access token, scopes/permissões e autorização operacional. Ainda não foi validada a resposta autenticada para um item de terceiro no contexto real do Cerberus.

A API de item não foi usada para inferir nome/reputação do vendedor, rating, reviews, nome de categoria, comissão, demanda, competição ou disponibilidade semântica completa.

A integração ainda não está conectada ao N3. Essa conexão pertence a etapa posterior e não foi realizada nesta Fase 2.

18. BASELINE

Baseline conhecido antes da Fase 2:

products=13
candidates=0
candidate_evidence=0
candidate_assessment=0
affiliate_links=0
job_queue=0
publication_executions=0
commercial_cycles=0

Baseline depois da Fase 2:

products=13
candidates=0
candidate_evidence=0
candidate_assessment=0
affiliate_links=0
job_queue=0
publication_executions=0
commercial_cycles=0

A igualdade antes/depois decorre do isolamento: não houve conexão com Supabase nem operação de persistência.

19. CLEANUP

Nenhum artefato persistente foi criado. Não foi necessário executar DELETE. Não foram usados TRUNCATE nem DELETE amplo.

20. REGRESSÃO N1–N16

npm test: PASS — 1341/1341.
npx tsc --noEmit: PASS — 0 erros.
npm run build: PASS.
git diff --check: PASS.

N1–N16 permanecem sem alteração de código. N15 continua como única autoridade de autorização. N16 continua executor exclusivo de publicação autorizada. N17 não foi iniciado.

21. DECISÃO

INFRA-02 — FASE 2 CONCLUÍDA COM LIMITAÇÕES.

O adaptador oficial foi implementado e validado localmente. A integração real foi corretamente marcada como SKIPPED — DEPENDÊNCIA EXTERNA. Não houve fabricação de resposta API, token, provenance, evidência, PASS do N13, score do N14, APPROVED do N15 ou publicação.

Não fazer commit, push ou deploy nesta etapa. A decisão de consolidação depende de revisão explícita posterior.

22. PRÓXIMO PASSO

READY FOR REVIEW.

Aguardar autorização explícita para eventual commit/push/deploy da implementação local ou para a Fase 3 de validação controlada. Se a Fase 3 exigir chamada real, primeiro devem existir aplicação oficial, access token, scopes/permissões e autorização confirmada.

Não iniciar N17.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FIM DO RELATÓRIO — INFRA-02 FASE 2
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

23. REFERÊNCIAS OFICIAIS

[1] Mercado Livre Developers — Itens e Buscas: https://developers.mercadolivre.com.br/pt_br/itens-e-buscas

[2] Mercado Livre Developers — OAuth: https://developers.mercadolivre.com.br/pt_br/autenticacao-e-autorizacao

[3] Mercado Livre Developers — Permissões funcionais: https://developers.mercadolivre.com.br/pt_br/permissoes-funcionais

[4] Mercado Livre Developers — Erro 403: https://developers.mercadolivre.com.br/pt_br/erro-403

[5] Mercado Livre API — recurso oficial de itens: https://api.mercadolibre.com/items

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FIM DO RELATÓRIO — INFRA-02 FASE 2
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
