import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing Supabase credentials in environment variables.");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function checkProducts() {
  const { data, error, count } = await supabase
    .from('products')
    .select('*', { count: 'exact' });

  if (error) {
    console.error("Error fetching products:", error);
    return;
  }

  console.log(`Total products in Supabase: ${count}`);
  console.log("Products list:");
  data.forEach(p => {
    console.log(`- [${p.id}] REF: ${p.reference || p.ref} | Title: ${p.title} | Price: ${p.price}`);
  });
}

checkProducts();
