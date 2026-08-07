import React, { useState } from 'react';
import { Copy, Check, FileText, Code2, Server, Rocket, Sparkles, Database } from 'lucide-react';

export const SetupGuide: React.FC = () => {
  const [copiedScript, setCopiedScript] = useState<boolean>(false);

  const appsScriptCode = `const SENHA_ADMIN = "SUA_SENHA_AQUI"; // Defina a mesma senha no painel do site

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    
    if (data.senha !== SENHA_ADMIN) {
      return ContentService.createTextOutput(JSON.stringify({ result: "erro", message: "Senha incorreta" }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("produtos") 
               || SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    
    sheet.appendRow([
      data.produto,
      data.categoria,
      data.preco,
      data.imagens,
      data.link,
      "sim",
      data.destaque ? "sim" : "nao"
    ]);

    return ContentService.createTextOutput(JSON.stringify({ result: "sucesso" }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ result: "erro", message: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}`;

  const copyToClipboard = () => {
    navigator.clipboard.writeText(appsScriptCode);
    setCopiedScript(true);
    setTimeout(() => setCopiedScript(false), 2000);
  };

  return (
    <div className="max-w-4xl mx-auto space-y-8 py-4 font-sans text-[#E8E1D3]">
      
      {/* Intro Header */}
      <div className="bg-[#181512] border border-[#3A342E] rounded-none p-8 space-y-3">
        <div className="flex items-center space-x-2 text-[#8A1F1F]">
          <Sparkles className="w-4 h-4" />
          <span className="font-display text-xs font-bold uppercase tracking-[0.2em]">
            MANUAL DE INTEGRAÇÃO TÉCNICA
          </span>
        </div>
        <h1 className="font-gothic text-3xl sm:text-4xl text-[#E8E1D3]">
          Conexão Cerberus Finds & Servidor Backend
        </h1>
        <p className="text-xs font-condensed uppercase tracking-wider text-[#E8E1D3]/70 leading-relaxed max-w-2xl">
          Instruções para operar o catálogo, Meta Pixel, TikTok Pixel e o formulário de cadastro administrativo.
        </p>
      </div>

      {/* Step 1: Backend Database & Storage */}
      <div className="bg-[#181512] border border-[#3A342E] rounded-none p-8 space-y-4">
        <div className="flex items-center space-x-3 border-b border-[#3A342E] pb-4">
          <div className="w-8 h-8 rounded-none bg-[#0B0908] text-[#8A1F1F] font-bold text-sm flex items-center justify-center font-mono border border-[#8A1F1F]">
            1
          </div>
          <div>
            <h2 className="font-gothic text-2xl text-[#E8E1D3] flex items-center space-x-2">
              <FileText className="w-5 h-5 text-[#8A1F1F]" />
              <span>Banco de Dados do Acervo</span>
            </h2>
            <p className="text-xs font-condensed text-[#E8E1D3]/60">
              O aplicativo utiliza um banco de dados relacional integrado no servidor backend Node/Express.
            </p>
          </div>
        </div>

        <p className="text-xs font-condensed text-[#E8E1D3]/80 leading-relaxed">
          Todas as peças cadastradas pelo painel administrativo privado são salvas no banco de dados do servidor em tempo real e expostas via endpoint REST em <code className="bg-[#0B0908] text-[#8A1F1F] px-1.5 py-0.5 border border-[#3A342E] font-mono">/api/products</code>.
        </p>
      </div>

      {/* Step 2: Meta Pixel (CAPI) & TikTok Pixels */}
      <div className="bg-[#181512] border border-[#3A342E] rounded-none p-8 space-y-4">
        <div className="flex items-center space-x-3 border-b border-[#3A342E] pb-4">
          <div className="w-8 h-8 rounded-none bg-[#0B0908] text-[#8A1F1F] font-bold text-sm flex items-center justify-center font-mono border border-[#8A1F1F]">
            2
          </div>
          <div>
            <h2 className="font-gothic text-2xl text-[#E8E1D3] flex items-center space-x-2">
              <Server className="w-5 h-5 text-[#8A1F1F]" />
              <span>Pixels de Intenção de Compra (InitiateCheckout & CAPI)</span>
            </h2>
            <p className="text-xs font-condensed text-[#E8E1D3]/60">
              Dispara eventos de compra tanto do navegador quanto via servidor Meta Conversions API.
            </p>
          </div>
        </div>

        <ul className="list-disc list-inside text-xs font-condensed text-[#E8E1D3]/80 space-y-2 leading-relaxed">
          <li>
            <strong>Meta Pixel + CAPI:</strong> Ao clicar no botão "ADQUIRIR", o sistema dispara o evento <code className="text-[#E8E1D3] bg-[#0B0908] px-1 py-0.5 border border-[#3A342E] font-mono">InitiateCheckout</code> via Pixel do cliente e simultaneamente pelo servidor (<code className="text-[#8A1F1F]">/api/meta-capi</code>) utilizando um <code className="text-[#E8E1D3]">event_id</code> único para deduplicação perfeita no Meta Commerce.
          </li>
          <li>
            <strong>TikTok Pixel:</strong> Dispara o evento de intenção de compra <code className="text-[#E8E1D3] bg-[#0B0908] px-1 py-0.5 border border-[#3A342E] font-mono">InitiateCheckout</code>.
          </li>
        </ul>
      </div>

      {/* Step 3: Standalone Form / Direct URL Access */}
      <div className="bg-[#181512] border border-[#3A342E] rounded-none p-8 space-y-4">
        <div className="flex items-center space-x-3 border-b border-[#3A342E] pb-4">
          <div className="w-8 h-8 rounded-none bg-[#0B0908] text-[#8A1F1F] font-bold text-sm flex items-center justify-center font-mono border border-[#8A1F1F]">
            3
          </div>
          <div>
            <h2 className="font-gothic text-2xl text-[#E8E1D3] flex items-center space-x-2">
              <Rocket className="w-5 h-5 text-[#8A1F1F]" />
              <span>Acesso Privado ao Painel por URL Direta</span>
            </h2>
            <p className="text-xs font-condensed text-[#E8E1D3]/60">
              O painel de cadastro não tem botão público e deve ser acessado por URL direta.
            </p>
          </div>
        </div>

        <div className="space-y-3 text-xs font-condensed text-[#E8E1D3]/80 leading-relaxed">
          <p>
            <strong>Acesso via Rota Privada:</strong><br />
            Para acessar o painel administrativo, navegue diretamente para as rotas ou parâmetros: <code className="text-[#8A1F1F] bg-[#0B0908] px-1.5 py-0.5 border border-[#3A342E] font-mono">/admin</code>, <code className="text-[#8A1F1F] bg-[#0B0908] px-1.5 py-0.5 border border-[#3A342E] font-mono">?view=admin</code> ou <code className="text-[#8A1F1F] bg-[#0B0908] px-1.5 py-0.5 border border-[#3A342E] font-mono">?mode=form</code>.
          </p>
        </div>
      </div>

      {/* Step 4: Bot de Telegram com Aprovação Inline & Webhook */}
      <div className="bg-[#181512] border border-[#3A342E] rounded-none p-8 space-y-4">
        <div className="flex items-center space-x-3 border-b border-[#3A342E] pb-4">
          <div className="w-8 h-8 rounded-none bg-[#0B0908] text-[#8A1F1F] font-bold text-sm flex items-center justify-center font-mono border border-[#8A1F1F]">
            4
          </div>
          <div>
            <h2 className="font-gothic text-2xl text-[#E8E1D3] flex items-center space-x-2">
              <Code2 className="w-5 h-5 text-[#8A1F1F]" />
              <span>Automação Nível 2 — Bot de Telegram com Webhook & Whitelist</span>
            </h2>
            <p className="text-xs font-condensed text-[#E8E1D3]/60">
              Envie links de produtos pelo Telegram para gerar prévia automática, copy e aprovar em 1 clique.
            </p>
          </div>
        </div>

        <div className="space-y-3 text-xs font-condensed text-[#E8E1D3]/80 leading-relaxed">
          <p><strong>Passo a Passo de Configuração do Bot de Telegram:</strong></p>
          <ol className="list-decimal list-inside space-y-2 text-[#E8E1D3]/90">
            <li>
              <strong>Criar o Bot no Telegram:</strong> No Telegram, converse com o <code className="text-[#8A1F1F] bg-[#0B0908] px-1 font-mono">@BotFather</code>, envie o comando <code className="text-[#E8E1D3] bg-[#0B0908] px-1 font-mono">/newbot</code>, dê um nome (ex: <i>Cerberus Curator Bot</i>) e guarde o <b>TOKEN HTTP API</b> gerado.
            </li>
            <li>
              <strong>Descobrir seu Telegram User ID:</strong> Converse com o bot <code className="text-[#8A1F1F] bg-[#0B0908] px-1 font-mono">@userinfobot</code> para obter seu número de ID de usuário no Telegram (ex: <code className="text-[#E8E1D3] bg-[#0B0908] px-1 font-mono">123456789</code>).
            </li>
            <li>
              <strong>Definir as Variáveis de Ambiente no Servidor:</strong>
              <div className="bg-[#0B0908] border border-[#3A342E] p-3 font-mono text-[11px] text-[#E8E1D3] my-2 space-y-1">
                <div>TELEGRAM_BOT_TOKEN="123456789:ABCdefGhIJKlmNoPQRstuVWXyz"</div>
                <div>TELEGRAM_ALLOWED_USERS="123456789,987654321"</div>
              </div>
            </li>
            <li>
              <strong>Modo Whitelist Silencioso & Validação de Domínio:</strong>
              Mensagens enviadas por IDs fora do <code className="text-[#E8E1D3] bg-[#0B0908] px-1 font-mono">TELEGRAM_ALLOWED_USERS</code> são completamente ignoradas (o bot não responde nem confirma sua existência). O bot aceita links da Shopee e Mercado Livre ou texto bruto como fallback.
            </li>
          </ol>
        </div>
      </div>

      {/* Step 5: Banco de Dados Persistente (Supabase Postgres) */}
      <div className="bg-[#181512] border border-[#3A342E] rounded-none p-8 space-y-4">
        <div className="flex items-center space-x-3 border-b border-[#3A342E] pb-4">
          <div className="w-8 h-8 rounded-none bg-[#0B0908] text-[#8A1F1F] font-bold text-sm flex items-center justify-center font-mono border border-[#8A1F1F]">
            5
          </div>
          <div>
            <h2 className="font-gothic text-2xl text-[#E8E1D3] flex items-center space-x-2">
              <Database className="w-5 h-5 text-[#8A1F1F]" />
              <span>Persistência Definitiva no Supabase (PostgreSQL Gerenciado)</span>
            </h2>
            <p className="text-xs font-condensed text-[#E8E1D3]/60">
              Garanta que nenhum dado ou produto cadastrado seja perdido em reinícios do Cloud Run.
            </p>
          </div>
        </div>

        <div className="space-y-4 text-xs font-condensed text-[#E8E1D3]/80 leading-relaxed">
          <p>
            O sistema inclui integração nativa com o <strong>Supabase PostgreSQL</strong>. Para conectar seu banco de dados persistente gratuito:
          </p>

          <div className="space-y-2">
            <p className="font-bold text-[#E8E1D3]">1. SQL de Criação da Tabela (Execute no SQL Editor do Supabase):</p>
            <pre className="bg-[#0B0908] border border-[#3A342E] p-3 font-mono text-[11px] text-[#E8E1D3] overflow-x-auto">
{`CREATE TABLE products (
  id TEXT PRIMARY KEY,
  ref TEXT,
  produto TEXT NOT NULL,
  categoria TEXT NOT NULL,
  preco NUMERIC NOT NULL,
  imagens JSONB NOT NULL DEFAULT '[]'::jsonb,
  link TEXT NOT NULL,
  ativo BOOLEAN DEFAULT TRUE,
  destaque BOOLEAN DEFAULT FALSE,
  status TEXT DEFAULT 'published',
  created_by TEXT DEFAULT 'system',
  slug TEXT,
  descricao TEXT,
  pagina_ponte_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);`}
            </pre>
          </div>

          <div className="space-y-2">
            <p className="font-bold text-[#E8E1D3]">2. Variáveis no .env:</p>
            <div className="bg-[#0B0908] border border-[#3A342E] p-3 font-mono text-[11px] text-[#E8E1D3]">
              <div>SUPABASE_URL="https://seu-projeto.supabase.co"</div>
              <div>SUPABASE_KEY="sua-anon-key-ou-service-role-key"</div>
            </div>
          </div>

          <div className="space-y-2 border-t border-[#3A342E] pt-3">
            <p className="font-bold text-[#E8E1D3]">3. Monitoramento do Plano Gratuito Supabase & Backup Manual:</p>
            <ul className="list-disc list-inside space-y-1 text-[#E8E1D3]/80">
              <li><strong>Armazenamento Gratuito:</strong> 500 MB de banco de dados (suficiente para ~500.000 produtos cadastrados).</li>
              <li><strong>Backup Manual:</strong> No painel do Supabase em <i>Table Editor &gt; products</i>, clique em <strong>Export as CSV</strong> ou utilize o <i>Database &gt; Backups</i> para exportação SQL.</li>
            </ul>
          </div>
        </div>
      </div>

    </div>
  );
};
