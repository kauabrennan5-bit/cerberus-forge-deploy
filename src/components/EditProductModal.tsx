import React, { useState, useEffect, useRef } from 'react';
import { Product } from '../types';
import { updateProduct } from '../services/api';
import { Pencil, X, Check, AlertTriangle, Loader2, Upload, Trash2, Plus, Image as ImageIcon, ShieldCheck } from 'lucide-react';

interface EditProductModalProps {
  isOpen: boolean;
  product: Product | null;
  existingCategories: string[];
  adminPassword?: string;
  onClose: () => void;
  onSaveSuccess: (updatedProduct: Product) => void;
}

type EditProductModalContentProps = Omit<EditProductModalProps, 'isOpen' | 'product'> & {
  product: Product;
};

interface ImageItem {
  id: string;
  urlOrBase64: string;
}

/**
 * The gate owns the conditional mount. The stateful child is therefore only
 * mounted when a product exists, so its Hook order can never change between
 * renders (fixes the previous Rules of Hooks violation).
 */
export const EditProductModal: React.FC<EditProductModalProps> = (props) => {
  if (!props.isOpen || !props.product) return null;
  return (
    <EditProductModalContent
      product={props.product}
      existingCategories={props.existingCategories}
      adminPassword={props.adminPassword}
      onClose={props.onClose}
      onSaveSuccess={props.onSaveSuccess}
    />
  );
};

