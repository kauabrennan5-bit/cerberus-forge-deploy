# INFRA-02 — Mercado Livre — Fase 1: Discovery / Contrato Oficial

## Status

**FASE 1 CONCLUÍDA — READY FOR REVIEW**

Decisão técnica: **fonte oficial identificada, porém viabilidade operacional para o caso de uso do Cerberus permanece condicional à existência de aplicação Mercado Livre autorizada, access token válido e confirmação do escopo permitido para consulta do item de terceiro**.

Não houve alteração de código, configuração, banco, produção, credenciais, N13, N14, N15 ou N16. Não houve commit, push, deploy, publicação, criação de produto, affiliate link, job ou acionamento de Telegram/scheduler/agents.

## Objetivo

Investigar se existe uma fonte oficial/autorizada do Mercado Livre capaz de alimentar Discovery/Research sem depender do scraping HTML bloqueado observado no INFRA-01, preservando a cadeia:

```text
Mercado Livre
  -> API oficial/autorizada
  -> dados observados
  -> evidência com proveniência
  -> N13
  -> N14
  -> N15
  -> N16
```

O objetivo não é contornar o HTTP 403 nem fazer o scraping funcionar por imitação de navegador.

## Escopo e limites

O INFRA-02 atua antes do N13. N13 continua decidindo se a evidência é suficiente; N14 continua responsável pelo ranking comercial; N15 continua sendo a única autoridade de autorização; N16 continua sendo apenas o executor de uma autorização N15 APPROVED.

Ficam fora do escopo desta fase:

- alteração de N13, N14, N15 ou N16;
- alteração do publication ledger ou provider;
- Telegram, scheduler, agents e job_queue;
- criação ou alteração de products;
- aquisição de credenciais reais;
- chamada autenticada de produção;
- implementação do adaptador;
- commit, push ou deploy.

## Identificação da investigação

```text
PROOF_RUN_ID: INFRA02_20260819T214206Z
SHA no início: 44a31d687ae06d2398e6651ad1009e3acfbeefbd
SHA origin/main: 44a31d687ae06d2398e6651ad1009e3acfbeefbd
Infraestrutura anterior: INFRA-01 BLOCKED — HTTP 403 / DEPENDÊNCIA EXTERNA
```

O baseline informado para o início do INFRA-02 permanece:

```text
products=13
candidates=0
candidate_evidence=0
candidate_assessment=0
affiliate_links=0
job_queue=0
publication_executions=0
commercial_cycles=0
```

Nenhum dado artificial foi criado nesta fase; portanto não houve cleanup de banco.

## Fontes oficiais consultadas

### Busca de itens

URL: https://developers.mercadolivre.com.br/pt_br/itens-e-buscas

A documentação oficial apresenta os seguintes recursos:

```text
GET https://api.mercadolibre.com/items?ids=$ITEM_ID1,$ITEM_ID2
GET https://api.mercadolibre.com/items?ids=$ITEM_ID1,$ITEM_ID2&attributes=$ATTRIBUTE1,$ATTRIBUTE2,$ATTRIBUTE3
GET https://api.mercadolibre.com/sites/$SITE_ID/search?seller_id=$SELLER_ID
GET https://api.mercadolibre.com/users/$USER_ID/items/search
```

A documentação informa que o multiget de itens aceita até 20 resultados por chamada, retorna um envelope verbose com código por item e permite selecionar atributos. O exemplo oficial de item mostra `id`, `site_id`, `title`, `seller_id`, `category_id`, `price`, `currency_id`, `initial_quantity`, `available_quantity`, `date_created` e `last_updated`.

A mesma documentação informa que, nos recursos públicos de Itens e Buscas, `available_quantity` é referencial/rangeado. Portanto, esse campo não deve ser tratado automaticamente como estoque exato.

### Permissões funcionais

URL: https://developers.mercadolivre.com.br/pt_br/permissoes-funcionais

