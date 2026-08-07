import { Product } from '../types';

export const INITIAL_MOCK_PRODUCTS: Product[] = [
  {
    id: 'mock-1',
    produto: 'Jaqueta Bomber Oversized Couro Sintético Dark Metal',
    categoria: 'Vestuário',
    preco: 289.90,
    imagens: [
      'https://images.unsplash.com/photo-1551028719-00167b16eac5?auto=format&fit=crop&w=800&q=80',
      'https://images.unsplash.com/photo-1520975954732-35dd22299614?auto=format&fit=crop&w=800&q=80'
    ],
    link: 'https://shopee.com.br',
    ativo: true,
    destaque: true
  },
  {
    id: 'mock-2',
    produto: 'Bota Tratorada Solado Duplo Matte Black',
    categoria: 'Calçados',
    preco: 199.00,
    imagens: [
      'https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=800&q=80'
    ],
    link: 'https://shopee.com.br',
    ativo: true,
    destaque: true
  },
  {
    id: 'mock-3',
    produto: 'Corrente Chunky Aço Inoxidável Heavyweight Silver',
    categoria: 'Acessórios',
    preco: 79.90,
    imagens: [
      'https://images.unsplash.com/photo-1599643478518-a784e5dc4c8f?auto=format&fit=crop&w=800&q=80',
      'https://images.unsplash.com/photo-1611591475140-42099391152a?auto=format&fit=crop&w=800&q=80'
    ],
    link: 'https://shopee.com.br',
    ativo: true,
    destaque: false
  },
  {
    id: 'mock-4',
    produto: 'Camiseta Heavyweight 260g Acid Wash Cerberus Edition',
    categoria: 'Vestuário',
    preco: 129.90,
    imagens: [
      'https://images.unsplash.com/photo-1521572267360-ee0c2909d518?auto=format&fit=crop&w=800&q=80'
    ],
    link: 'https://shopee.com.br',
    ativo: true,
    destaque: false
  },
  {
    id: 'mock-5',
    produto: 'Óculos de Sol Retangular Full Black Frame Statement',
    categoria: 'Acessórios',
    preco: 69.90,
    imagens: [
      'https://images.unsplash.com/photo-1511499767150-a48a237f0083?auto=format&fit=crop&w=800&q=80'
    ],
    link: 'https://shopee.com.br',
    ativo: true,
    destaque: true
  }
];
