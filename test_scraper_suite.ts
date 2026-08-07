import { fetchProductDataFromUrl } from "./server/services/scraper";

interface TestProductCase {
  id: string;
  source: "Shopee" | "Mercado Livre";
  url: string;
  rawText?: string;
  expectedMinImages: number;
}

async function runScraperTestSuite() {
  console.log("==========================================================================");
  console.log("=== BATERIA DE TESTES DE EXTRAÇÃO CONFIAVEL (SHOPEE & MERCADO LIVRE) ===");
  console.log("==========================================================================\n");

  const testCases: TestProductCase[] = [
    {
      id: "SHOPEE-01",
      source: "Shopee",
      url: "https://shopee.com.br/Camiseta-Oversized-Streetwear-100-Algod%C3%A3o-Pima-100-Original-i.404286121.23390382910",
      rawText: `
        [Shopee Anúncio Oficial]
        Camiseta Oversized Streetwear 100% Algodão Pima
        De R$ 149,90 por R$ 89,90
        Ou 6x de R$ 14,98 sem juros
        
        <script type="application/ld+json">
        {
          "@context": "https://schema.org/",
          "@type": "Product",
          "name": "Camiseta Oversized Streetwear 100% Algodão Pima",
          "image": [
            "https://down-br.img.susercontent.com/file/br-11134207-7r98o-m1abc1234567",
            "https://down-br.img.susercontent.com/file/br-11134207-7r98o-m1def8901234",
            "https://down-br.img.susercontent.com/file/br-11134207-7r98o-m1ghi5678901"
          ],
          "offers": {
            "@type": "Offer",
            "price": "89.90",
            "priceCurrency": "BRL"
          }
        }
        </script>
      `,
      expectedMinImages: 3
    },
    {
      id: "SHOPEE-02",
      source: "Shopee",
      url: "https://shopee.com.br/Jaqueta-Jeans-Vintage-Streetwear-Heavy-Canvas-i.512345678.9876543210",
      rawText: `
        <meta property="og:title" content="Jaqueta Jeans Vintage Streetwear Heavy Canvas" />
        <meta property="og:price:amount" content="189.00" />
        <meta property="og:image" content="https://down-br.img.susercontent.com/file/sg-11134201-7rd5z-lxy123456789" />
        <meta property="og:image:secure_url" content="https://down-br.img.susercontent.com/file/sg-11134201-7rd5z-lxy987654321" />
        Preço promocional: R$ 189,00 (Preço anterior R$ 250,00)
      `,
      expectedMinImages: 2
    },
    {
      id: "ML-01",
      source: "Mercado Livre",
      url: "https://produto.mercadolivre.com.br/MLB-3564024329-tenis-oversized-casual-streetwear-preto-e-branco-_JM",
      rawText: `
        [Mercado Livre Anúncio]
        Tênis Oversized Casual Streetwear Preto e Branco
        De R$ 399,00 por R$ 249,90 em até 10x de R$ 24,99
        
        <script type="application/ld+json">
        {
          "@type": "Product",
          "name": "Tênis Oversized Casual Streetwear Preto e Branco",
          "image": [
            "https://http2.mlstatic.com/D_NQ_NP_2X_912345-MLB12345678-O.webp",
            "https://http2.mlstatic.com/D_NQ_NP_2X_912346-MLB12345679-O.webp",
            "https://http2.mlstatic.com/D_NQ_NP_2X_912347-MLB12345680-O.webp"
          ],
          "offers": {
            "@type": "Offer",
            "price": "249.90",
            "priceCurrency": "BRL"
          }
        }
        </script>
      `,
      expectedMinImages: 3
    },
    {
      id: "ML-02",
      source: "Mercado Livre",
      url: "https://www.mercadolivre.com.br/tenis-casual-masculino-urbano-streetwear-preto/p/MLB28509431",
      rawText: `
        <meta property="og:title" content="Tênis Casual Masculino Urbano Streetwear Preto" />
        <meta property="product:price:amount" content="179.90" />
        <meta property="og:image" content="https://http2.mlstatic.com/D_NQ_NP_654321-MLB87654321-O.webp" />
        <meta property="og:image" content="https://http2.mlstatic.com/D_NQ_NP_654322-MLB87654322-O.webp" />
        <s>De R$ 229,00</s> por R$ 179,90 em 12x de R$ 17,99
      `,
      expectedMinImages: 2
    },
    {
      id: "SHOPEE-03",
      source: "Shopee",
      url: "https://shopee.com.br/Bolsa-Baggie-Canvas-Streetwear-Minimal-i.999888777.1122334455",
      rawText: `
        Bolsa Baggie Canvas Streetwear Minimal
        R$ 119.50
        https://down-br.img.susercontent.com/file/br-11134207-7r98o-bag01
        https://down-br.img.susercontent.com/file/br-11134207-7r98o-bag02
      `,
      expectedMinImages: 2
    },
    {
      id: "ML-03",
      source: "Mercado Livre",
      url: "https://produto.mercadolivre.com.br/MLB-99887766-calca-cargo-streetwear-paratrooper-_JM",
      rawText: `
        Calça Cargo Streetwear Paratrooper
        De R$ 299,00 Por R$ 199,00 (12x de R$ 19,90)
        https://http2.mlstatic.com/D_NQ_NP_111111-MLB111111-O.webp
        https://http2.mlstatic.com/D_NQ_NP_222222-MLB222222-O.webp
      `,
      expectedMinImages: 2
    }
  ];

  let passed = 0;
  const total = testCases.length;

  for (const tc of testCases) {
    console.log(`--- [TESTE ${tc.id}] Fonte: ${tc.source} ---`);
    console.log(`URL: ${tc.url}`);

    const result = await fetchProductDataFromUrl(tc.url, tc.rawText);

    const hasTitle = Boolean(result.title && result.title.length > 3);
    const hasPrice = Boolean(result.price !== null && result.price > 0);
    const hasImages = Boolean(result.images && result.images.length >= tc.expectedMinImages);
    const noStrikethroughOrInstallments = result.price !== 399 && result.price !== 149.9 && result.price !== 299 && result.price !== 229 && result.price !== 250 && (result.price === null || result.price < 300);

    const isSuccess = hasTitle && hasPrice && hasImages && noStrikethroughOrInstallments;

    if (isSuccess) {
      passed++;
      console.log(`✅ [SUCESSO]: Título="${result.title}" | Preço=R$ ${result.price?.toFixed(2)} | Imagens=${result.images.length}`);
      console.log(`   Sample Images:`, result.images.slice(0, 3));
    } else {
      console.log(`❌ [FALHA]: Título="${result.title}" | Preço=${result.price} | Imagens=${result.images.length}`);
    }
    console.log("");
  }

  const successRate = ((passed / total) * 100).toFixed(1);
  console.log("==========================================================================");
  console.log(`=== RESULTADO FINAL DOS TESTES: ${passed}/${total} PASSARAM (${successRate}% TAXA DE SUCESSO) ===`);
  console.log("==========================================================================");
}

runScraperTestSuite();
