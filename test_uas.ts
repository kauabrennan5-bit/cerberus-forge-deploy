import fetch from 'node-fetch';

const uas = [
  { name: 'Googlebot', ua: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
  { name: 'Bingbot', ua: 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)' },
  { name: 'Twitterbot', ua: 'Twitterbot/1.0' },
  { name: 'Facebookbot', ua: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)' },
  { name: 'WhatsApp', ua: 'WhatsApp/2.21.12.21 i' },
  { name: 'Slackbot', ua: 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)' },
  { name: 'TelegramBot', ua: 'TelegramBot (like TwitterBot)' },
  { name: 'LinkedInBot', ua: 'LinkedInBot/1.0 (compatible; Mozilla/5.0; Jakarta Commons-HttpClient/3.1)' },
  { name: 'Curl', ua: 'curl/8.5.0' },
  { name: 'Safari Mac', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15' }
];

async function testUAs() {
  const mlUrl = "https://produto.mercadolivre.com.br/MLB-3564024329-tenis-oversized-casual-streetwear-preto-e-branco-_JM";
  const shopeeUrl = "https://shopee.com.br/Camiseta-Oversized-Streetwear-100-Algod%C3%A3o-Pima-100-Original-i.404286121.23390382910";

  console.log("=== MERCADO LIVRE UA TEST ===");
  for (const { name, ua } of uas) {
    try {
      const res = await fetch(mlUrl, {
        headers: {
          "User-Agent": ua,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7"
        },
        redirect: "follow"
      });
      const html = await res.text();
      const hasVerification = res.url.includes("account-verification") || html.includes("account-verification");
      const hasJsonLd = html.includes("application/ld+json");
      const hasPriceMeta = html.includes("og:price:amount") || html.includes("product:price:amount") || html.includes("R$");
      console.log(`[${name}] Status: ${res.status} | FinalUrl: ${res.url.slice(0, 50)} | Verification: ${hasVerification} | JSON-LD: ${hasJsonLd} | HasPriceText: ${hasPriceMeta} | Length: ${html.length}`);
    } catch (e: any) {
      console.log(`[${name}] Error: ${e.message}`);
    }
  }

  console.log("\n=== SHOPEE UA TEST ===");
  for (const { name, ua } of uas) {
    try {
      const res = await fetch(shopeeUrl, {
        headers: {
          "User-Agent": ua,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7"
        },
        redirect: "follow"
      });
      const html = await res.text();
      const hasOgImage = html.includes("og:image");
      const hasPrice = html.includes("R$") || html.includes("price");
      console.log(`[${name}] Status: ${res.status} | FinalUrl: ${res.url.slice(0, 50)} | OG:Image: ${hasOgImage} | HasPrice: ${hasPrice} | Length: ${html.length}`);
    } catch (e: any) {
      console.log(`[${name}] Error: ${e.message}`);
    }
  }
}

testUAs();
