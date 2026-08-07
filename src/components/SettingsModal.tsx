import React, { useState } from 'react';
import { AppConfig } from '../types';
import { X, Save, Key, Link as LinkIcon, Tag, ShieldCheck, Copy, Check, Rss, LockKeyhole } from 'lucide-react';
import { getPasswordConfig, setAdminPassword } from '../services/api';

interface SettingsModalProps {
  isOpen: boolean;
  config: AppConfig;
  onSaveConfig: (newConfig: AppConfig) => void;
  onClose: () => void;
  /** Senha usada na autenticação atual, necessária para autorizar a troca de senha. */
  authenticatedPassword?: string;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  config,
  onSaveConfig,
  onClose,
  authenticatedPassword
}) => {
  const [csvUrl, setCsvUrl] = useState<string>(config.csvUrl);
  const [appsScriptUrl, setAppsScriptUrl] = useState<string>(config.appsScriptUrl);
  const [metaPixelId, setMetaPixelId] = useState<string>(config.metaPixelId);
  const [metaAccessToken, setMetaAccessToken] = useState<string>(config.metaAccessToken || '');
  const [tikTokPixelId, setTikTokPixelId] = useState<string>(config.tikTokPixelId);

  // Nova senha administrativa (editável apenas quando definida pelo servidor, não por ADMIN_PASSWORD)
  const [newAdminPassword, setNewAdminPassword] = useState<string>('');
  const [passwordEditable, setPasswordEditable] = useState<boolean>(true);
  const [passwordNotice, setPasswordNotice] = useState<string>('');
  const [passwordNoticeType, setPasswordNoticeType] = useState<'success' | 'error' | 'info'>('info');

  const [savedSuccess, setSavedSuccess] = useState<boolean>(false);
  const [copiedFeed, setCopiedFeed] = useState<boolean>(false);

  if (!isOpen) return null;

  // Consulta a fonte da senha atual ao abrir o modal
  const loadPasswordConfig = async () => {
    try {
      const cfg = await getPasswordConfig();
      if (cfg.success) {
        setPasswordEditable(cfg.editable);
        setPasswordNotice(
          cfg.editable
            ? 'A senha é gerenciada pelo servidor e pode ser alterada abaixo. As alterações valem imediatamente.'
            : 'A senha está definida pela variável de ambiente ADMIN_PASSWORD na infraestrutura e não pode ser alterada por aqui.'
        );
        setPasswordNoticeType('info');
      }
    } catch {
      setPasswordEditable(true);
    }
  };

  if (isOpen && !passwordNotice) {
    loadPasswordConfig();
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    onSaveConfig({
      csvUrl: csvUrl.trim(),
      appsScriptUrl: appsScriptUrl.trim(),
      metaPixelId: metaPixelId.trim(),
      metaAccessToken: metaAccessToken.trim(),
      tikTokPixelId: tikTokPixelId.trim(),
      adminPassword: ''
    });

    // Atualiza a senha administrativa, se o usuário preencheu o campo
    const trimmedNewPass = newAdminPassword.trim();
    if (trimmedNewPass.length > 0) {
      if (trimmedNewPass.length < 6) {
        setPasswordNotice('A nova senha deve ter pelo menos 6 caracteres.');
        setPasswordNoticeType('error');
        return;
      }
      const result = await setAdminPassword(trimmedNewPass, authenticatedPassword || config.adminPassword);
      if (result.success) {
        setPasswordNotice('Senha administrativa atualizada com sucesso! Use a nova senha no próximo acesso.');
        setPasswordNoticeType('success');
        setNewAdminPassword('');
      } else {
        setPasswordNotice(result.error || 'Erro ao atualizar a senha administrativa.');
        setPasswordNoticeType('error');
      }
    }

    setSavedSuccess(true);
    setTimeout(() => {
      setSavedSuccess(false);
      onClose();
    }, 600);
  };

  const feedUrlCsv = `${window.location.origin}/api/meta-feed.csv`;

  const copyFeedUrl = () => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(feedUrlCsv);
      setCopiedFeed(true);
      setTimeout(() => setCopiedFeed(false), 2000);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-[#0B0908]/85 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-[#181512] border border-[#3A342E] rounded-none w-full max-w-lg overflow-hidden shadow-2xl animate-in fade-in duration-200">
        
        {/* Modal Header */}
        <div className="p-5 border-b border-[#3A342E] flex items-center justify-between">
          <div className="flex items-center space-x-2.5">
            <div className="w-8 h-8 bg-[#0B0908] border border-[#8A1F1F] text-[#8A1F1F] flex items-center justify-center">
              <Key className="w-4 h-4" />
            </div>
            <div>
              <h2 className="font-gothic text-2xl text-[#E8E1D3]">
                Parâmetros de Integração
              </h2>
              <p className="text-[10px] font-display text-[#E8E1D3]/60 uppercase tracking-widest">
                Pixels Meta (CAPI), TikTok & Feed Meta Commerce
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 text-[#E8E1D3]/60 hover:text-[#E8E1D3] hover:bg-[#0B0908] transition-colors border border-transparent hover:border-[#3A342E]"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <form onSubmit={handleSubmit} className="p-5 space-y-4 max-h-[80vh] overflow-y-auto no-scrollbar font-sans">
          
          {/* Meta Commerce Manager Feed URL */}
          <div className="p-3 bg-[#0B0908] border border-[#3A342E] rounded-none space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-[10px] uppercase font-display tracking-widest text-[#8A1F1F] flex items-center space-x-1">
                <Rss className="w-3.5 h-3.5 text-[#8A1F1F]" />
                <span>Meta Commerce Manager Feed URL</span>
              </label>
              <button
                type="button"
                onClick={copyFeedUrl}
                className="text-[10px] uppercase font-display tracking-widest text-[#E8E1D3] flex items-center space-x-1 hover:text-[#8A1F1F]"
              >
                {copiedFeed ? (
                  <>
                    <Check className="w-3 h-3 text-[#8A1F1F]" />
                    <span>Copiado!</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3 h-3 text-[#8A1F1F]" />
                    <span>Copiar Feed</span>
                  </>
                )}
              </button>
            </div>
            <input
              type="text"
              readOnly
              value={feedUrlCsv}
              className="w-full bg-[#181512] border border-[#3A342E] text-[#E8E1D3] text-[11px] font-mono rounded-none p-2 focus:outline-none select-all"
            />
            <p className="text-[10px] font-condensed text-[#E8E1D3]/60">
              Cole este URL de Feed no Meta Commerce Manager para sincronizar seu catálogo para anúncios e loja no Instagram/Facebook.
            </p>
          </div>

          {/* Meta Pixel ID */}
          <div className="space-y-1">
            <label className="text-xs font-display uppercase tracking-widest text-[#E8E1D3] flex items-center space-x-1.5">
              <Tag className="w-3.5 h-3.5 text-[#8A1F1F]" />
              <span>Meta Pixel ID (Facebook Ads)</span>
            </label>
            <input
              type="text"
              value={metaPixelId}
              onChange={(e) => setMetaPixelId(e.target.value)}
              placeholder="Ex: 123456789012345"
              className="w-full bg-[#0B0908] border border-[#3A342E] focus:border-[#8A1F1F] text-[#E8E1D3] text-xs font-mono rounded-none p-2.5 focus:outline-none transition-colors"
            />
          </div>

          {/* Meta Access Token for CAPI */}
          <div className="space-y-1">
            <label className="text-xs font-display uppercase tracking-widest text-[#E8E1D3] flex items-center space-x-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-[#8A1F1F]" />
              <span>Token de Acesso Meta CAPI (Servidor)</span>
            </label>
            <input
              type="password"
              value={metaAccessToken}
              onChange={(e) => setMetaAccessToken(e.target.value)}
              placeholder="EAA..."
              className="w-full bg-[#0B0908] border border-[#3A342E] focus:border-[#8A1F1F] text-[#E8E1D3] text-xs rounded-none p-2.5 focus:outline-none transition-colors font-mono"
            />
            <p className="text-[10px] font-condensed text-[#E8E1D3]/50">
              Gerado no Gerenciador de Eventos da Meta em Configurações &gt; API de Conversões.
            </p>
          </div>

          {/* TikTok Pixel ID */}
          <div className="space-y-1">
            <label className="text-xs font-display uppercase tracking-widest text-[#E8E1D3] flex items-center space-x-1.5">
              <Tag className="w-3.5 h-3.5 text-[#8A1F1F]" />
              <span>TikTok Pixel ID</span>
            </label>
            <input
              type="text"
              value={tikTokPixelId}
              onChange={(e) => setTikTokPixelId(e.target.value)}
              placeholder="Ex: C1234567890ABCDEF"
              className="w-full bg-[#0B0908] border border-[#3A342E] focus:border-[#8A1F1F] text-[#E8E1D3] text-xs font-mono rounded-none p-2.5 focus:outline-none transition-colors"
            />
          </div>

          {/* Senha Administrativa do Painel */}
          <div className="space-y-1">
            <label className="text-xs font-display uppercase tracking-widest text-[#E8E1D3] flex items-center space-x-1.5">
              <LockKeyhole className="w-3.5 h-3.5 text-[#8A1F1F]" />
              <span>Nova Senha do Painel (Opcional)</span>
            </label>
            <input
              type="password"
              value={newAdminPassword}
              onChange={(e) => setNewAdminPassword(e.target.value)}
              placeholder={passwordEditable ? "Defina a nova senha do administrador..." : "Senha definida pela infraestrutura (bloqueada)"}
              disabled={!passwordEditable}
              className="w-full bg-[#0B0908] border border-[#3A342E] focus:border-[#8A1F1F] disabled:opacity-40 disabled:cursor-not-allowed text-[#E8E1D3] text-xs rounded-none p-2.5 focus:outline-none transition-colors font-mono"
            />
            <p className="text-[10px] font-condensed text-[#E8E1D3]/50">
              Mínimo de 6 caracteres. A senha é persistida no servidor e nunca é armazenada neste navegador.
              {passwordNotice ? (
                <span className={passwordNoticeType === 'success' ? ' text-[#5A8A5A]' : passwordNoticeType === 'error' ? ' text-[#8A1F1F]' : ' text-[#E8E1D3]/60'}>
                  {' '}• {passwordNotice}
                </span>
              ) : null}
            </p>
          </div>

          {/* Legacy CSV URL */}
          <div className="pt-2 border-t border-[#3A342E] space-y-3">
            <span className="text-[10px] font-display uppercase tracking-widest text-[#E8E1D3]/50 block">
              Integração Legada / Google Sheets (Opcional)
            </span>

            <div className="space-y-1">
              <label className="text-[11px] font-display uppercase tracking-widest text-[#E8E1D3]/70 flex items-center space-x-1">
                <LinkIcon className="w-3 h-3 text-[#8A1F1F]" />
                <span>URL da Planilha CSV</span>
              </label>
              <input
                type="url"
                value={csvUrl}
                onChange={(e) => setCsvUrl(e.target.value)}
                placeholder="https://docs.google.com/spreadsheets/d/e/.../pub?output=csv"
                className="w-full bg-[#0B0908] border border-[#3A342E] text-[#E8E1D3] text-xs font-mono rounded-none p-2 focus:outline-none"
              />
            </div>
          </div>

          {/* Actions */}
          <div className="pt-4 border-t border-[#3A342E] flex items-center justify-end space-x-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 bg-[#0B0908] border border-[#3A342E] hover:border-[#8A1F1F] text-[#E8E1D3] text-xs font-display uppercase tracking-widest transition-colors rounded-none"
            >
              Cancelar
            </button>

            <button
              type="submit"
              className="px-5 py-2 bg-[#8A1F1F] hover:bg-[#8A1F1F]/80 text-[#E8E1D3] text-xs font-display uppercase tracking-widest flex items-center space-x-1.5 transition-colors border border-[#8A1F1F] rounded-none"
            >
              {savedSuccess ? (
                <span>Atualizado!</span>
              ) : (
                <>
                  <Save className="w-4 h-4 text-[#E8E1D3]" />
                  <span>Salvar Parâmetros</span>
                </>
              )}
            </button>
          </div>

        </form>

      </div>
    </div>
  );
};
