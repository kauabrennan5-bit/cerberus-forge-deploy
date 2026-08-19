# Bloco N16 — Fase 1 — Relatório Final

## Resultado

A Fase 1 do N16 foi concluída localmente. O executor foi implementado como uma camada separada da publicação legada N5 e consome exclusivamente autorizações N15 persistidas como `n15:governance_v1`, com `status = APPROVED` e `action = PUBLISH`. N16 não cria autorização, não altera o catálogo canônico e não chama N8, N17, N18, N19 ou N20.

A implementação permanece **READY FOR REVIEW**. Não houve commit, push, deploy, aplicação de migration em produção, chamada a provider real, publicação real, criação de produto, aquisição de afiliado, distribuição, anúncio, scheduler, agente ou `job_queue`.

## Audit arquitetural

O audit confirmou que `server/commercial/publication/publicationExecutor.ts` e `server/routes/publicationRoutes.ts` pertencem ao fluxo legado N5. Esse fluxo cria produtos canônicos e usa seu próprio Policy Engine/ApprovalStore, sem ler autorizações N15. Por isso, N16 não reutiliza o executor legado como autoridade; o caminho N16 foi criado separadamente e a rota legada não foi alterada.

O audit também confirmou que `candidate_assessment` é a fonte persistida compartilhada por N13, N14 e N15. O N16 normaliza os assessments dessa fonte, valida os digests cruzados e trata qualquer ausência ou erro de leitura de forma fail-closed.

## Artefatos implementados

| Arquivo | Responsabilidade |
| --- | --- |
| `server/commercial/publication/n16Contract.ts` | Contrato `n16:publication_v1`, estados, razões, payload, digest e execution key. |
| `server/commercial/publication/n16Engine.ts` | Engine puro de autorização e validação, sem Supabase, fetch, Telegram ou scheduler. |
| `server/commercial/publication/n16Provider.ts` | Interface `PublicationProvider` e `FakePublicationProvider` para sucesso, falha e ambiguidade. |
| `server/commercial/publication/n16Service.ts` | Carregamento N13/N14/N15, validação, persistência, execução, confirmação e idempotência. |
| `server/repositories/publicationExecutionsRepository.ts` | Ledger N16, lookup, insert idempotente e transições de estado. |
| `server/routes/publicationN16Routes.ts` | Rota admin `POST /api/commercial/publication/execute`. |
| `supabase/migrations/20260820_publication_executions.sql` | Migration local da tabela `publication_executions`; não aplicada em produção. |
| `tests/publicationN16.test.ts` | 41 cenários A–AO. |
| `tests/_proofN16.ts` | Prova local com 12 cenários executáveis. |
| `docs/n16.md` | Arquitetura e contratos operacionais completos. |

O bootstrap `server.ts` recebeu somente o wiring da rota e do cliente do ledger. O provider real não foi configurado; sem provider disponível, o endpoint permanece fail-closed.

## Contrato, autorização e idempotência

A única ação aceita pelo N16 é `PUBLISH`. O engine exige candidato existente, N13 `PASS`, N14 com score finito, N15 `APPROVED`, ação compatível, `candidate_id` consistente, digests N13/N14 coincidentes, autorização não expirada, payload válido e destino válido.

A chave determinística é calculada exatamente como SHA-256 da concatenação:

```text
candidate_id + n15_authorization_digest + publication_payload_digest + destination + action
```

A migration define `UNIQUE (execution_key)`, RLS habilitado e zero policies públicas. Replay de `PUBLISHED` não chama o provider novamente. Replay de `AMBIGUOUS` não faz retry automático e não converte o estado em `PUBLISHED`.

## Prova local

A prova `npx tsx tests/_proofN16.ts` passou em **12/12 cenários**. Ela demonstrou explicitamente:

1. N15 `BLOCKED` → N16 `BLOCKED` → FakeProvider não chamado;
2. N15 `APPROVED` → provider fake → `PUBLISHED` confirmado;
3. replay publicado sem duplicação;
4. autorização expirada bloqueada;
5. ação diferente bloqueada;
6. digest divergente bloqueado;
7. payload inválido bloqueado;
8. destino inválido bloqueado;
9. falha do provider em `FAILED`;
10. resultado ambíguo em `AMBIGUOUS`;
11. estado ambíguo sem retry automático;
12. provider alcançado somente depois dos gates de autorização.

Nenhum cenário da prova acessou Supabase de produção, marketplace ou provider externo.

## Gates

| Gate | Resultado |
| --- | --- |
| Suíte completa `npm test` | **1320/1320 aprovados**, 0 falhas, 90 suites. |
| Suíte N16 `publicationN16.test.ts` | **41/41 aprovados**, 0 falhas. |
| Prova local `_proofN16.ts` | **12/12 aprovados**. |
| `npx tsc --noEmit` | **0 erros**. |
| `npm run build` | **OK**; frontend e bundle backend gerados. |
| `git diff --check` | **OK**. |
| Scan de credenciais nos artefatos N16 | **Nenhum segredo encontrado**. |
| Scan de isolamento | **Nenhuma referência a N17–N20, Telegram, scheduler, job_queue, agents ou productsRepository nos componentes N16**. |

O build local consultou a projeção pública de produtos para gerar o catálogo estático e recebeu 13 produtos; essa operação foi leitura de projeção e não criou ou alterou produto canônico.

## Produção e baseline

Não foram executadas chamadas de produção, migration, commit, push ou deploy nesta fase. O baseline herdado da consolidação N15 permanece sem alteração operacional: `products = 13`, `candidates = 0`, `assessments = 0`, `evidence = 0`, `affiliate_links = 0` e `job_queue = 0`, conforme o baseline registrado anteriormente. A Fase 1 não fez escrita para revalidar esses números, justamente para manter a restrição de ausência de operação produtiva.

O status local final contém a alteração N16 em `server.ts`, os novos arquivos N16 e os artefatos de documentação/teste. Há arquivos temporários não relacionados, já presentes no workspace (`n13_can*.json`, `tmp-*.json`), que foram preservados e não foram incluídos nem alterados pelo N16.

## Pendências e limites

A migration precisa de autorização explícita antes de qualquer aplicação em produção. O provider real ainda não foi conectado, e nenhuma publicação real foi autorizada ou executada. A confirmação de estado ambíguo continua exigindo fluxo explícito futuro. O executor não faz aquisição de afiliado, distribuição, publicidade ou medição; esses blocos permanecem fora do escopo N16.

A Fase 2 deverá ser autorizada separadamente e deverá definir, antes de qualquer operação, a revisão do contrato, a aplicação controlada da migration, o provider de publicação permitido, a prova viva e os gates de produção.

**FASE 1 N16 CONCLUÍDA — AGUARDANDO AUTORIZAÇÃO PARA FASE 2**
