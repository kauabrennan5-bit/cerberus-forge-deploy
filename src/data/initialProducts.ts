import { Product } from '../types';

export const INITIAL_PRODUCTS: Product[] = [
  {
    id: 'prod-001',
    produto: 'Blazer Oversized em Alfaiataria Italiana',
    categoria: 'Vestuário',
    preco: 389.00,
    imagens: [
      'https://images.unsplash.com/photo-1591047139829-d91aecb6caea?auto=format&fit=crop&w=800&q=80',
      'https://images.unsplash.com/photo-1548883354-7622d03aca27?auto=format&fit=crop&w=800&q=80'
    ],
    link: 'https://shopee.com.br',
    ativo: true,
    destaque: true,
    slug: 'blazer-oversized-alfaiataria-italiana',
    descricao: 'Blazer em alfaiataria premium com caimento estruturado oversized, lapela clássica e acabamento acetinado interno.'
  },
  {
    id: 'prod-002',
    produto: 'Bolsa Estruturada em Couro Nappa Texturizado',
    categoria: 'Acessórios',
    preco: 450.00,
    imagens: [
      'https://images.unsplash.com/photo-1584917865442-de89df76afd3?auto=format&fit=crop&w=800&q=80',
      'https://images.unsplash.com/photo-1590874103328-eac38a683ce7?auto=format&fit=crop&w=800&q=80'
    ],
    link: 'https://shopee.com.br',
    ativo: true,
    destaque: true,
    slug: 'bolsa-estruturada-couro-nappa',
    descricao: 'Bolsa em couro bovino legítimo com fecho banhado a latão fosco e alça removível minimalista.'
  },
  {
    id: 'prod-003',
    produto: 'Óculos de Sol Minimalista Acetato Negro',
    categoria: 'Acessórios',
    preco: 189.90,
    imagens: [
      'https://images.unsplash.com/photo-1511499767150-a48a237f0083?auto=format&fit=crop&w=800&q=80'
    ],
    link: 'https://shopee.com.br',
    ativo: true,
    destaque: false,
    slug: 'oculos-de-sol-acetato-negro',
    descricao: 'Armação unissex em acetato italiano negro fosco com lentes escurecidas UV400 de alta definição.'
  },
  {
    id: 'prod-004',
    produto: 'Sobretudo Minimalista em Lã Batida',
    categoria: 'Vestuário',
    preco: 620.00,
    imagens: [
      'https://images.unsplash.com/photo-1539533018447-63fcce2678e3?auto=format&fit=crop&w=800&q=80'
    ],
    link: 'https://shopee.com.br',
    ativo: true,
    destaque: true,
    slug: 'sobretudo-minimalista-la-batida',
    descricao: 'Sobretudo longo com corte reto e botoamento duplo em tom carvão profundo. Aquecimento térmico de excelência.'
  },
  {
    id: 'prod-005',
    produto: 'Vela Aromática Escultural Cera Vegetal',
    categoria: 'Casa & Estilo',
    preco: 129.00,
    imagens: [
      'https://images.unsplash.com/photo-1603006905003-be475563bc59?auto=format&fit=crop&w=800&q=80'
    ],
    link: 'https://shopee.com.br',
    ativo: true,
    destaque: false,
    slug: 'vela-aromatica-escultural-cera-vegetal',
    descricao: 'Vela artesanal derramada à mão com fragrância de cedro, vetiver e bergamota em recipiente cerâmico fosco.'
  },
  {
    id: 'prod-006',
    produto: 'Mule Salto Bloco em Couro Camurça',
    categoria: 'Calçados',
    preco: 299.00,
    imagens: [
      'https://images.unsplash.com/photo-1543163521-1bf539c55dd2?auto=format&fit=crop&w=800&q=80'
    ],
    link: 'https://shopee.com.br',
    ativo: true,
    destaque: false,
    slug: 'mule-salto-bloco-couro-camurca',
    descricao: 'Mule artesanal com acabamento aveludado, palmilha acolchoada e salto bloco esculpido.'
  }
];

export function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '');
}
