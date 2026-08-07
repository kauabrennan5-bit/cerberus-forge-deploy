import { Product } from '../types';
import { fetchProxyCsv } from '../services/api';

/**
 * Robust CSV parser handling quoted values with commas or newlines.
 */
export function parseCSVString(csvText: string): string[][] {
  const lines: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i++) {
    const char = csvText[i];
    const nextChar = csvText[i + 1];

    if (inQuotes) {
      if (char === '"') {
        if (nextChar === '"') {
          // Escaped quote inside quoted field
          currentField += '"';
          i++;
        } else {
          // Closing quote
          inQuotes = false;
        }
      } else {
        currentField += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        currentRow.push(currentField.trim());
        currentField = '';
      } else if (char === '\n' || (char === '\r' && nextChar === '\n')) {
        currentRow.push(currentField.trim());
        if (currentRow.some(field => field.length > 0)) {
          lines.push(currentRow);
        }
        currentRow = [];
        currentField = '';
        if (char === '\r') i++;
      } else if (char !== '\r') {
        currentField += char;
      }
    }
  }

  if (currentField || currentRow.length > 0) {
    currentRow.push(currentField.trim());
    if (currentRow.some(field => field.length > 0)) {
      lines.push(currentRow);
    }
  }

  return lines;
}

/**
 * Clean price string into numeric format (BRL floating number)
 */
export function parsePriceNumber(raw: any): number {
  if (typeof raw === 'number') return raw;
  if (!raw) return 0;
  const str = String(raw).replace(/[^\d.,]/g, '').trim();
  if (!str) return 0;
  
  // Handle Brazilian currency format (1.299,90 or 89,90)
  if (str.includes(',')) {
    const sanitized = str.replace(/\./g, '').replace(',', '.');
    return parseFloat(sanitized) || 0;
  }
  return parseFloat(str) || 0;
}

/**
 * Parses raw CSV lines into Product objects based on mandatory column index layout:
 * [produto, categoria, preco, imagens, link, ativo, destaque]
 */
export function convertRowsToProducts(rows: string[][]): Product[] {
  if (rows.length === 0) return [];

  // Identify column indices from header row if possible, or fallback to fixed indices 0..6
  const header = rows[0].map(h => h.toLowerCase().trim());
  
  let pIdx = header.indexOf('produto');
  let cIdx = header.indexOf('categoria');
  let prIdx = header.indexOf('preco');
  if (prIdx === -1) prIdx = header.indexOf('preço');
  let imgIdx = header.indexOf('imagens');
  if (imgIdx === -1) imgIdx = header.indexOf('imagem');
  let lIdx = header.indexOf('link');
  let aIdx = header.indexOf('ativo');
  let dIdx = header.indexOf('destaque');

  // Fallbacks if header line is missing or custom
  if (pIdx === -1) pIdx = 0;
  if (cIdx === -1) cIdx = 1;
  if (prIdx === -1) prIdx = 2;
  if (imgIdx === -1) imgIdx = 3;
  if (lIdx === -1) lIdx = 4;
  if (aIdx === -1) aIdx = 5;
  if (dIdx === -1) dIdx = 6;

  const dataRows = (pIdx === 0 && rows[0][0]?.toLowerCase() === 'produto') ? rows.slice(1) : rows;

  const products: Product[] = [];

  dataRows.forEach((row, index) => {
    const rawProduto = row[pIdx] || '';
    if (!rawProduto.trim()) return; // skip empty lines

    const rawCategoria = row[cIdx] || 'Geral';
    const rawPreco = row[prIdx] || '0';
    const rawImagens = row[imgIdx] || '';
    const rawLink = row[lIdx] || '#';
    const rawAtivo = (row[aIdx] || 'sim').toLowerCase().trim();
    const rawDestaque = (row[dIdx] || 'nao').toLowerCase().trim();

    // Parse image list split by " | "
    const imageList = rawImagens
      .split('|')
      .map(url => url.trim())
      .filter(url => url.length > 0);

    const isAtivo = rawAtivo === 'sim' || rawAtivo === 'true' || rawAtivo === '1';
    const isDestaque = rawDestaque === 'sim' || rawDestaque === 'true' || rawDestaque === '1';

    products.push({
      id: `prod-${index}-${Date.now()}`,
      produto: rawProduto,
      categoria: rawCategoria.trim() || 'Geral',
      preco: parsePriceNumber(rawPreco),
      imagens: imageList.length > 0 ? imageList : [],
      link: rawLink.startsWith('http') ? rawLink : `https://${rawLink}`,
      ativo: isAtivo,
      destaque: isDestaque,
      rawRowIndex: index + 2
    });
  });

  // Filter only active items as requested, and reverse so newest item appears FIRST
  return products
    .filter(p => p.ativo)
    .reverse();
}

/**
 * Helper to fetch CSV from URL or backend proxy
 */
export async function fetchProductsFromCSV(csvUrl: string): Promise<Product[]> {
  if (!csvUrl) return [];

  try {
    // Try direct fetch first
    let response = await fetch(csvUrl, { cache: 'no-cache' });
    
    // If blocked or CORS issue, fall back to server proxy
    if (!response.ok) {
      const csvText = await fetchProxyCsv(csvUrl);
      const rows = parseCSVString(csvText);
      return convertRowsToProducts(rows);
    }

    const csvText = await response.text();
    const rows = parseCSVString(csvText);
    return convertRowsToProducts(rows);
  } catch (err: any) {
    // Attempt fallback to proxy if direct failed
    try {
      const text = await fetchProxyCsv(csvUrl);
      const rows = parseCSVString(text);
      return convertRowsToProducts(rows);
    } catch {
      // ignore secondary error
    }
    throw err;
  }
}
