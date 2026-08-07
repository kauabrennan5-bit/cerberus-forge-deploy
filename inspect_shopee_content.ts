import fetch from 'node-fetch';

async function inspectShopeeContent() {
  const url = "https://shopee.com.br/Camiseta-Oversized-Streetwear-100-Algod%C3%A3o-Pima-100-Original-i.404286121.23390382910";
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "pt-BR,pt;q=0.9"
    }
  });

  const html = await res.text();
  console.log("HTML slice 0-1000:\n", html.slice(0, 1000));
  
  // Find script tags
  const scripts = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
  console.log("Total script tags:", scripts.length);
  scripts.forEach((s, idx) => {
    if (s.length > 500) {
      console.log(`Script #${idx} length: ${s.length}, snippet:`, s.slice(0, 250));
    }
  });
}

inspectShopeeContent();
