# INFRA-01 — Diagnóstico e Resolução da Pendência de Egress / Marketplace

## STATUS FINAL

**INFRA-01 BLOCKED — DEPENDÊNCIA EXTERNA**

A causa operacional do `http_error` foi identificada com evidência suficiente para classificar a falha como **HTTP 403 simétrico do Mercado Livre ao caminho de coleta automatizada**. Não foi aplicada correção de User-Agent/headers, porque essa estratégia poderia contornar mecanismos anti-bot e não possui autorização/termos confirmados neste escopo. Não houve bypass, fabricação de evidência, alteração de governança, publicação ou início do N17.

O N16 permanece consolidado no SHA `44a31d687ae06d2398e6651ad1009e3acfbeefbd`. O happy path N13→N14→N15→N16 permanece **SKIPPED — DEPENDÊNCIA EXTERNA**.

## IDENTIFICAÇÃO E ESCOPO

`INFRA_PROOF_RUN_ID=INFRA_EGRESS_20260819T210055Z`

O objetivo foi diagnosticar por que a coleta real de marketplace produzia `collection_failed: http_error` em produção e, somente se houvesse uma correção mínima, compatível e autorizada, aplicá-la. O escopo não incluiu N15, N16, catálogo canônico, afiliados, jobs, Telegram, scheduler, agentes, N17, N18, N19 ou N20.

## SNAPSHOT ANTES DO DIAGNÓSTICO

O repositório estava na branch `main`, com `HEAD` e `origin/main` em `44a31d687ae06d2398e6651ad1009e3acfbeefbd`. O Render servia o mesmo SHA.

O endpoint `/health` estava saudável, com `status=ok`, `backendReady=true` e `apiHealthy=true`. O endpoint de status do Telegram confirmou `operatorState=READY`, `webhookConfigured=true`, `webhookMatchesExpectedUrl=true`, `pendingUpdates=0` e `backendSha` igual ao SHA acima. Nenhum valor de credencial foi capturado.

Baseline canônico antes da prova:

- `products=13`
- `candidates=0`
- `candidate_evidence=0`
- `candidate_assessment=0`
- `affiliate_links=0`
- `job_queue=0`
- `publication_executions=0`
- `commercial_cycles=0`

## CAMINHO DE COLETA AUDITADO

A entrada de URL passa pelo discovery do N10/N2. A coleta de listing usa `server/commercial/discovery/fetchShared.ts`, que executa fetch limitado, rate limiter, circuit breaker, redirects manuais e whitelist de host. A extração HTML é feita pelo pipeline compartilhado de `server/services/scraper.ts`.

O scraper usa timeout de 15 segundos, limite de 750 KB para HTML, redirects manuais limitados e classificação explícita de status HTTP. O User-Agent do scraper é `CerberusCatalogBot/1.0 (+catalog-validation)`. O fetch de discovery usa `CerberusCatalogBot/1.0 (+discovery-readonly)`, `Accept-Language` em pt-BR e `Accept` HTML. Status fora do intervalo aceito é devolvido como `http_error`; a camada de proveniência marca `fetch_failed` e mantém campos desconhecidos, sem convertê-los em observações confirmadas.

## COMPARAÇÃO LOCAL VERSUS RENDER

Foi usado o mesmo URL público de produto do Mercado Livre: `https://produto.mercadolivre.com.br/MLB-1456580521`.

No ambiente local, o caminho de fetch retornou:

- `ok=false`
- `reason=http_error`
- `http_status=403`
- latência aproximada de 6,7 segundos
- nenhum listing utilizável

Em produção, a rota de discovery respondeu HTTP 200 como transporte da rota, mas o resultado funcional foi:

- `outcome=created` apenas para registrar o candidato no funil;
- `error=collection_failed: http_error`;
- `title`, `price`, `images`, `seller`, `rating`, `review_count`, `availability` e `category` ausentes/UNKNOWN;
- `metadata.collection_failed=true`;
- `metadata.http_status=null` persistido, porque o contrato público de discovery não propagou o status bruto da falha;
- nenhum dado da página tratado como evidência conhecida.

O candidato diagnóstico foi `can-4aa7c8899debd95e4757f6a6`. Ele foi criado apenas para a comparação controlada e foi removido integralmente no cleanup seletivo.

## CLASSIFICAÇÃO DA CAUSA

**Categoria primária:** HTTP 403.

**Classificação operacional:** bloqueio anti-bot/anti-automação do marketplace ou política equivalente aplicada ao cliente automatizado identificado pelo User-Agent. A confiança é **alta** para o status HTTP 403 e para a simetria local/Render; é **média-alta** para a caracterização anti-bot, pois o corpo detalhado da resposta 403 não foi persistido pelo collector.

A evidência não sustenta a conclusão de que o Render tenha bloqueio específico de egress. O mesmo URL, com o mesmo cliente identificado, falhou localmente com 403, enquanto o Render reproduziu `collection_failed: http_error`. Portanto, alterar rede, IP de saída ou proxy não é a menor correção da causa observada.

A separação semântica foi preservada:

> HTTP 403 observado ≠ produto válido ≠ evidência conhecida ≠ aprovação N13 ≠ score N14 ≠ APPROVED N15 ≠ execução N16.

## API OFICIAL E ALTERNATIVAS

Foi consultado o portal oficial de desenvolvedores do Mercado Livre [1]. Também foi feita uma chamada somente leitura ao endpoint público oficial de item para o identificador de teste [2]. A resposta foi `resource not found` para esse item. Isso demonstra apenas que o item de teste não forneceu um recurso utilizável por essa chamada; não demonstra indisponibilidade geral da API e não autoriza inventar endpoint, campo, credencial ou integração.

