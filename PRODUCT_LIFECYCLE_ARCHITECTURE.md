# Cerberus Finds — Arquitetura do Ciclo de Vida de Produtos

## Objetivo e fonte de verdade

O Bloco 7 formaliza o processamento de produtos como um fluxo controlado. O **Supabase (`public.products`) permanece a fonte canônica**; o catálogo estático é apenas uma projeção publicada após sincronização bem-sucedida. Nenhuma etapa de descoberta, validação ou curadoria publica produtos automaticamente.

> A regra central é simples: um produto só alcança a vitrine pública depois de **validação**, **aprovação humana explícita no Telegram**, **persistência no Supabase** e **confirmação da sincronização da projeção pública**.

| Camada | Responsabilidade | Pode alterar produtos? |
|---|---|---|
| `productLifecycle.ts` | Estados, normalização, validação, duplicidade, curadoria e eventos de auditoria | Não |
| `productPipeline.ts` | Orquestra proposta, aprovação, persistência, sincronização, pausa e arquivo | Somente por adaptadores autorizados |
| `productsRepository.ts` | Persistência canônica e status operacional no Supabase | Sim, sem exclusão física |
| `catalogSync.ts` | Gera/commita a projeção e solicita rebuild do catálogo público | Não altera a fonte canônica |
| `telegramBot.ts` | Interface administrativa, whitelist e confirmação humana | Somente por fluxos registrados |
| `cerberusOperator.ts` | Observa telemetria recente do fluxo; não publica nem aprova produtos | Não |

## Estados e transições

O lifecycle usa uma máquina de estados determinística. Transições fora da tabela são rejeitadas com `INVALID_PRODUCT_TRANSITION` e não resultam em persistência.

| Estado | Significado | Próximos estados permitidos |
|---|---|---|
| `DISCOVERED` | Link ou entrada foi recebido | `COLLECTING`, `ERROR` |
| `COLLECTING` | Dados estão sendo obtidos de fonte permitida | `COLLECTED`, `ERROR` |
| `COLLECTED` | Dados disponíveis para normalização | `VALIDATING`, `ERROR` |
| `VALIDATING` | Regras comerciais e de duplicidade em execução | `ANALYZING`, `ERROR`, `REJECTED` |
| `ANALYZING` | Resultado válido em análise estruturada | `CURATING`, `ERROR` |
| `CURATING` | Categoria, confiança, riscos e recomendação calculados | `PENDING_APPROVAL`, `REJECTED`, `ERROR` |
| `PENDING_APPROVAL` | Aguardando uma decisão explícita do administrador | `APPROVED`, `REJECTED`, `ERROR` |
| `APPROVED` | Aprovado, porém ainda não publicado | `PUBLISHED`, `ERROR` |
| `PUBLISHED` | Produto canônico salvo e projeção confirmada | `PAUSED`, `ARCHIVED`, `ERROR` |
| `PAUSED` | Produto preservado, mas removido da projeção pública | `PUBLISHED`, `ARCHIVED` |
| `ARCHIVED` | Histórico preservado sem disponibilidade pública | Estado terminal |
| `REJECTED` | Proposta recusada antes da publicação | Estado terminal |
| `ERROR` | Falha estruturada com evento de auditoria | `COLLECTING`, `VALIDATING`, `REJECTED` |

## Normalização, validação e curadoria

A normalização aceita apenas campos do candidato recebido, padroniza strings e remove parâmetros de rastreamento conhecidos da URL. Ela não cria imagem, preço, título, categoria ou descrição fictícios. URLs fora de `http` e `https` são recusadas.

A validação classifica a proposta como `PASS`, `WARNING` ou `FAIL`. Ela exige título, URL normalizada, preço numérico positivo e ao menos uma imagem HTTP(S). A duplicidade bloqueia URL, identificador externo ou slug iguais; título muito parecido gera aviso e mantém a decisão para revisão humana.