A fonte oficial define escopo somente leitura como permissão para métodos GET HTTPS e leitura/escrita como permissão para PUT, POST e DELETE. O vínculo final entre o endpoint de detalhe e o scope da aplicação precisa ser confirmado no DevCenter da conta autorizada; não será inferido a partir de um endpoint isolado.

### Criação e gestão de aplicação

URL: https://developers.mercadolivre.com.br/pt_br/crie-uma-aplicacao-no-mercado-livre

A documentação exige uma aplicação Mercado Livre para acessar o ecossistema de APIs públicas. A aplicação possui client ID e client secret; o client secret deve permanecer secreto. A documentação descreve escopos de leitura e escrita, recomenda PKCE e também descreve Device Grant para recursos próprios do aplicativo.

A página diferencia aplicações somente leitura, on-line leitura/escrita e off-line leitura/escrita. Para o Cerberus, a menor autorização compatível seria leitura, caso o endpoint e a conta autorizada confirmem o acesso necessário.

### Autenticação e autorização

URL: https://developers.mercadolivre.com.br/pt_br/autenticacao-e-autorizacao

O fluxo documentado é OAuth 2.0. A autorização usa a página oficial de autorização e a troca de código usa:

```text
POST https://api.mercadolibre.com/oauth/token
Content-Type: application/x-www-form-urlencoded
```

A resposta documentada inclui `access_token`, `token_type`, `expires_in`, `scope`, `user_id` e `refresh_token`. O access token documentado expira após 6 horas; o refresh token é de uso único e a renovação retorna outro refresh token. Nenhum token, client secret ou senha foi solicitado, armazenado ou impresso nesta fase.

### Desenvolvimento seguro

URL: https://developers.mercadolivre.com.br/pt_br/desenvolvimento-seguro

A fonte oficial orienta enviar os parâmetros de `/oauth/token` no body, não na query string. Também afirma que o access token deve ser enviado em todas as chamadas à API, inclusive para recursos públicos, e que deve corresponder ao usuário cuja informação é consultada.

### Boas práticas para uso da plataforma

URL: https://developers.mercadolivre.com.br/pt_br/boas-praticas-para-usar-a-plataforma

A fonte oficial determina que não se deve fazer web crawling e que a integração deve trabalhar com a API do Mercado Livre. Também orienta controlar limites de requisições e tratar HTTP 429 diminuindo ou distribuindo melhor as chamadas.

### Erro 403

URL: https://developers.mercadolivre.com.br/pt_br/erro-403

A documentação oficial relaciona HTTP 403 a possíveis problemas de scopes, aplicação bloqueada/desabilitada, usuário inativo/suspenso, IP não permitido, token que não é do owner da informação ou outros requisitos de autorização. Um 403 da API oficial deve ser fail-closed; não pode acionar fallback para scraping, troca de User-Agent, rotação de IP ou qualquer evasão.

## Fonte oficial escolhida

A fonte candidata é a **API REST oficial do Mercado Livre**, com prioridade para o multiget de itens:

```text
GET https://api.mercadolibre.com/items?ids={ITEM_ID}
```

A seleção de atributos pode ser usada somente se a documentação da aplicação autorizada confirmar que a chamada e os campos estão disponíveis para o caso de uso:

```text
GET https://api.mercadolibre.com/items?ids={ITEM_ID}&attributes={lista_explicitamente_permitida}
```

Não será usado endpoint antigo, endpoint encontrado apenas em código legado ou endpoint inventado. Não será usado HTML como fallback da fonte oficial.

## Viabilidade

A viabilidade é classificada como **VIÁVEL CONDICIONAL / NÃO OPERACIONALMENTE CONFIRMADA**.

A fonte é legítima e documenta um contrato oficial de API, autenticação OAuth e recursos de itens. Porém, ainda não existe nesta investigação uma prova autenticada que confirme simultaneamente:

