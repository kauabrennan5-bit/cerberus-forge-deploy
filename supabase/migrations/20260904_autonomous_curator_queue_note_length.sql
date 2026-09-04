begin;

alter table public.products
  drop constraint if exists products_curator_note_length_check,
  add constraint products_curator_note_length_check
    check (
      curator_note is null
      or (
        created_by = 'autonomous_curator_queue'
        and curator_note like 'AUTONOMOUS_CURATOR_QUEUE_V1:%'
        and char_length(curator_note) between 1 and 2000
      )
      or (
        (created_by is distinct from 'autonomous_curator_queue'
          or curator_note not like 'AUTONOMOUS_CURATOR_QUEUE_V1:%')
        and char_length(curator_note) between 1 and 500
      )
    );

comment on constraint products_curator_note_length_check on public.products is
  'Notas editoriais permanecem limitadas a 500 caracteres; metadata interna AUTONOMOUS_CURATOR_QUEUE_V1 do Curator pode usar ate 2000 caracteres.';

commit;
