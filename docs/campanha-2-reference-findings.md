# Campanha 2 — referência e requisitos consolidados

## Referência visual observada

O PDF anexado contém uma newsletter editorial de moda com abertura de marca, hero visual, texto curto, CTA principal, composição de múltiplos produtos, blocos editoriais intermediários, CTA final de novidades e rodapé institucional. A estrutura visual usa bastante espaço negativo, imagens grandes, grids de produtos e botões com borda/alto contraste. Também há um bloco de aplicativo e QR code na referência, mas a especificação da Campanha 2 determina explicitamente que esses elementos não sejam reproduzidos.

## Requisitos consolidados

A Campanha 2 deve ser um novo formato `collection`, sem quebrar a Campanha 1 individual nem a campanha `welcome`. Deve selecionar automaticamente produtos novos/elegíveis do catálogo, com tamanho configurável (padrão 10) e limites razoáveis, validando ID, título, preço positivo, destino HTTP/HTTPS e imagem HTTPS pública acessível. Produtos inválidos devem ser ignorados de forma explícita para completar a quantidade com os próximos elegíveis, ou gerar erro claro se não houver quantidade mínima suficiente; não podem aparecer com placeholder ou dados inventados.

A composição deve ser uma newsletter dark Cerberus Finds, com canvas `#0B0908`, surface `#181512`, borda `#3A342E`, texto principal `#E8E1D3`, secundário `#B8B0A3`, vermelho de marca `#8A1F1F` e CTA `#C0392B`. O e-mail deve usar tabelas tradicionais, `role="presentation"`, `bgcolor` e `background-color` inline nos fundos críticos, sem JavaScript, gradients, blend modes ou hacks que possam criar linhas laterais. No desktop, deve haver composição editorial e grids de duas colunas; no mobile, uma coluna, imagens fluidas, texto legível, CTAs acessíveis e nenhum overflow horizontal.

Cada produto precisa carregar título, categoria opcional, preço, imagem primária canônica, destino canônico, CTA `VER OFERTA` e UTM individual. A resolução deve passar por `resolveCanonicalProductImage()`/`productCanonical`, sem mapa manual por ID, sem Unsplash e sem voltar a `NEWSLETTER_CLEAN_HERO_PATHS`. O rodapé deve manter disclosure de afiliado, Política de Privacidade, Termos e Condições, descadastro individual e redes sociais apenas quando houver URLs reais. Não incluir App Store, Google Play, QR code, Brevo, Render, Supabase, UUIDs ou endpoints técnicos.

A implementação não deve criar campanha, recipient ou envio nesta etapa. São obrigatórios testes de seleção, readiness, não duplicação, renderer variável, CTAs, UTMs, responsividade estrutural, ausência de scripts/gradients/blend modes, backgrounds explícitos, footer legal e preservação da Campanha 1. Também devem ser executados lint, testes, build, `git diff --check` e secret scan. A validação visual deve cobrir 390px, 768px e 1440px, sem afirmar aprovação real no Gmail iPhone sem teste real nesse cliente.

Fonte: `/home/ubuntu/upload/Têniscommaisresistênciaqueasuasocialbattery.(1).pdf` e `/home/ubuntu/upload/Pasted_content_100.txt`.

Limite operacional: nenhum provider/Brevo, teste controlado, envio geral, worker, subscriber ou recipient deve ser acionado nesta tarefa.

## Decisão de arquitetura autorizada

A Campanha 2 usa o novo tipo `collection` em `email_campaigns` e uma tabela relacional `email_campaign_products` com `campaign_id`, `product_id`, `position` e `layout`. A tabela evita hardcode, conserva a ordem editorial, permite reabrir/re-renderizar a campanha e mantém integridade referencial com produtos e campanhas. A migration foi criada localmente, mas não foi aplicada ao Supabase nesta etapa.

A entrada administrativa será `/campanha2` (com alias `/colecao`) e um botão no painel do Telegram. O comando cria apenas um rascunho e o envia para aprovação; os gates existentes de aprovação, teste controlado e confirmação do envio geral permanecem intactos. Não existe criação automática de campanha por scheduler.

A seleção semanal usa `products.created_at` por meio de `Product.createdAt`, considerando por padrão o início da semana ISO corrente em UTC, produtos ativos com status `approved`/`published`, tamanho configurável e mínimo padrão de cinco. O seletor percorre produtos mais novos, remove duplicados e ignora produtos que falhem no readiness canônico até completar a quantidade; se o mínimo não for atingido, retorna `CAMPAIGN_COLLECTION_NOT_ENOUGH_PRODUCTS` e não cria campanha.

## Validação visual local parcial

No screenshot de 390px, o layout colapsa para uma coluna, as imagens ocupam a largura disponível sem overflow aparente, os títulos e preços permanecem legíveis e os CTAs vermelhos têm área de toque clara. No screenshot de 768px, a primeira peça aparece como destaque em largura total e os produtos seguintes aparecem em grid de duas colunas, com espaçamento e contraste coerentes com a identidade dark. A presença de imagens com dados dimensionais no próprio asset foi preservada sem tratamento ou alteração do conteúdo.

Ainda falta validar o screenshot de 1440px e executar uma verificação estrutural específica de overflow/elementos proibidos, além das checagens finais de lint, testes, build, diff e secret scan.
