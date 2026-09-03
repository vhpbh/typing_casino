-- Typing Casino for Word — ads, usage stats, and admin access.
-- Safe to re-run (idempotent). Run this in your Supabase project's SQL editor.
-- Requires: Authentication -> Providers -> "Anonymous Sign-Ins" enabled.

-- ============================================================
-- 1. Tables
-- ============================================================

create table if not exists public.typing_stats (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  letters_typed bigint not null default 0,
  words_typed bigint not null default 0,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now()
);

-- Running an older install that already has this table? uncomment/run once:
-- alter table public.typing_stats add column if not exists display_name text;

create table if not exists public.ads (
  id uuid primary key default gen_random_uuid(),
  image_url text not null,
  target_url text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.ad_clicks (
  id bigint generated always as identity primary key,
  ad_id uuid not null references public.ads(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- Admins allowed to use the admin dashboard. Add rows manually:
--   insert into public.admins (user_id) values ('<your-supabase-auth-user-uuid>');
create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);

-- ============================================================
-- 2. Row Level Security — lock everything down by default
-- ============================================================

alter table public.typing_stats enable row level security;
alter table public.ads enable row level security;
alter table public.ad_clicks enable row level security;
alter table public.admins enable row level security;

drop policy if exists "typing_stats no direct access" on public.typing_stats;
create policy "typing_stats no direct access" on public.typing_stats
  for all using (false) with check (false);

drop policy if exists "ads readable if active" on public.ads;
create policy "ads readable if active" on public.ads
  for select using (active = true);

drop policy if exists "ads no direct write" on public.ads;
create policy "ads no direct write" on public.ads
  for insert with check (false);
drop policy if exists "ads no direct update" on public.ads;
create policy "ads no direct update" on public.ads
  for update using (false);
drop policy if exists "ads no direct delete" on public.ads;
create policy "ads no direct delete" on public.ads
  for delete using (false);

drop policy if exists "ad_clicks no direct access" on public.ad_clicks;
create policy "ad_clicks no direct access" on public.ad_clicks
  for all using (false) with check (false);

drop policy if exists "admins self read" on public.admins;
create policy "admins self read" on public.admins
  for select using (auth.uid() = user_id);

-- ============================================================
-- 3. Helper: is the caller an admin?
-- ============================================================

create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (select 1 from public.admins a where a.user_id = auth.uid());
$$;

-- ============================================================
-- 4. Functions used by the WORD ADD-IN (any signed-in anon user)
-- ============================================================

create or replace function public.log_typing_progress(p_letters bigint, p_words bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  insert into public.typing_stats (user_id, letters_typed, words_typed, last_seen)
  values (auth.uid(), greatest(p_letters, 0), greatest(p_words, 0), now())
  on conflict (user_id) do update
    set letters_typed = greatest(excluded.letters_typed, public.typing_stats.letters_typed),
        words_typed   = greatest(excluded.words_typed, public.typing_stats.words_typed),
        last_seen     = now();
end;
$$;

create or replace function public.get_my_stats()
returns table (
  display_name text,
  letters_typed bigint,
  words_typed bigint
)
language sql
security definer
set search_path = public
as $$
  select ts.display_name, ts.letters_typed, ts.words_typed
  from public.typing_stats ts
  where ts.user_id = auth.uid();
$$;

create or replace function public.set_display_name(p_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  clean_name text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  clean_name := nullif(trim(p_name), '');
  if clean_name is not null and length(clean_name) > 24 then
    clean_name := substring(clean_name from 1 for 24);
  end if;

  insert into public.typing_stats (user_id, display_name)
  values (auth.uid(), clean_name)
  on conflict (user_id) do update
    set display_name = excluded.display_name;
end;
$$;

create or replace function public.register_ad_click(p_ad_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.ad_clicks (ad_id, user_id)
  values (p_ad_id, auth.uid());
end;
$$;

-- ============================================================
-- 5. Functions used by the ADMIN DASHBOARD (admins only)
-- ============================================================

create or replace function public.admin_list_users()
returns table (
  user_id uuid,
  display_name text,
  letters_typed bigint,
  words_typed bigint,
  first_seen timestamptz,
  last_seen timestamptz
)
language sql
security definer
set search_path = public
as $$
  select ts.user_id, ts.display_name, ts.letters_typed, ts.words_typed, ts.first_seen, ts.last_seen
  from public.typing_stats ts
  where public.is_admin()
  order by ts.last_seen desc;
$$;

create or replace function public.admin_user_count()
returns bigint
language sql
security definer
set search_path = public
as $$
  select case when public.is_admin() then count(*) else 0 end from public.typing_stats;
$$;

create or replace function public.admin_list_ads()
returns table (
  id uuid,
  image_url text,
  target_url text,
  active boolean,
  created_at timestamptz,
  clicks bigint
)
language sql
security definer
set search_path = public
as $$
  select a.id, a.image_url, a.target_url, a.active, a.created_at,
         (select count(*) from public.ad_clicks c where c.ad_id = a.id) as clicks
  from public.ads a
  where public.is_admin()
  order by a.created_at desc;
$$;

create or replace function public.admin_create_ad(p_image_url text, p_target_url text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_id uuid;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  insert into public.ads (image_url, target_url, active)
  values (p_image_url, p_target_url, true)
  returning id into new_id;
  return new_id;
end;
$$;

create or replace function public.admin_set_ad_active(p_ad_id uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  update public.ads set active = p_active where id = p_ad_id;
end;
$$;

create or replace function public.admin_delete_ad(p_ad_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  delete from public.ads where id = p_ad_id;
end;
$$;