1. uma aplicação Mercado Livre pertencente ou autorizada para o uso do Cerberus;
2. um access token válido e mantido com segurança;
3. o scope mínimo necessário;
4. a permissão de consultar exatamente o item de terceiro representado pela URL recebida;
5. a disponibilidade de todos os campos necessários ao N13;
6. a política operacional de rate limit aplicável à aplicação/conta;
7. a resolução de seller e category para os valores de negócio que o Cerberus deseja observar.

Consequentemente, a Fase 1 não declara a integração pronta nem autoriza uma prova real de produção.

## Dados disponíveis conforme a documentação

### Confirmados como campos mostrados no contrato de item/multiget

```text
item_id / id: conhecido quando presente na resposta e igual ao ID solicitado
site_id: conhecido quando presente
 title: pode ser retornado pelo item
seller_id: identificador do vendedor pode ser retornado pelo item
category_id: identificador da categoria pode ser retornado pelo item
price: pode ser retornado pelo item
currency_id: pode ser retornado pelo item
initial_quantity: pode ser retornado pelo item
available_quantity: pode ser retornado, mas é referencial/rangeado em recursos públicos
last_updated: pode ser retornado pelo item
```

A palavra “pode” é intencional: a presença real deve ser validada por resposta oficial autenticada ou por teste de contrato controlado; ausência continua UNKNOWN.

### Dados potencialmente obtíveis, mas ainda dependentes de confirmação

```text
images: o exemplo resumido não confirma o contrato completo de pictures para o adaptador; permanecer UNKNOWN até resposta oficial validada
seller_name/reputation: seller_id pode ser obtido, mas o nome/reputação exigem endpoint/escopo e mapeamento confirmado
category_name: category_id pode ser obtido, mas o nome legível exige endpoint/contrato de categoria confirmado
availability semântica: status/quantidade exata não deve ser inferida de available_quantity referencial
```

## Dados indisponíveis ou não confirmados para o Cerberus

Os seguintes pontos permanecem **UNKNOWN / NÃO DISPONÍVEL OFICIALMENTE PARA ESTE CASO DE USO**, até confirmação pela conta/aplicação autorizada:

- consulta anônima e irrestrita de qualquer item público de terceiro;
- garantia de que o item da URL `MLB-...` possa ser consultado por um token que não seja do owner;
- estoque exato, quando a API fornece `available_quantity` referencial/rangeado;
- seller como nome comercial, em vez de somente `seller_id`;
- categoria como rótulo, em vez de somente `category_id`;
- imagens no subconjunto mínimo efetivamente permitido;
- rating e review_count como campos do contrato de item que sejam suficientes para N13;
- comissão, margem, competitividade ou qualquer score comercial, que pertencem a etapas posteriores e não podem ser derivados da API de itens;
- garantia de ausência de 401/403 para cada conta, IP, scope e item consultado;
- rate limit numérico específico para esta aplicação.

Nenhum desses valores será inventado, derivado de slug ou preenchido a partir da página bloqueada.

## Contrato de provenance proposto

A implementação futura, se autorizada, deve usar um adaptador isolado e produzir evidência compatível com o repositório existente:

```text
source_type: api
collection_method: API
source_url: URL original recebida para o anúncio
official_endpoint: URL da API oficial usada, sem token ou secret
external_listing_id: ITEM_ID extraído deterministicamente e confirmado pela resposta
observed_at: timestamp UTC da resposta oficial
http_status: status HTTP observado
request_correlation: identificador não secreto da chamada
response_digest: SHA-256 do payload canônico observado sem credenciais
field_state: KNOWN | UNKNOWN | COLLECTION_FAILED | CONTRADICTED
quality: conforme avaliação de evidência existente
```

Regras obrigatórias:

