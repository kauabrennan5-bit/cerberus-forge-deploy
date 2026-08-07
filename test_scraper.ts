import { fetchProductDataFromUrl } from './server/services/scraper';

async function testScraper() {
  const mlUrls = [
    "https://www.mercadolivre.com.br/tenis-casual-masculino-urbano-streetwear-preto/p/MLB28509431",
    "https://produto.mercadolivre.com.br/MLB-3564024329-tenis-oversized-casual-streetwear-preto-e-branco-_JM"
  ];

  const shopeeUrls = [
    "https://shopee.com.br/Jaqueta-Jeans-Oversized-Unissex-Streetwear-Vintage-i.345678901.1234567890",
    "https://shopee.com.br/product/12345678/87654321"
  ];

  console.log("=== TESTANDO MERCADO LIVRE ===");
  for (const u of mlUrls) {
    console.log("\nURL:", u);
    const data = await fetchProductDataFromUrl(u);
    console.log("Resultado:", {
      title: data.title,
      price: data.price,
      imagesCount: data.images.length,
      images: data.images.slice(0, 3)
    });
  }

  console.log("\n=== TESTANDO SHOPEE ===");
  for (const u of shopeeUrls) {
    console.log("\nURL:", u);
    const data = await fetchProductDataFromUrl(u);
    console.log("Resultado:", {
      title: data.title,
      price: data.price,
      imagesCount: data.images.length,
      images: data.images.slice(0, 3)
    });
  }
}

testScraper();
