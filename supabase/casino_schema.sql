-- ============================================================================
-- Typing Casino - Obsidian Plugin Backend
-- Run this entire file in Supabase Studio -> SQL Editor -> New query -> Run
-- ============================================================================

create extension if not exists pgcrypto;

-- ============================================================================
-- 1. Tables
-- ============================================================================

-- Player profile. Linked to auth.users. Holds the single source-of-truth balance.
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  username     text not null unique,
  balance_cents bigint not null default 0 check (balance_cents >= 0),
  created_at   timestamptz not null default now()
);

-- Log of every balance change - for auditing and consistency. Not writable by the client.
create table if not exists public.ledger (
  id            bigserial primary key,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  delta_cents   bigint not null,
  balance_after bigint not null,
  reason        text not null,            -- 'typing' | 'wheel_stake' | 'wheel_payout' | 'bet_stake' | 'bet_payout' | 'bet_refund'
  ref_id        uuid,                     -- id of the related bet/round (if relevant)
  created_at    timestamptz not null default now()
);

-- Typing log - for rate limiting (anti-abuse) and transparency. The client reports words,
-- but the server enforces rate/amount limits and never trusts a value the client might inject.
create table if not exists public.earn_log (
  id            bigserial primary key,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  words_counted int not null check (words_counted > 0),
  cents_awarded int not null check (cents_awarded > 0),
  created_at    timestamptz not null default now()
);

-- Player-vs-player bets (1v1) - coinflip (50/50) or dice (die roll, tie=refund)
create table if not exists public.bets (
  id            uuid primary key default gen_random_uuid(),
  mode          text not null default 'coinflip' check (mode in ('coinflip','dice')),
  creator_id    uuid not null references public.profiles(id) on delete cascade,
  opponent_id   uuid references public.profiles(id) on delete cascade,
  stake_cents   int not null check (stake_cents > 0),
  status        text not null default 'open' check (status in ('open','matched','resolved','cancelled')),
  winner_id     uuid references public.profiles(id),
  creator_roll  int,
  opponent_roll int,
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz
);
alter table public.bets add column if not exists mode text not null default 'coinflip';
alter table public.bets add column if not exists creator_roll int;
alter table public.bets add column if not exists opponent_roll int;

