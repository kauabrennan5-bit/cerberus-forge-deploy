-- Oferta promocional confirmada pelo administrador, separada do preço-base.
--
-- Migration aditiva e retrocompatível:
--   * produtos existentes permanecem válidos com NULL;
--   * public.products continua a ser a fonte canônica;
--   * a oferta não substitui preco e não autoriza checkout, cupom ou desconto;
--   * apenas a confirmação explícita do administrador pode produzir o formato.

begin;

alter table public.products
  add column if not exists oferta_promocional jsonb;

alter table public.products
  drop constraint if exists products_oferta_promocional_shape_check;

alter table public.products
  add constraint products_oferta_promocional_shape_check
  check (
    oferta_promocional is null
    or (
      jsonb_typeof(oferta_promocional) = 'object'
      and jsonb_typeof(oferta_promocional -> 'price') = 'number'
      and (oferta_promocional ->> 'price')::numeric > 0
      and oferta_promocional ->> 'condition' in ('pix', 'pix_with_coupon', 'coupon', 'other')
      and oferta_promocional ->> 'source' = 'admin_confirmed'
      and jsonb_typeof(oferta_promocional -> 'confirmedAt') = 'number'
      and (oferta_promocional ->> 'confirmedAt')::numeric > 0
      and jsonb_typeof(oferta_promocional -> 'benefits') = 'array'
    )
  );

comment on column public.products.oferta_promocional is
  'Oferta observada e confirmada pelo administrador; preserva preço-base, condição, benefícios, proveniência e instante de confirmação. Não representa preço final de checkout.';

commit;