const EditProductModalContent: React.FC<EditProductModalContentProps> = ({
  product,
  existingCategories,
  adminPassword,
  onClose,
  onSaveSuccess
}) => {
  const [produto, setProduto] = useState<string>(product.produto || '');
  const [selectedCategory, setSelectedCategory] = useState<string>(product.categoria || '');
  const [customCategory, setCustomCategory] = useState<string>('');
  const [isNewCategory, setIsNewCategory] = useState<boolean>(false);
  const [preco, setPreco] = useState<string>(product.preco ? String(product.preco) : '');
  const [link, setLink] = useState<string>(product.link || '');
  const [descricao, setDescricao] = useState<string>(product.descricao || '');
  const [paginaPonteUrl, setPaginaPonteUrl] = useState<string>(product.paginaPonteUrl || '');
  const [destaque, setDestaque] = useState<boolean>(Boolean(product.destaque));
  const [images, setImages] = useState<ImageItem[]>(() => {
    const list = Array.isArray(product.imagens) ? product.imagens : [];
    return list.map((url) => ({
      id: Math.random().toString(36).substring(2, 9),
      urlOrBase64: url
    }));
  });

  const [imageUrlInput, setImageUrlInput] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showSuccessToast, setShowSuccessToast] = useState<boolean>(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setProduto(product.produto || '');
    setSelectedCategory(product.categoria || '');
    setCustomCategory('');
    setIsNewCategory(false);
    setPreco(product.preco ? String(product.preco) : '');
    setLink(product.link || '');
    setDescricao(product.descricao || '');
    setPaginaPonteUrl(product.paginaPonteUrl || '');
    setDestaque(Boolean(product.destaque));

    const list = Array.isArray(product.imagens) ? product.imagens : [];
    setImages(
      list.map((url) => ({
        id: Math.random().toString(36).substring(2, 9),
        urlOrBase64: url
      }))
    );
    setValidationError(null);
    setSubmitError(null);
    setShowSuccessToast(false);
  }, [product]);

  const isFormDirty = (): boolean => {
    const initialCategory = product.categoria || '';
    const currentCategory = isNewCategory ? customCategory.trim() : selectedCategory.trim();
    const initialPrice = product.preco ? String(product.preco) : '';
    const initialImages = Array.isArray(product.imagens) ? product.imagens : [];
    const currentImages = images.map((i) => i.urlOrBase64);

    if (produto.trim() !== (product.produto || '').trim()) return true;
    if (currentCategory !== initialCategory) return true;
    if (preco.trim() !== initialPrice.trim()) return true;
    if (link.trim() !== (product.link || '').trim()) return true;
    if (descricao.trim() !== (product.descricao || '').trim()) return true;
    if (paginaPonteUrl.trim() !== (product.paginaPonteUrl || '').trim()) return true;
    if (destaque !== Boolean(product.destaque)) return true;
    if (JSON.stringify(currentImages) !== JSON.stringify(initialImages)) return true;

    return false;
  };

  const handleCloseAttempt = () => {
    if (isFormDirty()) {
      const confirmClose = window.confirm(
        'Atenção: Você possui alterações não salvas no produto. Deseja realmente fechar e descartar as alterações?'
      );
      if (!confirmClose) return;
    }
    onClose();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0) return;
    const filesArray = Array.from(e.target.files) as File[];

    const newItems: ImageItem[] = [];
    for (const file of filesArray) {
      if (!file.type.startsWith('image/')) continue;
      try {
        const base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.readAsDataURL(file);
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = (err) => reject(err);
        });
        newItems.push({
          id: Math.random().toString(36).substring(2, 9),
          urlOrBase64: base64
        });
      } catch (err) {
        console.error('Erro ao ler imagem:', err);
      }
    }

    setImages((prev) => [...prev, ...newItems]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleAddImageUrl = () => {
    const trimmed = imageUrlInput.trim();
    if (!trimmed) return;
    if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://') && !trimmed.startsWith('data:image')) {
      setValidationError('Insira uma URL de imagem válida (deve começar com http:// ou https://)');
      return;
    }
    setValidationError(null);
    setImages((prev) => [
      ...prev,
      {
        id: Math.random().toString(36).substring(2, 9),
        urlOrBase64: trimmed
      }
    ]);
    setImageUrlInput('');
  };

  const handleRemoveImage = (id: string) => {
    setImages((prev) => prev.filter((img) => img.id !== id));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError(null);
    setSubmitError(null);

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

    if (!link.trim() || (!link.startsWith('http://') && !link.startsWith('https://'))) {
      setValidationError('O Link do produto é obrigatório (deve começar com http:// ou https://).');
      return;
    }

    if (images.length === 0) {
      setValidationError('Mantenha pelo menos 1 imagem cadastrada para a peça.');
      return;
    }

    const activePassword = String(adminPassword || '').trim();
    if (!activePassword) {
      setSubmitError('Sessão administrativa sem credencial em memória. Faça login novamente.');
      return;
    }

    setIsSubmitting(true);

    try {
      const imagePayload = images.map((i) => i.urlOrBase64);
      const payload = {
        produto: produto.trim(),
        categoria: finalCategory,
        preco: priceNum,
        link: link.trim(),
        descricao: descricao.trim(),
        paginaPonteUrl: paginaPonteUrl.trim(),
        destaque,
        imagens: imagePayload
      };

      const res = await updateProduct(product.id, payload, activePassword);

      if (res.success) {
        setShowSuccessToast(true);
        const updatedObj: Product = res.product || {
          ...product,
          produto: payload.produto,
          categoria: payload.categoria,
          preco: payload.preco,
          link: payload.link,
          descricao: payload.descricao,
          paginaPonteUrl: payload.paginaPonteUrl,
          destaque: payload.destaque,
          imagens: payload.imagens
        };

        onSaveSuccess(updatedObj);
        setTimeout(() => onClose(), 600);
      } else {
        setSubmitError(res.error || 'Não foi possível salvar as alterações do produto.');
      }
    } catch (err: any) {
      console.error('Erro ao editar produto:', err);
      setSubmitError(err.message || 'Erro de conexão ao salvar produto.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-[#0B0908]/95 backdrop-blur-sm flex items-center justify-center p-3 sm:p-6 animate-fade-in font-sans">
      <div className="bg-[#181512] border border-[#3A342E] w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl rounded-none relative overflow-hidden">
        <div className="p-4 sm:p-5 bg-[#0B0908] border-b border-[#3A342E] flex items-center justify-between shrink-0">
          <div className="flex items-center space-x-2 min-w-0">
            <div className="w-8 h-8 bg-[#181512] border border-[#8A1F1F] text-[#8A1F1F] flex items-center justify-center shrink-0">
              <Pencil className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <span className="text-[9px] font-mono text-[#8A1F1F] uppercase tracking-widest block">
                EDITAR PRODUTO — ID: {product.id}
              </span>
              <h2 className="font-gothic text-xl sm:text-2xl text-[#E8E1D3] truncate">{product.produto}</h2>
            </div>
          </div>

          <button
            type="button"
            onClick={handleCloseAttempt}
            className="p-1.5 bg-[#181512] border border-[#3A342E] hover:border-[#8A1F1F] text-[#E8E1D3]/70 hover:text-[#E8E1D3] transition-colors rounded-none shrink-0"
            title="Fechar formulário de edição"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 sm:p-6 overflow-y-auto flex-1 space-y-5">
          {validationError && (
            <div className="bg-[#8A1F1F]/20 border border-[#8A1F1F] p-3 text-xs text-[#E8E1D3] flex items-center space-x-2">
              <AlertTriangle className="w-4 h-4 text-[#8A1F1F] shrink-0" />
              <span>{validationError}</span>
            </div>
          )}

          {submitError && (
            <div className="bg-[#8A1F1F]/30 border border-[#8A1F1F] p-3 text-xs text-[#E8E1D3] flex items-center space-x-2">
              <AlertTriangle className="w-4 h-4 text-[#8A1F1F] shrink-0" />
              <span>{submitError}</span>
            </div>
          )}

          {showSuccessToast && (
            <div className="bg-[#181512] border border-[#8A1F1F] p-3 text-xs text-[#E8E1D3] flex items-center space-x-2">
              <Check className="w-4 h-4 text-[#8A1F1F] shrink-0" />
              <span className="font-bold">Alterações salvas com sucesso! Atualizando catálogo...</span>
            </div>
          )}

          <form id="edit-product-form" onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-display uppercase tracking-widest text-[#E8E1D3] mb-1">
                Nome da Peça / Título <span className="text-[#8A1F1F]">*</span>
              </label>
              <input
                type="text"
                value={produto}
                onChange={(e) => setProduto(e.target.value)}
                placeholder="Ex: Jaqueta Archival Gothic Oversized"
                className="w-full bg-[#0B0908] border border-[#3A342E] focus:border-[#8A1F1F] text-[#E8E1D3] text-xs font-display rounded-none px-3.5 py-2.5 focus:outline-none transition-colors"
              />
            </div>

            <div>
              <label className="block text-xs font-display uppercase tracking-widest text-[#E8E1D3] mb-1">
                Categoria <span className="text-[#8A1F1F]">*</span>
              </label>
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
                  <option value="">-- Selecione a Categoria --</option>
                  {existingCategories.map((cat) => <option key={cat} value={cat}>{cat}</option>)}
                  <option value="__NEW__">+ Criar nova categoria...</option>
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
                    className="px-3 py-2.5 bg-[#0B0908] border border-[#3A342E] text-[#E8E1D3] text-xs font-display uppercase tracking-wider hover:border-[#8A1F1F] rounded-none"
                  >
                    Voltar
                  </button>
                </div>
              )}
            </div>

            <div>
              <label className="block text-xs font-display uppercase tracking-widest text-[#E8E1D3] mb-1">
                Preço Atual (R$) <span className="text-[#8A1F1F]">*</span>
              </label>
              <input
                type="number"
                step="0.01"
                inputMode="decimal"
                value={preco}
                onChange={(e) => setPreco(e.target.value)}
                placeholder="Ex: 599.00"
                className="w-full bg-[#0B0908] border border-[#3A342E] focus:border-[#8A1F1F] text-[#E8E1D3] text-xs font-mono rounded-none px-3.5 py-2.5 focus:outline-none transition-colors"
              />
            </div>

            <div>
              <label className="block text-xs font-display uppercase tracking-widest text-[#E8E1D3] mb-1">
                Link do Produto / URL de Afiliado <span className="text-[#8A1F1F]">*</span>
              </label>
              <input
                type="url"
                value={link}
                onChange={(e) => setLink(e.target.value)}
                placeholder="https://loja.com/produto-oficial..."
                className="w-full bg-[#0B0908] border border-[#3A342E] focus:border-[#8A1F1F] text-[#E8E1D3] text-xs font-mono rounded-none px-3.5 py-2.5 focus:outline-none transition-colors"
              />
            </div>

            <div>
              <label className="block text-xs font-display uppercase tracking-widest text-[#E8E1D3] mb-1">Descrição Curatorial / Especificações</label>
              <textarea
                value={descricao}
                onChange={(e) => setDescricao(e.target.value)}
                rows={3}
                placeholder="Descrição, tecido, caimento e detalhes do produto..."
                className="w-full bg-[#0B0908] border border-[#3A342E] focus:border-[#8A1F1F] text-[#E8E1D3] text-xs font-condensed rounded-none p-3 focus:outline-none transition-colors"
              />
            </div>

            <div>
              <label className="block text-xs font-display uppercase tracking-widest text-[#E8E1D3] mb-1">URL da Página Ponte / Presell (Opcional)</label>
              <input
                type="url"
                value={paginaPonteUrl}
                onChange={(e) => setPaginaPonteUrl(e.target.value)}
                placeholder="https://suapaginaponte.com/landing..."
                className="w-full bg-[#0B0908] border border-[#3A342E] focus:border-[#8A1F1F] text-[#E8E1D3] text-xs font-mono rounded-none px-3.5 py-2.5 focus:outline-none transition-colors"
              />
            </div>

            <div className="space-y-3 pt-2 border-t border-[#3A342E]">
              <label className="text-xs font-display uppercase tracking-widest text-[#E8E1D3] flex items-center space-x-1.5">
                <ImageIcon className="w-3.5 h-3.5 text-[#8A1F1F]" />
                <span>Galeria de Imagens ({images.length})</span>
              </label>

              {images.length > 0 && (
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-2.5">
                  {images.map((img, idx) => (
                    <div key={img.id} className="relative bg-[#0B0908] border border-[#3A342E] rounded-none p-1 group aspect-square flex items-center justify-center overflow-hidden">
                      <img src={img.urlOrBase64} alt={`Foto ${idx + 1}`} className="w-full h-full object-contain" />
                      <button
                        type="button"
                        onClick={() => handleRemoveImage(img.id)}
                        className="absolute top-1 right-1 p-1 bg-[#8A1F1F] text-[#E8E1D3] hover:bg-[#8A1F1F]/80 rounded-none transition-colors opacity-90 sm:opacity-0 group-hover:opacity-100"
                        title="Remover foto"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                      <span className="absolute bottom-1 left-1 px-1 bg-[#0B0908]/90 text-[8px] font-mono text-[#E8E1D3]/70">#{idx + 1}</span>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex flex-col sm:flex-row gap-2 pt-1">
                <input ref={fileInputRef} type="file" accept="image/*" multiple onChange={handleFileChange} className="hidden" />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="px-3.5 py-2 bg-[#0B0908] border border-[#3A342E] hover:border-[#8A1F1F] text-[#E8E1D3] text-xs font-display uppercase tracking-wider flex items-center justify-center space-x-1.5 rounded-none transition-colors shrink-0"
                >
                  <Upload className="w-3.5 h-3.5 text-[#8A1F1F]" />
                  <span>Upload de Arquivo</span>
                </button>

                <div className="flex-1 flex gap-1.5">
                  <input
                    type="url"
                    value={imageUrlInput}
                    onChange={(e) => setImageUrlInput(e.target.value)}
                    placeholder="Ou cole URL da imagem..."
                    className="flex-1 bg-[#0B0908] border border-[#3A342E] focus:border-[#8A1F1F] text-[#E8E1D3] text-xs font-mono rounded-none px-3 py-2 focus:outline-none transition-colors"
                  />
                  <button
                    type="button"
                    onClick={handleAddImageUrl}
                    className="px-3 py-2 bg-[#181512] border border-[#3A342E] hover:border-[#8A1F1F] text-[#E8E1D3] text-xs font-display uppercase tracking-wider flex items-center justify-center rounded-none transition-colors shrink-0"
                  >
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>

            <div className="pt-3 border-t border-[#3A342E] flex items-center justify-between">
              <div>
                <span className="text-xs font-display text-[#E8E1D3] uppercase tracking-wider block">Etiqueta Edição Limitada (Badge "LIMITED")</span>
                <span className="text-[11px] font-condensed text-[#E8E1D3]/60 block">Destaca a peça com o badge no catálogo.</span>
              </div>
              <button
                type="button"
                onClick={() => setDestaque(!destaque)}
                className={`w-11 h-6 transition-colors relative p-1 rounded-none border ${destaque ? 'bg-[#8A1F1F] border-[#8A1F1F]' : 'bg-[#0B0908] border-[#3A342E]'}`}
              >
                <span className={`w-4 h-4 bg-[#E8E1D3] block transition-transform ${destaque ? 'translate-x-5' : 'translate-x-0'}`} />
              </button>
            </div>
          </form>
        </div>

        <div className="p-4 bg-[#0B0908] border-t border-[#3A342E] flex items-center justify-between shrink-0 gap-3">
          <button
            type="button"
            onClick={handleCloseAttempt}
            disabled={isSubmitting}
            className="px-4 py-2.5 bg-[#181512] border border-[#3A342E] hover:border-[#8A1F1F] text-[#E8E1D3] text-xs font-display uppercase tracking-wider rounded-none transition-colors"
          >
            Cancelar
          </button>

          <button
            type="submit"
            form="edit-product-form"
            disabled={isSubmitting}
            id="save-product-changes-btn"
            className="px-6 py-2.5 bg-[#8A1F1F] hover:bg-[#8A1F1F]/80 disabled:opacity-50 text-[#E8E1D3] text-xs font-display uppercase tracking-widest flex items-center space-x-2 rounded-none transition-colors border border-[#8A1F1F]"
          >
            {isSubmitting ? (
              <><Loader2 className="w-4 h-4 animate-spin text-[#E8E1D3]" /><span>Salvando...</span></>
            ) : (
              <><ShieldCheck className="w-4 h-4 text-[#E8E1D3]" /><span>Salvar Alterações</span></>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