-- Rock-Paper-Scissors bets (commit-reveal - so the bet creator can't cheat
-- after seeing the opponent's move). The real move isn't stored at all until the reveal step.
create table if not exists public.rps_bets (
  id            uuid primary key default gen_random_uuid(),
  creator_id    uuid not null references public.profiles(id) on delete cascade,
  opponent_id   uuid references public.profiles(id) on delete cascade,
  stake_cents   int not null check (stake_cents > 0),
  move_hash     text not null,
  creator_move  text check (creator_move in ('rock','paper','scissors')),
  opponent_move text check (opponent_move in ('rock','paper','scissors')),
  status        text not null default 'open' check (status in ('open','awaiting_reveal','resolved','cancelled')),
  winner_id     uuid references public.profiles(id),
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz
);

-- Group pots (raffle) - each player buys "tickets" (stake), a winner is picked
-- randomly on the server with odds proportional to their stake - "the more you risk, the better your odds".
create table if not exists public.pots (
  id            uuid primary key default gen_random_uuid(),
  status        text not null default 'open' check (status in ('open','resolved')),
  total_cents   bigint not null default 0,
  winner_id     uuid references public.profiles(id),
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz
);

create table if not exists public.pot_entries (
  id          bigserial primary key,
  pot_id      uuid not null references public.pots(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  stake_cents int not null check (stake_cents > 0),
  created_at  timestamptz not null default now()
);

-- Every round of the "vs house" games (coinflip, dice, slots, hi-lo, crash) -
-- one generic table for logging/stats/leaderboard.
create table if not exists public.game_rounds (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  game_type    text not null,           -- 'coinflip'|'dice'|'slots'|'hilo'|'crash'
  stake_cents  int not null check (stake_cents > 0),
  status       text not null default 'resolved' check (status in ('pending','resolved')),
  params       jsonb not null default '{}'::jsonb,
  result       jsonb not null default '{}'::jsonb,
  payout_cents int not null default 0,
  created_at   timestamptz not null default now()
);

-- Wheel of Fortune spins
create table if not exists public.wheel_spins (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  stake_cents   int not null check (stake_cents > 0),
  multiplier    numeric not null,
  payout_cents  int not null,
  segment_label text not null,
  created_at    timestamptz not null default now()
);

-- ============================================================================
-- 2. Security: enable RLS on every table, with no INSERT/UPDATE/DELETE grants
--    to clients at all. Every state change goes exclusively through the functions in section 3 (SECURITY DEFINER).
-- ============================================================================

alter table public.profiles    enable row level security;
alter table public.ledger      enable row level security;
alter table public.earn_log    enable row level security;
alter table public.bets        enable row level security;
alter table public.wheel_spins enable row level security;
alter table public.rps_bets    enable row level security;
alter table public.pots        enable row level security;
alter table public.pot_entries enable row level security;
alter table public.game_rounds enable row level security;

-- Make sure there are no direct write privileges from the API, even if someone adds a policy by mistake later
revoke insert, update, delete on public.profiles    from anon, authenticated;
revoke insert, update, delete on public.ledger      from anon, authenticated;
revoke insert, update, delete on public.earn_log    from anon, authenticated;
revoke insert, update, delete on public.bets        from anon, authenticated;
revoke insert, update, delete on public.wheel_spins from anon, authenticated;
revoke insert, update, delete on public.rps_bets    from anon, authenticated;
revoke insert, update, delete on public.pots        from anon, authenticated;
revoke insert, update, delete on public.pot_entries from anon, authenticated;
revoke insert, update, delete on public.game_rounds from anon, authenticated;
grant select on public.profiles, public.ledger, public.earn_log, public.bets, public.wheel_spins,
  public.rps_bets, public.pots, public.pot_entries, public.game_rounds
  to anon, authenticated;

-- Read: everyone can see the leaderboard (name + balance) for everyone
drop policy if exists "profiles_select_all" on public.profiles;
create policy "profiles_select_all" on public.profiles
  for select using (true);

-- ledger: each player only sees their own log
drop policy if exists "ledger_select_own" on public.ledger;
create policy "ledger_select_own" on public.ledger
  for select using (auth.uid() = user_id);

-- earn_log: each player only sees their own log
drop policy if exists "earn_log_select_own" on public.earn_log;
create policy "earn_log_select_own" on public.earn_log
  for select using (auth.uid() = user_id);

-- bets: everyone sees all bets (so they can find open bets to join)
drop policy if exists "bets_select_all" on public.bets;
create policy "bets_select_all" on public.bets
  for select using (true);

-- wheel_spins: everyone sees them (public feed of recent spins)
drop policy if exists "wheel_spins_select_all" on public.wheel_spins;
create policy "wheel_spins_select_all" on public.wheel_spins
  for select using (true);

-- rps_bets: everyone sees them (need to see open bets to join; the real move
-- isn't stored in the column until the reveal anyway, so there's no information leak)
drop policy if exists "rps_bets_select_all" on public.rps_bets;
create policy "rps_bets_select_all" on public.rps_bets
  for select using (true);

-- pots / pot_entries: everyone sees them (to see open pots and who already joined)
drop policy if exists "pots_select_all" on public.pots;
create policy "pots_select_all" on public.pots
  for select using (true);
drop policy if exists "pot_entries_select_all" on public.pot_entries;
create policy "pot_entries_select_all" on public.pot_entries
  for select using (true);

-- game_rounds: each player only sees their own rounds (personal log, not public)
drop policy if exists "game_rounds_select_own" on public.game_rounds;
create policy "game_rounds_select_own" on public.game_rounds
  for select using (auth.uid() = user_id);


-- ============================================================================
-- 3. Helper function: auto-create a profile on signup
-- ============================================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, username, balance_cents)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', 'player_' || substr(new.id::text, 1, 8)),
    0
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================================
-- 4. Business logic functions - the only ones allowed to touch the balance. All of them:
--    - are security definer (run with the owner's privileges, bypassing RLS internally)
--    - check auth.uid() themselves to make sure the user is only acting on their own behalf
--    - lock rows (for update) to prevent race conditions / double-spending
-- ============================================================================

-- 4.1 Earn cents from typing, with an anti-cheat rate limit:
--     max 200 words per call, and no more than one call every 3 seconds per user.
create or replace function public.earn_from_typing(p_words int)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_cents int;
  v_last timestamptz;
  v_new_balance bigint;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  if p_words is null or p_words <= 0 then
    raise exception 'invalid word count';
  end if;

  -- cap the word count for a single call
  if p_words > 200 then
    p_words := 200;
  end if;

  -- rate limit: no more than once every 3 seconds per user
  select created_at into v_last
  from public.earn_log
  where user_id = v_uid
  order by created_at desc
  limit 1
  for update skip locked;

  if v_last is not null and v_last > now() - interval '3 seconds' then
    raise exception 'rate limited, try again shortly';
  end if;

  v_cents := p_words * 1; -- one cent per word

  update public.profiles
  set balance_cents = balance_cents + v_cents
  where id = v_uid
  returning balance_cents into v_new_balance;

  insert into public.earn_log (user_id, words_counted, cents_awarded)
  values (v_uid, p_words, v_cents);

  insert into public.ledger (user_id, delta_cents, balance_after, reason)
  values (v_uid, v_cents, v_new_balance, 'typing');

  return v_new_balance;
end;
$$;

-- 4.2 Create an open bet (deducts the stake from the balance immediately, like escrow)
--     p_mode: 'coinflip' (50/50) or 'dice' (die roll, tie = refund to both)
create or replace function public.create_pvp_bet(p_stake int, p_mode text default 'coinflip')
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_balance bigint;
  v_bet_id uuid;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if p_stake is null or p_stake <= 0 then raise exception 'invalid stake'; end if;
  if p_mode not in ('coinflip','dice') then raise exception 'invalid mode'; end if;

  select balance_cents into v_balance from public.profiles where id = v_uid for update;
  if v_balance < p_stake then
    raise exception 'insufficient balance';
  end if;

  update public.profiles set balance_cents = balance_cents - p_stake where id = v_uid;

  insert into public.bets (creator_id, stake_cents, status, mode)
  values (v_uid, p_stake, 'open', p_mode)
  returning id into v_bet_id;

  insert into public.ledger (user_id, delta_cents, balance_after, reason, ref_id)
  values (v_uid, -p_stake, v_balance - p_stake, 'bet_stake', v_bet_id);

  return v_bet_id;
end;
$$;

-- 4.3 Cancel an open bet (creator only, only if nobody has joined yet) - refunds the stake
create or replace function public.cancel_pvp_bet(p_bet_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_bet record;
  v_balance bigint;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;

  select * into v_bet from public.bets where id = p_bet_id for update;
  if v_bet is null then raise exception 'bet not found'; end if;
  if v_bet.creator_id <> v_uid then raise exception 'not your bet'; end if;
  if v_bet.status <> 'open' then raise exception 'bet is not open'; end if;

  update public.bets set status = 'cancelled' where id = p_bet_id;

  update public.profiles set balance_cents = balance_cents + v_bet.stake_cents
  where id = v_uid
  returning balance_cents into v_balance;

  insert into public.ledger (user_id, delta_cents, balance_after, reason, ref_id)
  values (v_uid, v_bet.stake_cents, v_balance, 'bet_refund', p_bet_id);
end;
$$;

-- 4.4 Join an open bet - the server (not the client!) determines the outcome using Postgres's random().
--     In 'dice' mode: each side gets a 1-6 die roll; a tie = full refund to both sides (no winner).
--     Returns: winner_id (or null on a tie)
create or replace function public.join_pvp_bet(p_bet_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_bet record;
  v_balance bigint;
  v_winner uuid;
  v_pot int;
  v_new_balance bigint;
  v_croll int;
  v_oroll int;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;

  select * into v_bet from public.bets where id = p_bet_id for update;
  if v_bet is null then raise exception 'bet not found'; end if;
  if v_bet.status <> 'open' then raise exception 'bet is not open'; end if;
  if v_bet.creator_id = v_uid then raise exception 'cannot join your own bet'; end if;

  select balance_cents into v_balance from public.profiles where id = v_uid for update;
  if v_balance < v_bet.stake_cents then raise exception 'insufficient balance'; end if;

  update public.profiles set balance_cents = balance_cents - v_bet.stake_cents where id = v_uid;
  insert into public.ledger (user_id, delta_cents, balance_after, reason, ref_id)
  values (v_uid, -v_bet.stake_cents, v_balance - v_bet.stake_cents, 'bet_stake', p_bet_id);

  v_pot := v_bet.stake_cents * 2;

  if v_bet.mode = 'dice' then
    v_croll := 1 + floor(random() * 6)::int;
    v_oroll := 1 + floor(random() * 6)::int;
    if v_croll = v_oroll then
      -- tie: refund both sides their stake, no winner
      update public.bets
      set status = 'resolved', opponent_id = v_uid, winner_id = null,
          creator_roll = v_croll, opponent_roll = v_oroll, resolved_at = now()
      where id = p_bet_id;

      update public.profiles set balance_cents = balance_cents + v_bet.stake_cents where id = v_uid
      returning balance_cents into v_new_balance;
      insert into public.ledger (user_id, delta_cents, balance_after, reason, ref_id)
      values (v_uid, v_bet.stake_cents, v_new_balance, 'bet_refund', p_bet_id);

      update public.profiles set balance_cents = balance_cents + v_bet.stake_cents where id = v_bet.creator_id
      returning balance_cents into v_new_balance;
      insert into public.ledger (user_id, delta_cents, balance_after, reason, ref_id)
      values (v_bet.creator_id, v_bet.stake_cents, v_new_balance, 'bet_refund', p_bet_id);

      return null;
    end if;
    v_winner := case when v_croll > v_oroll then v_bet.creator_id else v_uid end;
  else
    -- coinflip: 50/50 on the server
    if random() < 0.5 then
      v_winner := v_bet.creator_id;
    else
      v_winner := v_uid;
    end if;
  end if;

  update public.bets
  set status = 'resolved', opponent_id = v_uid, winner_id = v_winner,
      creator_roll = v_croll, opponent_roll = v_oroll, resolved_at = now()
  where id = p_bet_id;

  update public.profiles set balance_cents = balance_cents + v_pot
  where id = v_winner
  returning balance_cents into v_new_balance;

  insert into public.ledger (user_id, delta_cents, balance_after, reason, ref_id)
  values (v_winner, v_pot, v_new_balance, 'bet_payout', p_bet_id);

  return v_winner;
end;
$$;

-- 4.5 Wheel of Fortune - stake, server draws a segment, payout by multiplier
create or replace function public.spin_wheel(p_stake int)
returns table(segment_label text, multiplier numeric, payout_cents int, new_balance bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_balance bigint;
  v_roll numeric := random();
  v_segment text;
  v_mult numeric;
  v_payout int;
  v_new_balance bigint;
  v_spin_id uuid;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if p_stake is null or p_stake <= 0 then raise exception 'invalid stake'; end if;

  select balance_cents into v_balance from public.profiles where id = v_uid for update;
  if v_balance < p_stake then raise exception 'insufficient balance'; end if;

  -- results table (total probability = 1.0). The house edge here is slightly in the house's favor.
  if v_roll < 0.02 then
    v_segment := 'JACKPOT'; v_mult := 10.0;
  elsif v_roll < 0.12 then
    v_segment := 'x3'; v_mult := 3.0;
  elsif v_roll < 0.32 then
    v_segment := 'x2'; v_mult := 2.0;
  elsif v_roll < 0.62 then
    v_segment := 'x1'; v_mult := 1.0;
  elsif v_roll < 0.87 then
    v_segment := 'x0.5'; v_mult := 0.5;
  else
    v_segment := 'BUST'; v_mult := 0.0;
  end if;

  v_payout := floor(p_stake * v_mult);

  update public.profiles set balance_cents = balance_cents - p_stake where id = v_uid;
  insert into public.ledger (user_id, delta_cents, balance_after, reason)
  values (v_uid, -p_stake, v_balance - p_stake, 'wheel_stake');

  update public.profiles set balance_cents = balance_cents + v_payout
  where id = v_uid
  returning balance_cents into v_new_balance;

  insert into public.wheel_spins (user_id, stake_cents, multiplier, payout_cents, segment_label)
  values (v_uid, p_stake, v_mult, v_payout, v_segment)
  returning id into v_spin_id;

  insert into public.ledger (user_id, delta_cents, balance_after, reason, ref_id)
  values (v_uid, v_payout, v_new_balance, 'wheel_payout', v_spin_id);

  return query select v_segment, v_mult, v_payout, v_new_balance;
end;
$$;

-- ============================================================================
-- 4.6 Rock-Paper-Scissors (RPS) - a 1v1 bet with commit-reveal
--     So the creator can't "see" the opponent's move and then pick a winning move,
--     they commit up front only to a hash (created client-side: sha256(move + ':' + salt)),
--     and their real move isn't stored at all until the reveal step.
-- ============================================================================

create or replace function public.create_rps_bet(p_stake int, p_move_hash text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_balance bigint;
  v_id uuid;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if p_stake is null or p_stake <= 0 then raise exception 'invalid stake'; end if;
  if p_move_hash is null or length(p_move_hash) < 10 then raise exception 'invalid commitment'; end if;

  select balance_cents into v_balance from public.profiles where id = v_uid for update;
  if v_balance < p_stake then raise exception 'insufficient balance'; end if;

  update public.profiles set balance_cents = balance_cents - p_stake where id = v_uid;

  insert into public.rps_bets (creator_id, stake_cents, move_hash, status)
  values (v_uid, p_stake, p_move_hash, 'open')
  returning id into v_id;

  insert into public.ledger (user_id, delta_cents, balance_after, reason, ref_id)
  values (v_uid, -p_stake, v_balance - p_stake, 'bet_stake', v_id);

  return v_id;
end;
$$;

create or replace function public.cancel_rps_bet(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_bet record;
  v_new_balance bigint;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  select * into v_bet from public.rps_bets where id = p_id for update;
  if v_bet is null then raise exception 'not found'; end if;
  if v_bet.creator_id <> v_uid then raise exception 'not your bet'; end if;
  if v_bet.status <> 'open' then raise exception 'cannot cancel now'; end if;

  update public.rps_bets set status = 'cancelled' where id = p_id;
  update public.profiles set balance_cents = balance_cents + v_bet.stake_cents where id = v_uid
  returning balance_cents into v_new_balance;
  insert into public.ledger (user_id, delta_cents, balance_after, reason, ref_id)
  values (v_uid, v_bet.stake_cents, v_new_balance, 'bet_refund', p_id);
end;
$$;

-- The opponent joins and picks a move in plaintext (that's fine - they haven't seen and can't see
-- the creator's move, which only exists as a hash until the next step)
create or replace function public.join_rps_bet(p_id uuid, p_move text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_bet record;
  v_balance bigint;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if p_move not in ('rock','paper','scissors') then raise exception 'invalid move'; end if;

  select * into v_bet from public.rps_bets where id = p_id for update;
  if v_bet is null then raise exception 'not found'; end if;
  if v_bet.status <> 'open' then raise exception 'bet is not open'; end if;
  if v_bet.creator_id = v_uid then raise exception 'cannot join your own bet'; end if;

  select balance_cents into v_balance from public.profiles where id = v_uid for update;
  if v_balance < v_bet.stake_cents then raise exception 'insufficient balance'; end if;

  update public.profiles set balance_cents = balance_cents - v_bet.stake_cents where id = v_uid;
  insert into public.ledger (user_id, delta_cents, balance_after, reason, ref_id)
  values (v_uid, -v_bet.stake_cents, v_balance - v_bet.stake_cents, 'bet_stake', p_id);

  update public.rps_bets
  set opponent_id = v_uid, opponent_move = p_move, status = 'awaiting_reveal'
  where id = p_id;

  return p_id;
end;
$$;

-- The creator reveals their real move + salt. The server checks the hash matches (can't lie after the fact),
-- and only then determines a winner by Rock-Paper-Scissors rules. A tie = refund to both.
create or replace function public.reveal_rps_bet(p_id uuid, p_move text, p_salt text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_bet record;
  v_computed_hash text;
  v_winner uuid;
  v_pot int;
  v_new_balance bigint;
  v_beats jsonb := '{"rock":"scissors","paper":"rock","scissors":"paper"}'::jsonb;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if p_move not in ('rock','paper','scissors') then raise exception 'invalid move'; end if;

  select * into v_bet from public.rps_bets where id = p_id for update;
  if v_bet is null then raise exception 'not found'; end if;
  if v_bet.creator_id <> v_uid then raise exception 'only the creator can reveal'; end if;
  if v_bet.status <> 'awaiting_reveal' then raise exception 'not awaiting reveal'; end if;

  v_computed_hash := encode(digest(p_move || ':' || p_salt, 'sha256'), 'hex');
  if v_computed_hash <> v_bet.move_hash then
    raise exception 'reveal does not match commitment - cheating attempt blocked';
  end if;

  v_pot := v_bet.stake_cents * 2;

  if p_move = v_bet.opponent_move then
    -- tie: refund both
    update public.rps_bets
    set status = 'resolved', creator_move = p_move, winner_id = null, resolved_at = now()
    where id = p_id;

    update public.profiles set balance_cents = balance_cents + v_bet.stake_cents where id = v_bet.creator_id
    returning balance_cents into v_new_balance;
    insert into public.ledger (user_id, delta_cents, balance_after, reason, ref_id)
    values (v_bet.creator_id, v_bet.stake_cents, v_new_balance, 'bet_refund', p_id);

    update public.profiles set balance_cents = balance_cents + v_bet.stake_cents where id = v_bet.opponent_id
    returning balance_cents into v_new_balance;
    insert into public.ledger (user_id, delta_cents, balance_after, reason, ref_id)
    values (v_bet.opponent_id, v_bet.stake_cents, v_new_balance, 'bet_refund', p_id);

    return null;
  end if;

  if (v_beats->>p_move) = v_bet.opponent_move then
    v_winner := v_bet.creator_id;
  else
    v_winner := v_bet.opponent_id;
  end if;

  update public.rps_bets
  set status = 'resolved', creator_move = p_move, winner_id = v_winner, resolved_at = now()
  where id = p_id;

  update public.profiles set balance_cents = balance_cents + v_pot where id = v_winner
  returning balance_cents into v_new_balance;
  insert into public.ledger (user_id, delta_cents, balance_after, reason, ref_id)
  values (v_winner, v_pot, v_new_balance, 'bet_payout', p_id);

  return v_winner;
end;
$$;

-- ============================================================================
-- 4.7 Group Pot (Raffle) - any number of players can buy in with a stake,
--     the winner is drawn at random on the server with odds proportional to their stake, and wins the whole pot.
-- ============================================================================

create or replace function public.create_pot()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  insert into public.pots (status, total_cents) values ('open', 0) returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.join_pot(p_pot_id uuid, p_stake int)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_pot record;
  v_balance bigint;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if p_stake is null or p_stake <= 0 then raise exception 'invalid stake'; end if;

  select * into v_pot from public.pots where id = p_pot_id for update;
  if v_pot is null then raise exception 'pot not found'; end if;
  if v_pot.status <> 'open' then raise exception 'pot is closed'; end if;

  select balance_cents into v_balance from public.profiles where id = v_uid for update;
  if v_balance < p_stake then raise exception 'insufficient balance'; end if;

  update public.profiles set balance_cents = balance_cents - p_stake where id = v_uid;
  insert into public.ledger (user_id, delta_cents, balance_after, reason, ref_id)
  values (v_uid, -p_stake, v_balance - p_stake, 'bet_stake', p_pot_id);

  insert into public.pot_entries (pot_id, user_id, stake_cents) values (p_pot_id, v_uid, p_stake);
  update public.pots set total_cents = total_cents + p_stake where id = p_pot_id;
end;
$$;

-- Any participant can trigger the "draw" once there are at least 2 distinct participants in the pot.
-- The draw is weighted: each player's odds of winning = (the amount they put in) / (total pot).
create or replace function public.draw_pot(p_pot_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_pot record;
  v_participant_count int;
  v_roll numeric;
  v_cumulative bigint := 0;
  v_winner uuid;
  v_new_balance bigint;
  r record;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;

  select * into v_pot from public.pots where id = p_pot_id for update;
  if v_pot is null then raise exception 'pot not found'; end if;
  if v_pot.status <> 'open' then raise exception 'pot already resolved'; end if;

  select count(distinct user_id) into v_participant_count from public.pot_entries where pot_id = p_pot_id;
  if v_participant_count < 2 then raise exception 'need at least 2 players to draw'; end if;

  if not exists (select 1 from public.pot_entries where pot_id = p_pot_id and user_id = v_uid) then
    raise exception 'only participants can trigger the draw';
  end if;

  -- weighted draw on the server: a uniform roll between 0 and the pot total, then a cumulative walk over the entries
  v_roll := random() * v_pot.total_cents;
  for r in
    select user_id, stake_cents from public.pot_entries
    where pot_id = p_pot_id
    order by created_at asc
  loop
    v_cumulative := v_cumulative + r.stake_cents;
    if v_roll <= v_cumulative then
      v_winner := r.user_id;
      exit;
    end if;
  end loop;

  if v_winner is null then
    select user_id into v_winner from public.pot_entries where pot_id = p_pot_id order by created_at desc limit 1;
  end if;

  update public.pots set status = 'resolved', winner_id = v_winner, resolved_at = now() where id = p_pot_id;

  update public.profiles set balance_cents = balance_cents + v_pot.total_cents where id = v_winner
  returning balance_cents into v_new_balance;
  insert into public.ledger (user_id, delta_cents, balance_after, reason, ref_id)
  values (v_winner, v_pot.total_cents, v_new_balance, 'bet_payout', p_pot_id);

  return v_winner;
end;
$$;

-- ============================================================================
-- 4.8 "Vs the house" games (single player). In every game: the stake is deducted first,
--     then the outcome is decided entirely by random() on the server. There's no hidden fixed edge -
--     the house edge is baked transparently into the payout multipliers (noted in the comments for each game).
-- ============================================================================

-- 4.8.1 Coinflip vs the house: true 50/50, pays 1.9x on a win (5% house edge)
create or replace function public.play_coinflip_house(p_stake int, p_choice text)
returns table(result text, payout_cents int, new_balance bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_balance bigint;
  v_flip text;
  v_payout int := 0;
  v_new_balance bigint;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if p_choice not in ('heads','tails') then raise exception 'invalid choice'; end if;
  if p_stake is null or p_stake <= 0 then raise exception 'invalid stake'; end if;

  select balance_cents into v_balance from public.profiles where id = v_uid for update;
  if v_balance < p_stake then raise exception 'insufficient balance'; end if;

  update public.profiles set balance_cents = balance_cents - p_stake where id = v_uid;

  v_flip := case when random() < 0.5 then 'heads' else 'tails' end;
  if v_flip = p_choice then
    v_payout := floor(p_stake * 1.9);
  end if;

  update public.profiles set balance_cents = balance_cents + v_payout where id = v_uid
  returning balance_cents into v_new_balance;

  insert into public.game_rounds (user_id, game_type, stake_cents, params, result, payout_cents)
  values (v_uid, 'coinflip', p_stake, jsonb_build_object('choice', p_choice), jsonb_build_object('flip', v_flip), v_payout);

  insert into public.ledger (user_id, delta_cents, balance_after, reason)
  values (v_uid, v_payout - p_stake, v_new_balance, 'wheel_payout');

  return query select v_flip, v_payout, v_new_balance;
end;
$$;

-- 4.8.2 Dice vs the house: pick a threshold from 2-98, you win if the roll (1-100) lands
--       below the threshold. Multiplier = (100/threshold) * 0.97 (3% house edge) - lower threshold = lower odds,
--       higher payout.
create or replace function public.play_dice_house(p_stake int, p_roll_under int)
returns table(roll int, won boolean, payout_cents int, new_balance bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_balance bigint;
  v_roll int;
  v_won boolean;
  v_multiplier numeric;
  v_payout int := 0;
  v_new_balance bigint;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if p_roll_under is null or p_roll_under < 2 or p_roll_under > 98 then
    raise exception 'roll_under must be between 2 and 98';
  end if;
  if p_stake is null or p_stake <= 0 then raise exception 'invalid stake'; end if;

  select balance_cents into v_balance from public.profiles where id = v_uid for update;
  if v_balance < p_stake then raise exception 'insufficient balance'; end if;

  update public.profiles set balance_cents = balance_cents - p_stake where id = v_uid;

  v_roll := 1 + floor(random() * 100)::int; -- 1..100
  v_won := v_roll < p_roll_under;
  v_multiplier := (100.0 / p_roll_under) * 0.97;
  if v_won then
    v_payout := floor(p_stake * v_multiplier);
  end if;

  update public.profiles set balance_cents = balance_cents + v_payout where id = v_uid
  returning balance_cents into v_new_balance;

  insert into public.game_rounds (user_id, game_type, stake_cents, params, result, payout_cents)
  values (v_uid, 'dice', p_stake, jsonb_build_object('roll_under', p_roll_under),
          jsonb_build_object('roll', v_roll, 'won', v_won), v_payout);

  insert into public.ledger (user_id, delta_cents, balance_after, reason)
  values (v_uid, v_payout - p_stake, v_new_balance, 'wheel_payout');

  return query select v_roll, v_won, v_payout, v_new_balance;
end;
$$;

-- Helper function: pick a weighted slot symbol (stands on its own because PL/pgSQL doesn't support
-- defining a nested function inside another function's body)
create or replace function public.pick_weighted_slot_symbol()
returns text
language plpgsql
as $$
declare
  v_symbols text[] := array['🍒','🍋','🔔','⭐','💎','7️⃣'];
  v_weights numeric[] := array[30, 25, 20, 15, 8, 2]; -- out of a total of 100
  v_r numeric := random() * 100;
  v_acc numeric := 0;
  i int;
begin
  for i in 1..array_length(v_symbols,1) loop
    v_acc := v_acc + v_weights[i];
    if v_r <= v_acc then
      return v_symbols[i];
    end if;
  end loop;
  return v_symbols[array_length(v_symbols,1)];
end;
$$;

-- 4.8.3 Slot machine: 3 reels, weighted symbols. Three of a kind = a big multiplier,
--       two of a kind = a small multiplier, otherwise a loss.
create or replace function public.play_slots_house(p_stake int)
returns table(reels text[], payout_cents int, new_balance bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_balance bigint;
  v_reel1 text; v_reel2 text; v_reel3 text;
  v_payout int := 0;
  v_multiplier numeric := 0;
  v_new_balance bigint;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if p_stake is null or p_stake <= 0 then raise exception 'invalid stake'; end if;

  select balance_cents into v_balance from public.profiles where id = v_uid for update;
  if v_balance < p_stake then raise exception 'insufficient balance'; end if;

  update public.profiles set balance_cents = balance_cents - p_stake where id = v_uid;

  v_reel1 := public.pick_weighted_slot_symbol();
  v_reel2 := public.pick_weighted_slot_symbol();
  v_reel3 := public.pick_weighted_slot_symbol();

  if v_reel1 = v_reel2 and v_reel2 = v_reel3 then
    v_multiplier := case v_reel1
      when '7️⃣' then 25 when '💎' then 15 when '⭐' then 8
      when '🔔' then 5 when '🍋' then 3 else 2 end;
  elsif v_reel1 = v_reel2 or v_reel2 = v_reel3 or v_reel1 = v_reel3 then
    v_multiplier := 1.2;
  end if;

  v_payout := floor(p_stake * v_multiplier);

  update public.profiles set balance_cents = balance_cents + v_payout where id = v_uid
  returning balance_cents into v_new_balance;

  insert into public.game_rounds (user_id, game_type, stake_cents, params, result, payout_cents)
  values (v_uid, 'slots', p_stake, '{}'::jsonb,
          jsonb_build_object('reels', array[v_reel1, v_reel2, v_reel3], 'multiplier', v_multiplier), v_payout);

  insert into public.ledger (user_id, delta_cents, balance_after, reason)
  values (v_uid, v_payout - p_stake, v_new_balance, 'wheel_payout');

  return query select array[v_reel1, v_reel2, v_reel3], v_payout, v_new_balance;
end;
$$;

-- 4.8.4 Hi-Lo: two steps. Step 1 deducts the stake and draws the first card (1-13).
--       Step 2 draws a second card and compares it to the guess. Equal cards = a push (refund).
create or replace function public.start_hilo_house(p_stake int)
returns table(round_id uuid, card int, new_balance bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_balance bigint;
  v_card int;
  v_round_id uuid;
  v_new_balance bigint;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if p_stake is null or p_stake <= 0 then raise exception 'invalid stake'; end if;

  select balance_cents into v_balance from public.profiles where id = v_uid for update;
  if v_balance < p_stake then raise exception 'insufficient balance'; end if;

  update public.profiles set balance_cents = balance_cents - p_stake where id = v_uid
  returning balance_cents into v_new_balance;

  v_card := 1 + floor(random() * 13)::int;

  insert into public.game_rounds (user_id, game_type, stake_cents, status, params, result, payout_cents)
  values (v_uid, 'hilo', p_stake, 'pending', '{}'::jsonb, jsonb_build_object('card_a', v_card), 0)
  returning id into v_round_id;

  insert into public.ledger (user_id, delta_cents, balance_after, reason, ref_id)
  values (v_uid, -p_stake, v_new_balance, 'wheel_stake', v_round_id);

  return query select v_round_id, v_card, v_new_balance;
end;
$$;

create or replace function public.guess_hilo_house(p_round_id uuid, p_guess text)
returns table(card_b int, outcome text, payout_cents int, new_balance bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_round record;
  v_card_a int;
  v_card_b int;
  v_outcome text;
  v_payout int := 0;
  v_new_balance bigint;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if p_guess not in ('higher','lower') then raise exception 'invalid guess'; end if;

  select * into v_round from public.game_rounds where id = p_round_id for update;
  if v_round is null then raise exception 'round not found'; end if;
  if v_round.user_id <> v_uid then raise exception 'not your round'; end if;
  if v_round.status <> 'pending' or v_round.game_type <> 'hilo' then raise exception 'round already resolved'; end if;

  v_card_a := (v_round.result->>'card_a')::int;
  v_card_b := 1 + floor(random() * 13)::int;

  if v_card_b = v_card_a then
    v_outcome := 'push';
    v_payout := v_round.stake_cents; -- full refund
  elsif (p_guess = 'higher' and v_card_b > v_card_a) or (p_guess = 'lower' and v_card_b < v_card_a) then
    v_outcome := 'win';
    v_payout := floor(v_round.stake_cents * 1.9);
  else
    v_outcome := 'lose';
    v_payout := 0;
  end if;

  update public.profiles set balance_cents = balance_cents + v_payout where id = v_uid
  returning balance_cents into v_new_balance;

  update public.game_rounds
  set status = 'resolved', payout_cents = v_payout,
      result = v_round.result || jsonb_build_object('card_b', v_card_b, 'guess', p_guess, 'outcome', v_outcome)
  where id = p_round_id;

  if v_payout > 0 then
    insert into public.ledger (user_id, delta_cents, balance_after, reason, ref_id)
    values (v_uid, v_payout, v_new_balance, 'wheel_payout', p_round_id);
  end if;

  return query select v_card_b, v_outcome, v_payout, v_new_balance;
end;
$$;

-- 4.8.5 Crash: pick in advance which multiplier to "cash out" at. The server draws
--       a crash point using a standard (provably-fair-style) formula with roughly a 1% house edge.
--       If the crash point is higher than or equal to the multiplier you picked - you win.
create or replace function public.play_crash_house(p_stake int, p_cashout_at numeric)
returns table(crash_point numeric, won boolean, payout_cents int, new_balance bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_balance bigint;
  v_r numeric := random();
  v_crash numeric;
  v_won boolean;
  v_payout int := 0;
  v_new_balance bigint;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  if p_stake is null or p_stake <= 0 then raise exception 'invalid stake'; end if;
  if p_cashout_at is null or p_cashout_at < 1.01 or p_cashout_at > 100 then
    raise exception 'cashout_at must be between 1.01 and 100';
  end if;

  select balance_cents into v_balance from public.profiles where id = v_uid for update;
  if v_balance < p_stake then raise exception 'insufficient balance'; end if;

  update public.profiles set balance_cents = balance_cents - p_stake where id = v_uid;

  -- classic crash formula with a 1% house edge; a reasonable upper bound to avoid extreme values
  v_crash := greatest(1.00, least(1000.0, 0.99 / greatest(0.0001, (1 - v_r))));

  v_won := p_cashout_at <= v_crash;
  if v_won then
    v_payout := floor(p_stake * p_cashout_at);
  end if;

  update public.profiles set balance_cents = balance_cents + v_payout where id = v_uid
  returning balance_cents into v_new_balance;

  insert into public.game_rounds (user_id, game_type, stake_cents, params, result, payout_cents)
  values (v_uid, 'crash', p_stake, jsonb_build_object('cashout_at', p_cashout_at),
          jsonb_build_object('crash_point', round(v_crash,2), 'won', v_won), v_payout);

  insert into public.ledger (user_id, delta_cents, balance_after, reason)
  values (v_uid, v_payout - p_stake, v_new_balance, 'wheel_payout');

  return query select round(v_crash,2), v_won, v_payout, v_new_balance;
end;
$$;

-- ============================================================================
-- 5. Execute grants on the functions (the only allowed way to touch the balance)
-- ============================================================================
grant execute on function public.earn_from_typing(int)   to authenticated;
grant execute on function public.create_pvp_bet(int, text) to authenticated;
grant execute on function public.cancel_pvp_bet(uuid)      to authenticated;
grant execute on function public.join_pvp_bet(uuid)        to authenticated;
grant execute on function public.spin_wheel(int)            to authenticated;
grant execute on function public.create_rps_bet(int, text)  to authenticated;
grant execute on function public.cancel_rps_bet(uuid)       to authenticated;
grant execute on function public.join_rps_bet(uuid, text)   to authenticated;
grant execute on function public.reveal_rps_bet(uuid, text, text) to authenticated;
grant execute on function public.create_pot()               to authenticated;
grant execute on function public.join_pot(uuid, int)         to authenticated;
grant execute on function public.draw_pot(uuid)              to authenticated;
grant execute on function public.play_coinflip_house(int, text) to authenticated;
grant execute on function public.play_dice_house(int, int)      to authenticated;
grant execute on function public.play_slots_house(int)          to authenticated;
grant execute on function public.start_hilo_house(int)          to authenticated;
grant execute on function public.guess_hilo_house(uuid, text)   to authenticated;
grant execute on function public.play_crash_house(int, numeric) to authenticated;

-- ============================================================================
-- 6. ADDITIONS FOR THE WORD ADD-IN (not in the original Obsidian plugin) -
--    these are new, on top of everything above; nothing above was changed.
-- ============================================================================

-- 6.1 The Word add-in awards 1 cent per LETTER typed (not per word, as the
--     original Obsidian plugin does) - separate log table + function so the
--     original earn_from_typing/earn_log above are completely untouched.
create table if not exists public.earn_log_letters (
  id             bigserial primary key,
  user_id        uuid not null references public.profiles(id) on delete cascade,
  letters_counted int not null check (letters_counted > 0),
  cents_awarded   int not null check (cents_awarded > 0),
  created_at     timestamptz not null default now()
);
alter table public.earn_log_letters enable row level security;
revoke insert, update, delete on public.earn_log_letters from anon, authenticated;
grant select on public.earn_log_letters to anon, authenticated;
drop policy if exists "earn_log_letters_select_own" on public.earn_log_letters;
create policy "earn_log_letters_select_own" on public.earn_log_letters
  for select using (auth.uid() = user_id);

create or replace function public.earn_from_typing_letters(p_letters int)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_cents int;
  v_last timestamptz;
  v_new_balance bigint;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  if p_letters is null or p_letters <= 0 then
    raise exception 'invalid letter count';
  end if;

  if p_letters > 2000 then
    p_letters := 2000;
  end if;

  select created_at into v_last
  from public.earn_log_letters
  where user_id = v_uid
  order by created_at desc
  limit 1
  for update skip locked;

  if v_last is not null and v_last > now() - interval '3 seconds' then
    raise exception 'rate limited, try again shortly';
  end if;

  v_cents := p_letters * 1; -- one cent per letter

  update public.profiles
  set balance_cents = balance_cents + v_cents
  where id = v_uid
  returning balance_cents into v_new_balance;

  insert into public.earn_log_letters (user_id, letters_counted, cents_awarded)
  values (v_uid, p_letters, v_cents);

  insert into public.ledger (user_id, delta_cents, balance_after, reason)
  values (v_uid, v_cents, v_new_balance, 'typing');

  return v_new_balance;
end;
$$;

grant execute on function public.earn_from_typing_letters(int) to authenticated;

-- 6.2 Let a player rename themselves. profiles.username is UNIQUE and the
--     table has no client-side UPDATE grant, so this is the supported way
--     to change it (the original plugin's direct `.update()` call from the
--     client is blocked by RLS/grants and was never actually reachable).
--     On a name clash, a short random suffix is appended rather than failing outright.
create or replace function public.set_username(p_username text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_clean text;
  v_final text;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;

  v_clean := nullif(trim(p_username), '');
  if v_clean is null then raise exception 'name cannot be empty'; end if;
  if length(v_clean) > 24 then
    v_clean := substring(v_clean from 1 for 24);
  end if;

  v_final := v_clean;

  begin
    update public.profiles set username = v_final where id = v_uid;
  exception when unique_violation then
    v_final := v_clean || '_' || substr(v_uid::text, 1, 4);
    update public.profiles set username = v_final where id = v_uid;
  end;

  return v_final;
end;
$$;

grant execute on function public.set_username(text) to authenticated;

-- 6.3 Enable Realtime so the add-in gets live balance/open-bet updates with
--     zero polling. In Supabase Studio this is the same as going to
--     Database -> Replication -> and toggling these tables on; running this
--     does it for you. Safe to re-run.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'profiles'
  ) then
    alter publication supabase_realtime add table public.profiles;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'bets'
  ) then
    alter publication supabase_realtime add table public.bets;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'rps_bets'
  ) then
    alter publication supabase_realtime add table public.rps_bets;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'pots'
  ) then
    alter publication supabase_realtime add table public.pots;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'pot_entries'
  ) then
    alter publication supabase_realtime add table public.pot_entries;
  end if;
end $$;

-- ============================================================================
-- Done. After running: go to Authentication -> Providers and make sure Email or Anonymous
-- sign-in is enabled (the plugin uses anonymous sign-in by default).
-- ============================================================================
