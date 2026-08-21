# N17 Fase 20 — Notas de revogação da Render API key temporária

Data: 2026-08-20

## Fatos confirmados
1. API pública Render NÃO expõe revogação programática de API keys:
   - `DELETE https://api.render.com/v1/apiKeys/{key}` → 404 page not found
   - Documentação oficial (api-docs.render.com/reference/authentication):
     "If you believe an API key has been compromised, revoke it in the Render Dashboard and create a new one."
2. Key temporária: `rnd_AQsUapT3Tsqr3U4kDx6WxFyo6CEQ`
   - Criada pelo usuário para a Fase 14 (shell/exec jobs).
   - Ainda válida para GET (list services ok em 22:20 UTC).
   - Única permissão conhecida: acesso de leitura/criação de jobs no serviço srv-d9tq9sh42hec738skftg (não usada para escrita fora do scope da prova; nenhum env var alterado via API).
3. Dashboard: navegação via browser no sandbox não abriu a página de API keys do usuário diretamente
   (/user/api-keys e /user/settings redirecionam para o Overview).
   - Workspace: My Workspace (tea-d9r54in10e5c73ammjjg)
   - User: kauabrennan5@gmail.com
   - Caminho no dashboard para revogação: clicar no avatar do usuário (canto superior direito)
     → "User settings" → "API keys" (ou similar) → revogar a key rnd_AQsU...6CEQ.

## ATUALIZAÇÃO (22:26 UTC) — página encontrada
- Naveguei: /w/.../settings → menu do usuário (avatar) → Account settings
- URL final: https://dashboard.render.com/u/usr-d9r54in10e5c73ammjog/settings
- Seção API Keys contém 2 keys: "shoppe" (rnd_AQsUap…, criada há 1h, last used 3min — É a key temporária da Fase 14) e "FindsBot" (rnd_hx52FG…, criada há 9d — NÃO tocar, não é a da prova).
- Próximos passos: rolar até a tabela API Keys, clicar no botão "Menu" da linha "shoppe", escolher Revoke/Delete.

## CONFIRMADO (22:26-22:27 UTC) — revogação executada
- A key "shoppe" (rnd_AQsUap…) foi revogada no Render Dashboard via Account settings → API Keys → Menu → Revoke → confirmar.
- Tabela API Keys agora mostra apenas "FindsBot" (não tocada).
- Verificação programática: curl com a key retorna `{"message":"Unauthorized"}` e HTTP 401 em /v1/services — revogação confirmada.
- A key "FindsBot" (rnd_hx52FG…) não foi alterada.

## Conclusão para o relatório final
- Revogação programática: NÃO DISPONÍVEL na API pública Render (limite da plataforma, confirmado por tentativa e documentação).
- Ação necessária: usuário revoga manualmente no Render Dashboard > User settings > API keys.
- Mitigação de risco da key: apenas leitura/criação de jobs no serviço; nenhum segredo da Shopee exposto via essa key;
  env vars do serviço não foram lidas com secretValue pela API.

## Cleanup Supabase (executado com sucesso)
- BEFORE: products=14, candidates=1, candidate_evidence=10, candidate_assessment=5, affiliate_links=0, publication_executions=0, commercial_cycles=0, job_queue=0
- Removidos (com RETURNING):
  - 10 evidências (evi-sha256:4dc06775..., 9eaae5b9..., 93882923..., d4e72e0b..., a40a2483..., 86f5f3f3..., 5dd66c5d..., 5daaca15..., 846c80fb..., fd2198c0...)
  - 5 assessments (cur-aa9f89c7..., cur-876f2c42..., cb-044a25b7...-sha256:a8fb02aa..., cb-044a25b735cb3c468b36cdce, gov-044a25b7...-ACQUIRE_AFFILIATE...)
  - 1 candidato (can-044a25b735cb3c468b36cdce)
- AFTER: products=14, candidates=0, candidate_evidence=0, candidate_assessment=0, affiliate_links=0, publication_executions=0, commercial_cycles=0, job_queue=0
- Sem FKs entre essas tabelas — ordem de remoção foi evidências → assessments → candidato.