1. O `ITEM_ID` da URL deve ser extraído pelo mecanismo determinístico existente e comparado ao `body.id` da API.
2. Se o ID solicitado e o ID retornado divergirem, o resultado é `FAILED`/`IDENTITY_UNCERTAIN`; nenhum campo deve virar KNOWN.
3. Cada campo deve ser conhecido somente quando presente, validado e proveniente da resposta oficial.
4. Ausência de campo deve produzir `UNKNOWN`, nunca `null` convertido em fato e nunca valor derivado do slug.
5. HTTP 401, 403, 404, 429, timeout, payload inválido ou envelope parcial não podem virar evidência KNOWN.
6. HTTP 429 deve ser tratado com backoff controlado e limitado; não deve gerar retry infinito.
7. Client secret, access token e refresh token nunca entram em código, teste, log, metadata, response ou evidence payload.
8. O endpoint oficial pode aparecer como metadata redigida, mas nunca com query/header que contenha token.
9. O digest deve ser calculado sobre uma representação canônica do conteúdo observado e do contexto não secreto, de modo que replays idênticos sejam idempotentes.
10. O adaptador não cria product canônico, affiliate_link, job, assessment, autorização ou publicação.

## Adaptação arquitetural necessária na Fase 2

O N2 atual é orientado à página pública: `MercadoLivreConnector` chama o fetch HTML; `RawListing` e o normalizador atual carimbam `PUBLIC_PAGE`/proveniência de página; o caminho de falha registra `COLLECTION_FAILED`.

A Fase 2, se autorizada, deve adicionar um adaptador paralelo e isolado para API oficial, sem modificar o significado do caminho HTML nem aplicar patch anti-bot. O adaptador deve converter sua resposta para o contrato de observação/evidência com `source_type=api` e `collection_method=API`, mantendo a fronteira N1/N3. A alteração do enum/interface de coleta, caso necessária, deve ser mínima e coberta por testes; não deve tocar N13–N16.

A escolha de substituir o conector de URL pelo adaptador oficial só pode ocorrer depois que o token e o escopo forem confirmados. Até lá, o caminho deve permanecer fail-closed e a coleta HTML continua sujeita ao estado BLOCKED do INFRA-01.

## Impacto no N13

Com uma resposta oficial válida e identidade confirmada, o N13 poderia receber evidências de campos com `source_type=api`, `collection_method=API`, timestamp e digest verificáveis. O N13 continuaria decidindo se a cobertura e a qualidade são suficientes para PASS.

Uma resposta parcial, 401, 403, 404, 429, timeout, divergência de ID ou ausência de provenance deve manter o candidato em estado insuficiente/BLOCKED. O INFRA-02 não pode forçar N13 PASS.

## Impacto no N10, N11 e N12

N10 continua responsável pela identidade externa. Para Mercado Livre, o ID `MLB-...` é extraído deterministicamente da URL; não há alteração necessária nesta fase.

N11 e N12 permanecem fora do escopo de implementação. Nenhuma identidade canônica, resolução de catálogo, produto, afiliado ou publicação será criada pelo adaptador. Se uma futura etapa precisar dessas camadas, deverá receber apenas a evidência oficial já validada e manter `candidate != canonical product`.

## Riscos

- **Autorização:** token sem scope, token de usuário incorreto, application bloqueada, IP não permitido ou token expirado podem gerar 401/403.
- **Escopo de owner:** a documentação alerta que o token deve corresponder ao usuário cuja informação é consultada. Isso pode impedir a consulta de itens de vendedores arbitrários.
- **Granularidade:** `available_quantity` público é referencial/rangeado, portanto disponibilidade exata pode não existir legitimamente.
- **Envelope verbose:** multiget retorna código por item; cada elemento deve ser validado separadamente.
- **Rate limit:** a documentação confirma que existem limites e exige tratamento de 429, mas o número aplicável a esta aplicação não foi encontrado em fonte oficial consultada. O limite numérico permanece UNKNOWN.
- **Schema drift:** campos não explicitamente apresentados no contrato observado não devem ser mapeados por suposição.
- **Proveniência:** misturar API e página HTML no mesmo campo sem marcar a origem destruiria auditabilidade; isso é proibido.
- **Segurança:** qualquer implementação de OAuth com secret/token em logs ou metadata seria falha de segurança e deve bloquear a entrega.
- **Anti-bot:** o HTTP 403 da página HTML não pode ser tratado como convite para trocar headers, usar proxy ou simular navegador.

