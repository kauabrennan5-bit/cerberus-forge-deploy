import fetch from 'node-fetch';

async function inspectShopee() {
  const url = "https://shopee.com.br/Camiseta-Oversized-Streetwear-100-Algod%C3%A3o-Pima-100-Original-i.404286121.23390382910";
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "pt-BR,pt;q=0.9"
    }
  });

  const html = await res.text();
  console.log("Shopee HTML status:", res.status, "Length:", html.length);

  // Check JSON-LD
  const jsonLd = html.match(/<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  console.log("JSON-LD blocks:", jsonLd?.length);
  jsonLd?.forEach((j, idx) => console.log(`JSON-LD ${idx}:`, j.replace(/<[^>]+>/g, "")));

  // Check meta tags
  const metas = html.match(/<meta\s+[^>]+>/gi) || [];
  metas.filter(m => /og:|twitter:|product:|price/i.test(m)).forEach(m => console.log("Shopee Meta:", m));

  // Check title
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  console.log("Title tag:", titleMatch?.[1]);

  // Check images
  const images = [...html.matchAll(/https:\/\/(?:down-br\.img\.susercontent\.com|sg-11134201-[^"'\s\)\\]+|cf\.shopee\.com\.br)\/file\/[a-zA-Z0-9_\-]+/gi)].map(m => m[0]);
  console.log("Shopee CDN Images count:", new Set(images).size);
  console.log("Sample Shopee CDN Images:", [...new Set(images)].slice(0, 10));

  // Check price patterns in script or text
  const priceMatches = html.matchAll(/"price":\s*(\d+)/gi);
  console.log("Price script matches:", [...priceMatches].map(m => m[1]).slice(0, 5));

  const brlMatches = html.matchAll(/R\$\s*([0-9]+[\.,][0-9]{2})/gi);
  console.log("BRL Matches in HTML:", [...brlMatches].map(m => m[1]).slice(0, 5));
}

inspectShopee();
