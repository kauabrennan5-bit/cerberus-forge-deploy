import React, { useState, useRef } from 'react';
import { AppConfig, Product } from '../types';
import { extractProduct, createProduct, deleteProduct, verifyAdminPassword } from '../services/api';
import { Sparkles, Lock, Trash2, Check, AlertTriangle, Link as LinkIcon, Loader2, Upload, Image as ImageIcon, ShieldCheck } from 'lucide-react';

interface AdminFormProps {
  config: AppConfig;
  products: Product[];
  existingCategories: string[];
  onProductAdded: () => void;
  onProductDeleted: (id: string) => void;
  onOpenSettings: (password?: string) => void;
}

interface AttachedImage {
  id: string;
  file?: File;
  previewUrl: string;
  base64: string;
}

export const AdminForm: React.FC<AdminFormProps> = ({
  config,
  products,
  existingCategories,
  onProductAdded,
  onProductDeleted
}) => {
  // Authentication state
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [passwordInput, setPasswordInput] = useState<string>('');
  const [authError, setAuthError] = useState<string | null>(null);

  // Form Fields
  const [link, setLink] = useState<string>('');
  const [rawPageText, setRawPageText] = useState<string>('');
  const [showRawTextAccordion, setShowRawTextAccordion] = useState<boolean>(false);

  const [produto, setProduto] = useState<string>('');
  const [refCode, setRefCode] = useState<string>('');
  const [selectedCategory, setSelectedCategory] = useState<string>('');
  const [customCategory, setCustomCategory] = useState<string>('');
  const [isNewCategory, setIsNewCategory] = useState<boolean>(false);

  const [preco, setPreco] = useState<string>('');
  const [descricao, setDescricao] = useState<string>('');
  const [paginaPonteUrl, setPaginaPonteUrl] = useState<string>('');
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([]);
  const [destaque, setDestaque] = useState<boolean>(false);

  // Status & Progress UI States
  const [isExtracting, setIsExtracting] = useState<boolean>(false);
  const [extractionNotice, setExtractionNotice] = useState<string | null>(null);

  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [submitSuccess, setSubmitSuccess] = useState<boolean>(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Handle password submission
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);

    if (!passwordInput.trim()) {
      setAuthError('Informe a senha administrativa.');
      return;
    }

    const result = await verifyAdminPassword(passwordInput);
    if (result.success) {
      setIsAuthenticated(true);
    } else {
      setAuthError(result.error || 'Senha incorreta. Tente novamente.');
    }
  };

  // Convert File to Base64 String
  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = error => reject(error);
    });
  };

  // Handle Image File Selection (Multiple)
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    const filesArray = Array.from(e.target.files) as File[];

    const newAttached: AttachedImage[] = [];

    for (const file of filesArray) {
      if (!file.type.startsWith('image/')) continue;
      try {
        const base64 = await fileToBase64(file);
        const previewUrl = URL.createObjectURL(file);
        newAttached.push({
          id: Math.random().toString(36).substring(2, 9),
          file,
          previewUrl,
          base64
        });
      } catch (err) {
        console.error('Erro ao ler imagem:', err);
      }
    }

    setAttachedImages(prev => [...prev, ...newAttached]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleRemoveImage = (id: string) => {
    setAttachedImages(prev => prev.filter(img => img.id !== id));
  };

  // Handle AI Extraction call
  const handleExtractAI = async () => {
    let targetUrl = link.trim();
    let targetRawText = rawPageText.trim();

    // Se o usuário colou o texto do produto no campo de link em vez de uma URL
    if (targetUrl && !targetUrl.startsWith('http://') && !targetUrl.startsWith('https://') && !targetUrl.startsWith('www.')) {
      if (!targetRawText) {
        targetRawText = targetUrl;
      } else {
        targetRawText = `${targetUrl}\n\n${targetRawText}`;
      }
      targetUrl = '';
    }

    if (!targetUrl && !targetRawText) {
      setValidationError('Insira um Link do produto ou cole o texto da página para extrair com IA.');
      return;
    }

    setValidationError(null);
    setExtractionNotice(null);
    setIsExtracting(true);

    try {
      const adminPass = passwordInput;
      const resData = await extractProduct(targetUrl, targetRawText, adminPass);

      if (resData.success && resData.data) {
        const { produto: extProduto, preco: extPreco, imagens: extImagens, descricao: extDescricao, ref: extRef } = resData.data;

        if (extProduto) setProduto(extProduto);
        if (extPreco !== null && extPreco !== undefined && extPreco > 0) {
          setPreco(String(extPreco));
        } else {
          setPreco('');
        }
        if (extDescricao) setDescricao(extDescricao);
        if (extRef) setRefCode(extRef);
        if (resData.data.categoria && existingCategories.includes(resData.data.categoria)) {
          setSelectedCategory(resData.data.categoria);
        }

        if (Array.isArray(extImagens) && extImagens.length > 0) {
          const fetchedImages: AttachedImage[] = extImagens.slice(0, 4).map((url: string) => ({
            id: Math.random().toString(36).substring(2, 9),
            previewUrl: url,
            base64: url
          }));
          setAttachedImages(prev => [...prev, ...fetchedImages]);
        }

        if (extPreco === null || extPreco === undefined || extPreco <= 0) {
          setExtractionNotice('Preço não encontrado automaticamente. Informe manualmente antes de publicar.');
        } else {
          setExtractionNotice('IA gerou o título, preço, imagens, REF e copy em tom curatorial Cerberus! Selecione a categoria.');
        }
      } else {
        setExtractionNotice(resData.error || 'IA não conseguiu extrair os dados reais. Cole o texto do anúncio para continuar.');
        setShowRawTextAccordion(true);
      }
    } catch (err: any) {
      console.error('Erro ao chamar extração:', err);
      setExtractionNotice('Não foi possível conectar ao serviço de IA. Preencha manualmente.');
    } finally {
      setIsExtracting(false);
    }
  };

  // Form submission directly to Backend Server API (/api/products)
  const handleSubmitProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError(null);
    setSubmitError(null);
    setSubmitSuccess(false);

    // Validation
    if (!link.trim() || !link.startsWith('http')) {
      setValidationError('O Link do produto é obrigatório (deve começar com http:// ou https://)');
      return;
    }

    if (!produto.trim()) {
      setValidationError('O Nome da peça é obrigatório.');
      return;
    }

    const finalCategory = isNewCategory ? customCategory.trim() : selectedCategory.trim();
    if (!finalCategory) {
      setValidationError('Selecione ou crie uma Categoria para a peça.');
      return;
    }

    const priceNum = parseFloat(preco.replace(',', '.'));
    if (isNaN(priceNum) || priceNum <= 0) {
      setValidationError('Insira um Preço válido maior que zero.');
      return;
    }

    if (attachedImages.length === 0) {
      setValidationError('Anexe pelo menos 1 foto do produto.');
      return;
    }

    setIsSubmitting(true);
    setUploadProgress(20);

    try {
      const base64List = attachedImages.map(img => img.base64);
      const adminPass = passwordInput;

      const payload = {
        senha: adminPass,
        produto: produto.trim(),
        categoria: finalCategory,
        preco: priceNum,
        imagens: base64List,
        link: link.trim(),
        destaque: destaque,
        descricao: descricao.trim(),
        paginaPonteUrl: paginaPonteUrl.trim()
      };

      setUploadProgress(50);

      // Backend Auth-validated API submission
      const resJson = await createProduct(payload, adminPass);

      setUploadProgress(85);
      setUploadProgress(100);

      if (resJson.success) {
        setSubmitSuccess(true);
        // Reset form
        setLink('');
        setRawPageText('');
        setProduto('');
        setPreco('');
        setDescricao('');
        setPaginaPonteUrl('');
        setAttachedImages([]);
        setDestaque(false);
        setSelectedCategory('');
        setCustomCategory('');
        setIsNewCategory(false);
        setExtractionNotice(null);

        onProductAdded();
      } else {
        setSubmitError(resJson.error || 'Erro ao salvar no banco de dados.');
      }
    } catch (err: any) {
      console.error('Erro ao publicar:', err);
      setSubmitError(`Erro no envio: ${err.message || 'Falha de conexão com o servidor'}.`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteProduct = async (id: string) => {
    console.log("DELETE CLICK", id);
    console.log('[DELETE LOG 1] Clique no botão da lixeira para o produto ID:', id);
    console.log('[DELETE LOG 2] ID recebido pela função handleDeleteProduct():', id);

    setDeletingId(id);
    setValidationError(null);

    try {
      const adminPass = passwordInput || '';
      const resJson = await deleteProduct(id, adminPass);

      if (resJson.success) {
        console.log('[DELETE LOG 11 - AdminForm] Sucesso retornado. Notificando callback onProductDeleted para ID:', id);
        onProductDeleted(id);
      } else {
        const errText = resJson.error || 'Não foi possível excluir o produto.';
        setValidationError(errText);
      }
    } catch (err: any) {
      const errText = 'Erro ao excluir: ' + (err.message || 'Erro desconhecido');
      setValidationError(errText);
    } finally {
      setDeletingId(null);
    }
  };

  // Lock Screen view
  if (!isAuthenticated) {
    return (
      <div className="max-w-md mx-auto py-16 px-4 text-center font-sans">
        <div className="bg-[#181512] border border-[#3A342E] rounded-none p-8 space-y-6">
          <div className="w-12 h-12 bg-[#0B0908] text-[#8A1F1F] flex items-center justify-center mx-auto border border-[#8A1F1F]">
            <Lock className="w-5 h-5" />
          </div>

          <div>
            <h2 className="font-gothic text-3xl font-normal text-[#E8E1D3]">
              Acesso Restrito
            </h2>
            <p className="text-xs font-display text-[#E8E1D3]/60 mt-1 uppercase tracking-widest">
              PAINEL ADMINISTRATIVO
            </p>
          </div>

          <form onSubmit={handleLogin} className="space-y-4 text-left">
            <div>
              <label className="block text-[11px] font-display uppercase tracking-widest text-[#E8E1D3]/80 mb-1.5">
                Senha de Acesso
              </label>
              <input
                type="password"
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                placeholder="Insira a senha do administrador..."
                className="w-full bg-[#0B0908] border border-[#3A342E] focus:border-[#8A1F1F] text-[#E8E1D3] text-xs rounded-none px-3.5 py-2.5 focus:outline-none transition-colors"
                autoFocus
              />
            </div>

            {authError && (
              <p className="text-xs text-[#8A1F1F] font-medium flex items-center space-x-1">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                <span>{authError}</span>
              </p>
            )}

            <button
              type="submit"
              id="admin-login-submit"
              className="w-full py-3 bg-[#8A1F1F] hover:bg-[#8A1F1F]/80 text-[#E8E1D3] font-display text-xs tracking-widest uppercase rounded-none transition-colors border border-[#8A1F1F]"
            >
              Autenticar Acesso
            </button>
          </form>

          <p className="text-[10px] font-mono text-[#E8E1D3]/50 pt-3 border-t border-[#3A342E]">
            Acesso reservado. Senha padrão: cerberus2026 — trocável em Parâmetros de Integração.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-8 py-4 font-sans">
      
      {/* Title Bar */}
      <div className="flex items-center justify-between border-b border-[#3A342E] pb-4">
        <div>
          <span className="stamp-badge text-[9px] px-1.5 py-0.2">
            PAINEL BACKEND
          </span>
          <h1 className="font-gothic text-3xl sm:text-4xl text-[#E8E1D3] mt-1">
            Cadastrar Nova Peça
          </h1>
        </div>

        <button
          onClick={() => setIsAuthenticated(false)}
          className="text-xs font-display text-[#E8E1D3]/70 hover:text-[#E8E1D3] px-3.5 py-1.5 bg-[#0B0908] border border-[#3A342E] hover:border-[#8A1F1F] rounded-none transition-colors uppercase tracking-widest"
        >
          Encerrar Sessão
        </button>
      </div>

      {/* Main Form Container */}
      <div className="bg-[#181512] border border-[#3A342E] rounded-none p-6 sm:p-8 space-y-6">
        
        {/* Step 1: Link & AI Extraction Button */}
        <div className="space-y-3 p-4 bg-[#0B0908] border border-[#3A342E] rounded-none">
          <label className="block text-xs font-display text-[#E8E1D3] uppercase tracking-widest flex items-center space-x-2">
            <LinkIcon className="w-3.5 h-3.5 text-[#8A1F1F]" />
            <span>1. Link da Peça (URL de Afiliado)</span>
          </label>

          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="url"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="https://shopee.com.br/produto-exemplo..."
              className="flex-1 bg-[#181512] border border-[#3A342E] focus:border-[#8A1F1F] text-[#E8E1D3] text-xs font-mono rounded-none px-3.5 py-2.5 focus:outline-none transition-colors"
            />

            <button
              type="button"
              onClick={handleExtractAI}
              disabled={isExtracting}
              id="ai-extract-btn"
              className="shrink-0 px-4 py-2.5 bg-[#8A1F1F] hover:bg-[#8A1F1F]/80 disabled:opacity-50 text-[#E8E1D3] font-display text-xs tracking-widest uppercase rounded-none flex items-center justify-center space-x-2 transition-colors border border-[#8A1F1F]"
            >
              {isExtracting ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Extraindo...</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-3.5 h-3.5 text-[#E8E1D3]" />
                  <span>Extrair com IA</span>
                </>
              )}
            </button>
          </div>

          <div className="pt-1">
            <button
              type="button"
              onClick={() => setShowRawTextAccordion(!showRawTextAccordion)}
              className="text-xs font-display text-[#E8E1D3]/60 hover:text-[#E8E1D3] underline"
            >
              {showRawTextAccordion ? '- Ocultar texto da página' : '+ Cole o texto da página se necessário'}
            </button>

            {showRawTextAccordion && (
              <textarea
                value={rawPageText}
                onChange={(e) => setRawPageText(e.target.value)}
                rows={3}
                placeholder="Cole o texto ou especificações copiadas do site..."
                className="mt-2 w-full bg-[#181512] border border-[#3A342E] focus:border-[#8A1F1F] text-[#E8E1D3] text-xs rounded-none p-3 focus:outline-none transition-colors"
              />
            )}
          </div>

          {extractionNotice && (
            <p className="text-xs text-[#E8E1D3] bg-[#181512] p-3 border border-[#8A1F1F] flex items-center space-x-2">
              <Sparkles className="w-4 h-4 text-[#8A1F1F] shrink-0" />
              <span>{extractionNotice}</span>
            </p>
          )}
        </div>

        {/* Validation Error Banner */}
        {validationError && (
          <div className="bg-[#8A1F1F]/20 border border-[#8A1F1F] rounded-none p-3 text-xs text-[#E8E1D3] font-medium flex items-center space-x-2">
            <AlertTriangle className="w-4 h-4 text-[#8A1F1F] shrink-0" />
            <span>{validationError}</span>
          </div>
        )}

        {/* Global Submit Error Banner */}
        {submitError && (
          <div className="bg-[#8A1F1F]/30 border border-[#8A1F1F] rounded-none p-4 text-xs text-[#E8E1D3] space-y-2">
            <div className="flex items-center space-x-2 font-bold">
              <AlertTriangle className="w-4 h-4 text-[#8A1F1F] shrink-0" />
              <span>Erro de Gravação Backend</span>
            </div>
            <p className="leading-relaxed">{submitError}</p>
          </div>
        )}

        {/* Success Banner */}
        {submitSuccess && (
          <div className="bg-[#181512] border border-[#8A1F1F] text-[#E8E1D3] rounded-none p-4 text-xs flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <Check className="w-4 h-4 text-[#8A1F1F] shrink-0" />
              <span>Peça gravada com sucesso no banco de dados backend!</span>
            </div>
            <button
              onClick={() => setSubmitSuccess(false)}
              className="text-[11px] font-display text-[#E8E1D3]/70 underline hover:text-white"
            >
              Dispensar
            </button>
          </div>
        )}

        {/* Form Fields Form */}
        <form onSubmit={handleSubmitProduct} className="space-y-5">
          
          {/* Nome do Produto */}
          <div>
            <label className="block text-xs font-display text-[#E8E1D3] uppercase tracking-widest mb-1.5">
              Título da Peça / Produto <span className="text-[#8A1F1F]">*</span>
            </label>
            <input
              type="text"
              value={produto}
              onChange={(e) => setProduto(e.target.value)}
              placeholder="Ex: Jaqueta Archival Gothic Oversized Metal"
              className="w-full bg-[#0B0908] border border-[#3A342E] focus:border-[#8A1F1F] text-[#E8E1D3] text-sm rounded-none px-3.5 py-2.5 focus:outline-none transition-colors font-display"
            />
          </div>

          {/* Categoria - MANUAL SELECTION */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-display text-[#E8E1D3] uppercase tracking-widest">
                Categoria da Peça <span className="text-[#8A1F1F]">*</span>
              </label>
              <span className="text-[10px] text-[#8A1F1F] uppercase tracking-widest font-mono">
                (Seleção Manual Obrigatória)
              </span>
            </div>

            {!isNewCategory ? (
              <select
                value={selectedCategory}
                onChange={(e) => {
                  if (e.target.value === '__NEW__') {
                    setIsNewCategory(true);
                    setSelectedCategory('');
                  } else {
                    setSelectedCategory(e.target.value);
                  }
                }}
                className="w-full bg-[#0B0908] border border-[#3A342E] focus:border-[#8A1F1F] text-[#E8E1D3] text-xs font-display uppercase tracking-wider rounded-none px-3.5 py-2.5 focus:outline-none transition-colors"
              >
                <option value="">-- Escolha Manualmente a Categoria --</option>
                {existingCategories.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
                <option value="__NEW__">+ Criar nova categoria de curadoria...</option>
              </select>
            ) : (
              <div className="flex items-center space-x-2">
                <input
                  type="text"
                  value={customCategory}
                  onChange={(e) => setCustomCategory(e.target.value)}
                  placeholder="Nome da nova categoria..."
                  className="flex-1 bg-[#0B0908] border border-[#3A342E] focus:border-[#8A1F1F] text-[#E8E1D3] text-xs font-display uppercase tracking-wider rounded-none px-3.5 py-2.5 focus:outline-none transition-colors"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => {
                    setIsNewCategory(false);
                    setCustomCategory('');
                  }}
                  className="px-3 py-2.5 bg-[#0B0908] border border-[#3A342E] text-[#E8E1D3] hover:border-[#8A1F1F] rounded-none text-xs font-display uppercase tracking-wider"
                >
                  Cancelar
                </button>
              </div>
            )}
          </div>

          {/* Preço */}
          <div>
            <label className="block text-xs font-display text-[#E8E1D3] uppercase tracking-widest mb-1.5">
              Preço Estimado (R$) <span className="text-[#8A1F1F]">*</span>
            </label>
            <input
              type="number"
              step="0.01"
              inputMode="decimal"
              value={preco}
              onChange={(e) => setPreco(e.target.value)}
              placeholder="Ex: 389.00"
              className="w-full bg-[#0B0908] border border-[#3A342E] focus:border-[#8A1F1F] text-[#E8E1D3] text-xs rounded-none px-3.5 py-2.5 focus:outline-none transition-colors font-mono"
            />
          </div>

          {/* Descrição Curatorial do Produto */}
          <div>
            <label className="block text-xs font-display text-[#E8E1D3] uppercase tracking-widest mb-1.5">
              Especificações & Descrição Curatorial (Opcional)
            </label>
            <textarea
              value={descricao}
              onChange={(e) => setDescricao(e.target.value)}
              rows={2}
              placeholder="Detalhes de caimento, tecido, acabamento e estilo..."
              className="w-full bg-[#0B0908] border border-[#3A342E] focus:border-[#8A1F1F] text-[#E8E1D3] text-xs font-condensed rounded-none p-3 focus:outline-none transition-colors"
            />
          </div>

          {/* URL da Página Ponte / Presell (Opcional) */}
          <div>
            <label className="block text-xs font-display text-[#E8E1D3] uppercase tracking-widest mb-1.5">
              URL da Página Ponte / Presell (Opcional)
            </label>
            <input
              type="url"
              value={paginaPonteUrl}
              onChange={(e) => setPaginaPonteUrl(e.target.value)}
              placeholder="https://suapaginaponte.com/landing-especial..."
              className="w-full bg-[#0B0908] border border-[#3A342E] focus:border-[#8A1F1F] text-[#E8E1D3] text-xs rounded-none px-3.5 py-2.5 focus:outline-none transition-colors font-mono"
            />
          </div>

          {/* UPLOAD DE IMAGENS POR ARQUIVO DIRETO COM PRÉVIA */}
          <div className="space-y-3 pt-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-display text-[#E8E1D3] uppercase tracking-widest flex items-center space-x-1.5">
                <ImageIcon className="w-3.5 h-3.5 text-[#8A1F1F]" />
                <span>Upload de Fotos (Com Prévia Instantânea) <span className="text-[#8A1F1F]">*</span></span>
              </label>
              <span className="text-[10px] text-[#E8E1D3]/50 font-display uppercase tracking-widest">
                Selecione arquivos do dispositivo
              </span>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={handleFileChange}
              className="hidden"
            />

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="w-full border-2 border-dashed border-[#3A342E] hover:border-[#8A1F1F] bg-[#0B0908] p-6 rounded-none text-center transition-colors group space-y-2 cursor-pointer"
            >
              <div className="w-10 h-10 bg-[#181512] border border-[#3A342E] text-[#8A1F1F] flex items-center justify-center mx-auto group-hover:scale-105 transition-transform">
                <Upload className="w-4 h-4" />
              </div>
              <p className="text-xs font-display text-[#E8E1D3] uppercase tracking-wider">
                Clique para fazer upload de imagens do computador ou celular
              </p>
              <p className="text-[10px] font-mono text-[#E8E1D3]/50 uppercase">
                Imagens convertidas em Base64 para gravação backend
              </p>
            </button>

            {/* Attached Image Previews Grid */}
            {attachedImages.length > 0 && (
              <div className="space-y-2 pt-2">
                <p className="text-[10px] font-display uppercase tracking-widest text-[#8A1F1F]">
                  Prévia das Imagens Anexadas ({attachedImages.length}):
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {attachedImages.map((img) => (
                    <div
                      key={img.id}
                      className="relative bg-[#0B0908] border border-[#3A342E] rounded-none overflow-hidden p-1.5"
                    >
                      <img
                        src={img.previewUrl}
                        alt="Preview"
                        className="w-full h-24 object-contain"
                      />
                      <button
                        type="button"
                        onClick={() => handleRemoveImage(img.id)}
                        className="absolute top-2 right-2 p-1 bg-[#8A1F1F] text-[#E8E1D3] hover:bg-[#8A1F1F]/80 rounded-none transition-colors"
                        title="Remover Imagem"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Destaque Toggle */}
          <div className="pt-3 border-t border-[#3A342E] flex items-center justify-between">
            <div>
              <span className="text-xs font-display text-[#E8E1D3] uppercase tracking-wider block">
                Etiqueta de Edição Limitada
              </span>
              <span className="text-[11px] font-condensed text-[#E8E1D3]/60 block">
                Exibe o badge "LIMITED" no acervo.
              </span>
            </div>

            <button
              type="button"
              onClick={() => setDestaque(!destaque)}
              className={`w-11 h-6 transition-colors relative p-1 rounded-none border ${
                destaque ? 'bg-[#8A1F1F] border-[#8A1F1F]' : 'bg-[#0B0908] border-[#3A342E]'
              }`}
            >
              <span
                className={`w-4 h-4 bg-[#E8E1D3] block transition-transform ${
                  destaque ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          {/* Submission Progress Bar */}
          {isSubmitting && (
            <div className="space-y-1.5 pt-2">
              <div className="flex justify-between text-[10px] font-display uppercase tracking-widest text-[#8A1F1F]">
                <span>Salvando no banco de dados...</span>
                <span>{uploadProgress}%</span>
              </div>
              <div className="w-full h-1.5 bg-[#0B0908] overflow-hidden border border-[#3A342E]">
                <div
                  className="h-full bg-[#8A1F1F] transition-all duration-300"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
            </div>
          )}

          {/* Submit Action */}
          <div className="pt-4">
            <button
              type="submit"
              disabled={isSubmitting}
              id="submit-product-btn"
              className="w-full py-3.5 bg-[#8A1F1F] hover:bg-[#8A1F1F]/80 disabled:opacity-50 text-[#E8E1D3] font-display text-xs uppercase tracking-widest flex items-center justify-center space-x-2 transition-colors border border-[#8A1F1F]"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin text-[#E8E1D3]" />
                  <span>Salvando no Banco...</span>
                </>
              ) : (
                <>
                  <ShieldCheck className="w-4 h-4 text-[#E8E1D3]" />
                  <span>Publicar no Banco do Acervo</span>
                </>
              )}
            </button>
          </div>

        </form>

      </div>

      {/* Backend Products Management List */}
      <div className="bg-[#181512] border border-[#3A342E] rounded-none p-6 space-y-4">
        <h3 className="font-gothic text-2xl text-[#E8E1D3]">
          Gerenciar Peças Cadastradas ({products.length})
        </h3>
        <p className="text-xs text-[#E8E1D3]/60 font-condensed">
          Remova peças diretamente do banco de dados backend.
        </p>

        <div className="divide-y divide-[#3A342E]">
          {products.map((p) => (
            <div key={p.id} className="py-3 flex items-center justify-between text-xs">
              <div className="flex items-center space-x-3">
                <div className="w-10 h-10 bg-[#0B0908] border border-[#3A342E] rounded-none overflow-hidden shrink-0">
                  {p.imagens?.[0] ? (
                    <img src={p.imagens[0]} alt={p.produto} className="w-full h-full object-contain" />
                  ) : (
                    <div className="w-full h-full bg-[#0B0908]" />
                  )}
                </div>
                <div>
                  <p className="font-display uppercase font-bold text-sm text-[#E8E1D3]">{p.produto}</p>
                  <p className="text-[10px] font-mono text-[#8A1F1F] uppercase">{p.categoria} • R$ {p.preco.toFixed(2)}</p>
                </div>
              </div>

              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  handleDeleteProduct(p.id);
                }}
                disabled={deletingId === p.id}
                className="p-2 text-[#E8E1D3]/60 hover:text-[#8A1F1F] hover:bg-[#0B0908] rounded-none transition-colors border border-transparent hover:border-[#8A1F1F]"
                title="Remover peça do banco de dados"
              >
                {deletingId === p.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
              </button>
            </div>
          ))}
        </div>
      </div>

    </div>
  );
};
