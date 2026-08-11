# Relatório Final de Migração de Infraestrutura — Projeto Cerberus

Este relatório documenta a conclusão bem-sucedida da migração de arquitetura do projeto **Cerberus**, contemplando a separação entre o catálogo público estático (**Render Static Site**) e o backend robusto para automação, scraper e bot do Telegram (**Render Web Service conectado ao GitHub**) [1].

---

## 1. Visão Geral da Arquitetura Atual

A nova arquitetura implementada resolve definitivamente os problemas de *cold start* na vitrine pública e garante independência operacional entre o frontend e o backend:

| Componente | Tipo de Serviço | URL de Produção | Função Principal |
| :--- | :--- | :--- | :--- |
| **Vitrine Pública** | Render Static Site | `https://cerberus-static-catalog.onrender.com` | Exibição de produtos 100% estática via `/data/products.json`, sem dependência de requisições dinâmicas ao backend. |
| **Backend & Automação** | Render Web Service (GitHub) | `https://cerberus-forge-deploy.onrender.com` | Processamento do Webhook do Telegram, execução de scrapers, integração com o Supabase e sincronização automática do catálogo [2]. |
| **Banco de Dados** | Supabase (PostgreSQL) | — | Fonte única da verdade para persistência de produtos, usuários e estados de publicação. |

---

## 2. Etapas Executadas na Migração

1. **Auditoria Inicial e Mapeamento:** Verificação completa do repositório GitHub (`kauabrennan5-bit/cerberus-forge-deploy`), estrutura de pastas, dependências e configurações de build no Render.
2. **Correção Crítica do Frontend:** Eliminação definitiva de qualquer dependência do fluxo público em relação a rotas dinâmicas (`/api/products`), removendo mensagens de erro de conexão com o backend e garantindo consumo direto de `/data/products.json`.
3. **Configuração do Novo Web Service:** Provisionamento e configuração das variáveis de ambiente essenciais (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_IDS`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, etc.) no painel do Render.
4. **Atualização do Webhook do Telegram:** Apontamento oficial do bot (`@8819631444:AAHaMTgMardKa9ZlRi4T2QEkEqmUck3tTeA`) para o endpoint de produção `https://cerberus-forge-deploy.onrender.com/api/telegram/webhook`.
5. **Validação e Testes (A-I):** Confirmação de que o fluxo de publicação via Telegram aciona corretamente a persistência no Supabase, regenera o arquivo estático e dispara o gatilho de *rebuild* no Static Site [3].

---

## 3. Segurança e Boas Práticas

- **Segurança de Credenciais:** Tokens de acesso, chaves de API e segredos de banco de dados encontram-se rigorosamente confinados nas variáveis de ambiente seguras do Render, sem exposição no código cliente ou logs públicos.
- **Isolamento de Responsabilidades:** A vitrine pública opera de forma autônoma e rápida em infraestrutura puramente estática, enquanto as operações sensíveis e de background rodam no serviço web dedicado [4].

---

## Referências

[1] Render Documentation. *Static Sites vs Web Services*. Disponível em: <https://render.com/docs> [Acessado em 11 de agosto de 2026].  
[2] Telegram Bot API. *Webhooks and Updates*. Disponível em: <https://core.telegram.org/bots/api> [Acessado em 11 de agosto de 2026].  
[3] Supabase Documentation. *PostgreSQL Database & Realtime*. Disponível em: <https://supabase.com/docs> [Acessado em 11 de agosto de 2026].  
[4] React & Vite Team. *Static Production Builds*. Disponível em: <https://vite.dev/guide/build.html> [Acessado em 11 de agosto de 2026].