A curadoria produz uma saída estruturada de categoria, score, confiança, razões, riscos e recomendação. A recomendação é explicável e nunca substitui a aprovação do administrador. Informações ausentes reduzem confiança e podem gerar `REVIEW` ou `REJECT`.

| Condição | Resultado do fluxo |
|---|---|
| Obrigatório ausente, URL inválida ou duplicidade exata | `ERROR` ou `REJECTED`; não publica |
| Dados suficientes com advertências | `PENDING_APPROVAL`; o administrador revisa os riscos |
| Dados completos e consistentes | `PENDING_APPROVAL`; aprovação ainda obrigatória |
| Curadoria insuficiente | `REJECTED`; preserva evento de auditoria |

## Aprovação e publicação

O bot cria uma proposta de revisão ao receber um link. O administrador autorizado pode abrir os detalhes e escolher **Confirmar e Publicar** ou **Rejeitar**. A confirmação chama o pipeline; uma chamada direta de publicação em estado diferente de `APPROVED` falha com `APPROVAL_REQUIRED`.

Após a aprovação, o pipeline grava no Supabase e executa `syncCatalogAndDeploy`. A transição para `PUBLISHED` só é feita se a sincronização retornar sucesso. Se a persistência, o commit ou a validação pública falharem, o registro permanece `APPROVED`, recebe `PUBLICATION_ERROR` ou `PERSISTENCE_ERROR`, e um evento `PRODUCT_PUBLICATION_FAILED` é registrado.

> Um retorno de criação bem-sucedido não é tratado como publicação concluída. A conclusão exige confirmação da projeção pública.

## Idempotência, pausa, reativação e arquivo

Publicar novamente um `LifecycleRecord` já em `PUBLISHED` não cria outro produto. O repositório também reaproveita o produto existente quando encontra URL ou slug canônico, evitando duplicação no Supabase. A sincronização é executada sob uma trava local para impedir corridas concorrentes na geração do catálogo.

A pausa altera o status operacional e remove o item da projeção exportada, sem apagar o registro canônico. A reativação volta o status para publicado e chama a sincronização controlada. O arquivamento preserva o histórico; o projeto não executa exclusão física de produto.

| Operação | Efeito no Supabase | Efeito na vitrine |
|---|---|---|
| Pausar | `status = paused`, `ativo = false` | Produto excluído da projeção pública após sync |
| Reativar | `status = published`, `ativo = true` | Produto volta após sync validado |
| Arquivar | `status = archived`, `ativo = false` | Produto permanece fora da projeção; histórico é preservado |

## Resiliência, retries e recuperação

O pipeline retorna falhas estruturadas e não usa shell, SQL arbitrário ou comandos remotos de operador. A telemetria em memória registra até 100 propostas recentes para observação do Operator e expõe contagens de pendências, falhas e publicações. Ela é deliberadamente **não canônica** e é reiniciada com o processo; propostas pendentes persistidas pelo Telegram continuam sendo consultadas pelo repositório do bot.

O Operator apenas classifica o componente `Lifecycle` como degradado quando há erros recentes ou fila de aprovação acima de 25 itens. Ele não possui uma ação automática para aprovar, publicar, pausar, reativar ou arquivar produtos. Falhas externas são escaladas para a revisão humana e podem ser reexecutadas somente pelos caminhos administrativos registrados.

## Segurança e limites

O scraper limita tamanho de HTML, impõe timeout, usa `AbortController` e valida URL de marketplace antes de requisitá-la. O Telegram mantém a whitelist configurada para todas as ações administrativas. O pipeline não executa `child_process`, comandos de shell, SQL destrutivo ou modificações arbitrárias de código.

Os principais limites atuais são a dependência de disponibilidade do Supabase, GitHub, deploy hook e catálogo público para confirmação de publicação. A confirmação pública pode levar o tempo normal do rebuild/CDN do serviço estático. O sistema não prevê publicação automática, decisão de compra, alteração de links de afiliado ou mudanças de schema no Bloco 7.
