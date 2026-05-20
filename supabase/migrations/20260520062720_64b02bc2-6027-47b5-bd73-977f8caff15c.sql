
create table public.test_flows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  url text not null default '',
  description text not null default '',
  steps jsonb not null default '[]'::jsonb,
  api_mappings jsonb not null default '[]'::jsonb,
  last_run_status text,
  last_run_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.test_runs (
  id uuid primary key default gen_random_uuid(),
  test_flow_id uuid not null references public.test_flows(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'running',
  duration_ms integer,
  logs jsonb not null default '[]'::jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table public.test_flows enable row level security;
alter table public.test_runs enable row level security;

create policy "users select own flows" on public.test_flows for select using (auth.uid() = user_id);
create policy "users insert own flows" on public.test_flows for insert with check (auth.uid() = user_id);
create policy "users update own flows" on public.test_flows for update using (auth.uid() = user_id);
create policy "users delete own flows" on public.test_flows for delete using (auth.uid() = user_id);

create policy "users select own runs" on public.test_runs for select using (auth.uid() = user_id);
create policy "users insert own runs" on public.test_runs for insert with check (auth.uid() = user_id);
create policy "users update own runs" on public.test_runs for update using (auth.uid() = user_id);
create policy "users delete own runs" on public.test_runs for delete using (auth.uid() = user_id);

create index test_flows_user_idx on public.test_flows(user_id, updated_at desc);
create index test_runs_flow_idx on public.test_runs(test_flow_id, started_at desc);

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

create trigger test_flows_touch before update on public.test_flows
for each row execute function public.touch_updated_at();
