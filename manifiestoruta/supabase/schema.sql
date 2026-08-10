create table if not exists public.ocr_scans (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  manifest_number text not null,
  page_count integer not null,
  mode text not null check (mode in ('fast', 'maximum')),
  result jsonb not null
);

alter table public.ocr_scans enable row level security;

-- La aplicación escribe únicamente con la clave secreta desde el servidor.
-- No se concede acceso directo a navegadores ni usuarios autenticados.
revoke all on table public.ocr_scans from anon, authenticated;

create index if not exists ocr_scans_manifest_created_idx
  on public.ocr_scans (manifest_number, created_at desc);
