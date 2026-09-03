# Baseline fragments

These SQL files represent schema changes that exist in the LIVE database but do not have their own version in `supabase_migrations.schema_migrations`.

They are intentionally kept outside `supabase/migrations` so a future `supabase db push` cannot mistake reconstructed historical fragments for pending production migrations. The local rebuild gate applies them after the pre-history core baseline and before replaying the exact remote migration history.
