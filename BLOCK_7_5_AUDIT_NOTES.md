# Bloco 7.5 — Notas de Auditoria Prévia

## Infraestrutura Render observada em 14/08/2026

O painel autenticado do Render foi aberto em modo somente leitura. A visão geral exibia dois serviços ativos e implantados: `cerberus-forge-deploy-backend` com runtime Node na região Virginia e `cerberus-static-catalog` com runtime Static global. O painel indicava que ambos estavam em estado **Deployed** no instante observado.

Esta evidência confirma a existência dos serviços, mas não substitui uma verificação de configuração de ambiente, plano, deploy ou logs. Nenhuma configuração, variável, deploy, restart ou notificação foi alterada nesta etapa.

## Web Service observado em modo somente leitura

O serviço `cerberus-forge-deploy-backend` está configurado como **Web Service Node** no plano **Starter**, vinculado ao repositório `kauabrennan5-bit/cerberus-forge-deploy` na branch `main`. O painel mostrava o commit `4b5202d` como último deploy bem-sucedido e ativo, com gatilho **Auto-Deploy** e duração de 46,3 segundos.

O histórico visível confirmou que os commits `138e135`, `348c288` e `4b5202d` foram implantados automaticamente. Essa comprovação é importante para o Bloco 7.5 porque confirma que GitHub → Render está funcional sem necessidade de deploy manual.

## Limite de auditoria de ambiente

Foi iniciada uma navegação somente leitura para a tela de variáveis de ambiente do Render, mas a sessão do navegador retornou a `about:blank` antes de apresentar qualquer nome ou valor. Portanto, esta auditoria não afirma a presença ou a ausência de variáveis de ambiente do Render. Nenhum segredo foi visualizado, copiado ou alterado.

## Alternativas externas verificadas

A documentação pública do [UptimeRobot](https://uptimerobot.com/) declara monitoramento HTTP(S), plano gratuito com intervalo de cinco minutos e até 50 monitores gratuitos. Sua integração oficial [Telegram](https://uptimerobot.com/integrations/telegram-integration/) oferece alertas de mudança de status, mas a própria página informa que a integração Telegram está disponível nos planos Solo, Team e Enterprise.

A documentação oficial de [Render Cron Jobs](https://render.com/docs/cronjobs) confirma que cron jobs são um tipo de serviço separado, com variáveis próprias e garantia de apenas uma execução ativa por job. Contudo, também informa cobrança mínima mensal de US$ 1 por serviço cron e execução dentro do mesmo provedor do Web Service.

## Validação somente leitura do health em produção

Em 14/08/2026, `https://cerberus-forge-deploy-backend.onrender.com/health` não exibiu o JSON de liveness esperado pelo Bloco 7.5. A resposta carregou a SPA do catálogo (título Cerberus Finds Archive, tela ACERVO), indicando que o commit atualmente servido ainda não contém a nova rota `/health` ou que o hostname está apontando para um artefato diferente do Web Service esperado. Nenhuma configuração foi alterada. A validação do novo endpoint só poderá ser repetida depois do deploy do commit do Bloco 7.5.

Esta divergência é tratada como **não validada em produção**, não como falha do código local.

## Deploy automático do Bloco 7.5

O painel autenticado do Render detectou o commit `c68b8be` na branch `main` e criou o deploy `dep-d9vl2fnavr4c739abgeg` com gatilho **Auto-Deploy**. No momento da consulta, o painel mostrava o deploy como **In progress**, com o commit anterior `4b5202d` ainda marcado como Live. Nenhuma ação manual foi executada.

A validação do `/health` e do workflow externo deve ocorrer somente após o novo deploy deixar de estar em progresso.

## Pós-deploy /health

O Render passou o deploy `c68b8be` para **Live**. A navegação do navegador para `/health` após a propagação não produziu screenshot/texto e a operação seguinte caiu em `about:blank`; portanto, não há evidência visual válida do JSON por navegador. A verificação HTTP independente ainda precisa ser feita sem alterar o serviço.

## Health confirmado em produção

Em 14/08/2026 às 17:34:56 UTC, uma consulta HTTP somente leitura a `https://cerberus-forge-deploy-backend.onrender.com/health` retornou:

- HTTP 200;
- `Content-Type: application/json; charset=utf-8`;
- `status: ok`;
- `service: cerberus-forge-deploy`;
- `version: c68b8bea9c5c25cebe60d8fe9520d0edc3105293`;
- timestamp público `2026-08-14T17:34:56.312Z`.

O endpoint público de liveness está confirmado no artefato servido pelo Render.
