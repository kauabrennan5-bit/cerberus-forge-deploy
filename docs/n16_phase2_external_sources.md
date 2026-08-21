# Fontes externas usadas na Fase 2 N16

## Render API — atualização e leitura de variáveis

Fonte: https://api-docs.render.com/reference/update-env-var

A API oficial documenta `PUT https://api.render.com/v1/services/{serviceId}/env-vars/{envVarKey}` com corpo JSON contendo `key` e `value`. A resposta e os valores de ambiente não devem ser expostos no relatório.

Fonte: https://api-docs.render.com/reference/get-env-vars-for-service

A API oficial documenta `GET https://api.render.com/v1/services/{serviceId}/env-vars?limit=20` e informa que o endpoint retorna apenas variáveis diretamente pertencentes ao serviço, não variáveis herdadas de grupos de ambiente.

## Aplicação controlada

Foi usada a API acima para configurar temporariamente, no serviço `srv-d9tq9sh42hec738skftg`, somente as chaves de prova `N16_PHASE2_PROOF_RUN_ID` e `N16_PHASE2_FAKE_PROVIDER_MODE`. Nenhum valor secreto foi gravado neste arquivo.