## Segurança e secret scan

Nenhuma credencial foi coletada ou inserida. Nenhum token ou client secret aparece neste documento. A dívida `SECURITY-DEBT-01 — HARD-CODED CREDENTIALS PREEXISTENTES` permanece fora do escopo, conforme o prompt do INFRA-02; não será removida oportunisticamente.

A fase seguinte deverá usar apenas variáveis de ambiente protegidas e redigir qualquer erro sem valores secretos.

## Testes e prova desta fase

```text
Alteração de código: NÃO
Testes de implementação: NÃO aplicáveis nesta fase
Prova autenticada real: NÃO executada
Prova de produção: NÃO executada
Deploy: NÃO executado
Commit/push: NÃO executados
Dados artificiais: NÃO criados
Cleanup: NÃO necessário
```

Foi realizada investigação documental em fontes oficiais e uma tentativa de extração textual não autenticada do endpoint de detalhe. A extração não produziu conteúdo representável; isso é inconclusivo e não foi tratado como prova de inexistência ou de sucesso da API.

## Impacto na cadeia N10–N16

```text
INFRA-02 Fase 1
  -> fonte oficial candidata identificada
  -> contrato operacional ainda condicionado a OAuth/escopo/conta
  -> N13 permanece sem nova evidência
  -> N14 não é acionado
  -> N15 não é acionado
  -> N16 não é acionado
  -> N17 permanece não iniciado
```

O estado correto continua sendo fail-closed. Nenhum PASS foi fabricado.

## Decisão final da Fase 1

**DECISÃO: READY FOR REVIEW — FASE 2 BLOQUEADA ATÉ CONFIRMAÇÃO DE AUTORIZAÇÃO OPERACIONAL.**

A API REST oficial do Mercado Livre é a única direção compatível identificada. A Fase 2 poderá implementar um adaptador isolado somente após uma destas confirmações legítimas:

1. o usuário autorizar explicitamente a implementação local usando mocks/fixtures, sem chamada real, mantendo a prova real para fase posterior; ou
2. existir aplicação Mercado Livre e acesso oficial autorizado, configurado por secret/env sem exposição, permitindo validar o endpoint, scope, owner e campos em prova controlada.

Mesmo após autorização, uma resposta 401/403, payload inválido, campo ausente ou limite desconhecido deve permanecer fail-closed e poderá resultar em `INFRA-02 BLOCKED — NO SUITABLE AUTHORIZED SOURCE`.

Não avançar automaticamente para N14, N15, N16 ou N17.

## Referências

[1]: https://developers.mercadolivre.com.br/pt_br/itens-e-buscas "Mercado Livre — Busca de itens"
[2]: https://developers.mercadolivre.com.br/pt_br/permissoes-funcionais "Mercado Livre — Permissões funcionais"
[3]: https://developers.mercadolivre.com.br/pt_br/crie-uma-aplicacao-no-mercado-livre "Mercado Livre — Crie uma aplicação no Mercado Livre"
[4]: https://developers.mercadolivre.com.br/pt_br/autenticacao-e-autorizacao "Mercado Livre — Autenticação e Autorização"
[5]: https://developers.mercadolivre.com.br/pt_br/desenvolvimento-seguro "Mercado Livre — Desenvolvimento seguro"
[6]: https://developers.mercadolivre.com.br/pt_br/boas-praticas-para-usar-a-plataforma "Mercado Livre — Boas práticas para uso da plataforma"
[7]: https://developers.mercadolivre.com.br/pt_br/erro-403 "Mercado Livre — Erro 403"