A alternativa recomendada é um desenho separado de integração oficial/autorizada do Mercado Livre, condicionado a documentação vigente, item válido, escopos, credenciais e contrato de resposta confirmados. Essa alternativa exige revisão própria de arquitetura, proveniência, testes, configuração de secrets e aprovação antes de implementação.

Não foi escolhido mudar o User-Agent para imitar navegador nem adicionar headers destinados a evitar o bloqueio. O próprio prompt INFRA-01 proíbe scraping agressivo e contorno de mecanismos de segurança; sem autorização explícita e termos aplicáveis confirmados, a mudança seria tecnicamente arriscada e arquiteturalmente inadequada.

## ALTERAÇÕES REALIZADAS

Nenhum arquivo de código, configuração, schema, contrato ou infraestrutura foi alterado. Não houve commit, push ou deploy.

O único artefato de documentação produzido para este encerramento é este relatório. Os demais arquivos não rastreados já existentes no working tree pertencem a fases anteriores e não foram consolidados neste commit.

## CLEANUP E RESTORE

A limpeza foi seletiva, em ordem de dependência:

1. `publication_executions`: nenhuma linha retornada;
2. `candidate_assessment`: nenhuma linha retornada;
3. `candidate_evidence`: nenhuma linha retornada;
4. `candidates`: o candidato `can-4aa7c8899debd95e4757f6a6` foi retornado e removido.

Não foi usado `TRUNCATE`, `DELETE` amplo ou reset de catálogo.

Baseline depois do cleanup:

- `products=13`
- `candidates=0`
- `candidate_evidence=0`
- `candidate_assessment=0`
- `affiliate_links=0`
- `job_queue=0`
- `publication_executions=0`
- `commercial_cycles=0`

O catálogo canônico permaneceu intacto. Nenhum affiliate link, job, execução de publicação, assessment ou evidência permaneceu.

## GATES FINAIS

- `/health`: PASS; `status=ok`; SHA servido igual ao HEAD.
- `/api/telegram-status`: PASS; backend pronto, API saudável, operador READY, webhook esperado e zero pending updates.
- `npm test`: PASS; 1321 testes, 1321 pass, 0 falhas, 0 cancelados e 0 skipped.
- `npx tsc --noEmit`: PASS; 0 erros.
- `npm run build`: PASS; build concluído. O bundler emitiu apenas o aviso não bloqueante de chunk maior que 500 KB.
- `git diff --check`: PASS.
- `HEAD` versus `origin/main`: iguais em `44a31d687ae06d2398e6651ad1009e3acfbeefbd`.
- Commit/push/deploy INFRA-01: não realizados, pois não houve patch de código.

O secret scan específico dos valores sensíveis conhecidos foi **FAIL por dívida preexistente**, não por alteração do INFRA-01. Ele encontrou valores hardcoded em arquivos versionados anteriores: `scripts/prova_viva_fase_d.sh` e `tests/shopeeAffiliateIntegration.test.ts`. Os valores não são reproduzidos neste relatório, não foram adicionados pelo INFRA-01 e não foram impressos nos logs de produção. A remoção dessa dívida deve ser tratada separadamente, com escopo e testes próprios; não foi feita aqui para não alterar código não relacionado sem autorização específica.

## IMPACTO NA CADEIA N10–N16

A coleta continua sem evidência real utilizável para este caso. Logo, N13 deve permanecer BLOCKED; não há score comercial válido N14; N15 não produz APPROVED; N16 não recebe autorização e não chama provider. Nenhum falso happy path foi criado.

N15 permanece a única autoridade de autorização. N16 permanece apenas executor de publicação. N17 não foi iniciado.

## LIMITAÇÕES E DÍVIDAS

A rota de discovery preserva `collection_failed`, mas não propaga o status HTTP bruto no payload funcional do candidato; por isso a metadata persistida mostrou `http_status=null`, embora a comparação local tenha comprovado 403. Isso é uma lacuna de observabilidade, não uma autorização para preencher o campo retroativamente.

A integração oficial do Mercado Livre ainda não foi desenhada nem configurada. A disponibilidade de dados públicos via API, a validade do item de teste, o modelo de autenticação, os escopos e os limites operacionais permanecem dependências a confirmar em uma etapa própria.

Os dois arquivos versionados apontados pelo secret scan contêm credenciais hardcoded preexistentes e devem ser saneados em tarefa separada antes de qualquer novo ciclo de consolidação que exija secret scan verde.

## ROLLBACK

Não há rollback de código, configuração, schema ou produção: nenhum foi alterado. O único registro criado pela investigação foi o candidato diagnóstico, e sua remoção seletiva restaurou as contagens ao baseline. O estado de N15/N16 não foi reaberto.

## PRÓXIMO PASSO RECOMENDADO

Manter INFRA-01 encerrado como **BLOCKED — DEPENDÊNCIA EXTERNA**, sem iniciar N17. O próximo trabalho autorizado deve ser um bloco separado para avaliar uma integração oficial/autorizada do Mercado Livre ou um serviço de coleta autorizado, sempre preservando a sequência coleta real → evidência real → N13 → N14 → N15 → N16. Separadamente, deve ser autorizada a remoção dos secrets hardcoded preexistentes.

## REFERÊNCIAS

[1]: https://developers.mercadolibre.com/ — Mercado Libre Developers, portal oficial.
[2]: https://api.mercadolibre.com/items/MLB-1456580521 — endpoint público oficial de item consultado durante o diagnóstico.
