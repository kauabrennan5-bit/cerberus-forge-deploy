# Evidência de Produção — Consulta Somente Leitura

**Data da consulta:** 14/08/2026 (GMT-3)  
**Fonte consultada:** `https://cerberus-forge-deploy-backend.onrender.com/api/products`

| Verificação | Resultado observado |
|---|---|
| Disponibilidade da API canônica | Resposta HTTP bem-sucedida com `success: true` |
| Forma da resposta | Campos `products` e `data` presentes |
| Quantidade retornada | 10 produtos |
| Referências observadas | O conjunto inclui `REF-009` e `REF-010` como `published` e ativos |
| Mutação de produção | Nenhuma; a consulta foi exclusivamente leitura |

## Projeção estática

**Fonte consultada:** `https://cerberus-static-catalog.onrender.com/data/products.json`

| Verificação | Resultado observado |
|---|---|
| Disponibilidade do JSON público | Página de dados aberta com conteúdo JSON válido no navegador |
| Quantidade de IDs no artefato | 10 |
| Referências observadas | `REF-009` uma vez; `REF-010` uma vez |
| Mutação de produção | Nenhuma; a consulta foi exclusivamente leitura |

## Vitrine pública

**Fonte consultada:** `https://cerberus-static-catalog.onrender.com/`

| Verificação | Resultado observado |
|---|---|
| Carregamento da SPA | Interface Cerberus carregada após a inicialização |
| Cards renderizados | Cabeçalho `ACERVO (10)` e cards de item 001 a 010 visíveis |
| Erro de conexão | Não observado na interface carregada |
| Mutação de produção | Nenhuma; não houve clique em marketplace, produto, analytics ou administração |

## Domínio personalizado

**Fonte consultada:** `https://cerberusfinds.com`

| Verificação | Resultado observado |
|---|---|
| Resolução DNS no ambiente de auditoria | Não retornou endereço público |
| HTTP HTTPS | `000` dentro de 15 segundos |
| Conclusão | A validação foi realizada no Static Site canônico do Render. O domínio personalizado não pode ser declarado operacional a partir deste ambiente e não foi alterado. |

## Revalidação após push do commit auditado

| Verificação | Resultado observado |
|---|---|
| URL aberta | `https://cerberus-static-catalog.onrender.com/?audit=138e135` |
| Carregamento final | `ACERVO (10)` e os itens 001 a 010 renderizados após a carga inicial |
| Interações destrutivas | Nenhuma |
| Escopo da evidência | Confirma a disponibilidade atual da vitrine; a identificação exata do deploy do Render permanece fora de alcance sem API autenticada do provedor. |

Esta evidência confirma somente o estado da API no instante da consulta. Ela não constitui prova de deploy, sincronização GitHub ou catálogo estático até que esses componentes sejam verificados separadamente.
