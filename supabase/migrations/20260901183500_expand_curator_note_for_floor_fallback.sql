-- The guaranteed best-of-lot floor stores source identity + ranking warnings in
-- curator_note for audit/recovery. Keep the field bounded, but allow enough
-- room for the same structured queue metadata already used by the curator.
ALTER TABLE public.products
  DROP CONSTRAINT IF EXISTS products_curator_note_length_check;

ALTER TABLE public.products
  ADD CONSTRAINT products_curator_note_length_check
  CHECK (
    curator_note IS NULL
    OR (char_length(curator_note) >= 1 AND char_length(curator_note) <= 2000)
  );
