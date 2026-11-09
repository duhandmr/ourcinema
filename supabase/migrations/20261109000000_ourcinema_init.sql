-- =====================================================================
-- OurCinema – başlangıç şeması, RLS politikaları ve Realtime yetkilendirmesi
-- Supabase SQL Editor'da tek seferde çalıştırılabilir (idempotent).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) TABLOLAR
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 40),
  created_at   timestamptz not null default now()
);

create table if not exists public.rooms (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  name        text not null,
  max_members integer not null default 2 check (max_members between 1 and 2),
  created_at  timestamptz not null default now()
);

create table if not exists public.room_members (
  room_id   uuid not null references public.rooms (id) on delete cascade,
  user_id   uuid not null references public.profiles (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id)
);
create index if not exists room_members_user_id_idx on public.room_members (user_id);

create table if not exists public.room_state (
  room_id          uuid primary key references public.rooms (id) on delete cascade,
  video_url        text check (video_url is null or (char_length(video_url) <= 2048 and video_url ~* '^https://')),
  source_type      text check (source_type is null or source_type in ('file', 'hls', 'youtube', 'vimeo', 'dailymotion', 'twitch')),
  is_playing       boolean not null default false,
  position_seconds double precision not null default 0 check (position_seconds >= 0 and position_seconds < 360000),
  updated_by       uuid references public.profiles (id) on delete set null,
  updated_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 2) YARDIMCI FONKSİYONLAR (security definer => RLS özyinelemesini önler)
-- ---------------------------------------------------------------------
create or replace function public.is_room_member(p_room_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.room_members m
    where m.room_id = p_room_id and m.user_id = auth.uid()
  );
$$;

create or replace function public.shares_room_with(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.room_members me
    join public.room_members other on other.room_id = me.room_id
    where me.user_id = auth.uid() and other.user_id = p_user_id
  );
$$;

-- Realtime kanal adı "room:<uuid>" biçimindedir.
create or replace function public.is_room_topic_member(p_topic text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_room_id uuid;
begin
  if p_topic is null or p_topic !~ '^room:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    return false;
  end if;
  v_room_id := substring(p_topic from 6)::uuid;
  return public.is_room_member(v_room_id);
end;
$$;

-- İstemci saat farkını ölçmek için sunucu saati.
create or replace function public.server_time()
returns timestamptz
language sql
volatile
as $$
  select clock_timestamp();
$$;

revoke all on function public.is_room_member(uuid) from public, anon;
revoke all on function public.shares_room_with(uuid) from public, anon;
revoke all on function public.is_room_topic_member(text) from public, anon;
revoke all on function public.server_time() from public, anon;
grant execute on function public.is_room_member(uuid) to authenticated;
grant execute on function public.shares_room_with(uuid) to authenticated;
grant execute on function public.is_room_topic_member(text) to authenticated;
grant execute on function public.server_time() to authenticated;

-- ---------------------------------------------------------------------
-- 3) TETİKLEYİCİLER
-- ---------------------------------------------------------------------
-- Yeni auth kullanıcısı => profil
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    left(
      coalesce(
        nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
        nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
        'Kullanıcı'
      ),
      40
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Mevcut kullanıcılar için profil doldurma
insert into public.profiles (id, display_name)
select u.id, left(coalesce(nullif(split_part(coalesce(u.email, ''), '@', 1), ''), 'Kullanıcı'), 40)
from auth.users u
on conflict (id) do nothing;

-- room_state: updated_at / updated_by sunucu tarafında damgalanır (istemci taklit edemez)
create or replace function public.stamp_room_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at := now();
  if auth.uid() is not null then
    new.updated_by := auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists room_state_stamp on public.room_state;
create trigger room_state_stamp
  before insert or update on public.room_state
  for each row execute function public.stamp_room_state();

-- Oda kapasitesi (en fazla 2 üye)
create or replace function public.enforce_room_capacity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_max   integer;
  v_count integer;
begin
  if exists (select 1 from public.room_members where room_id = new.room_id and user_id = new.user_id) then
    return new; -- çakışmayı ON CONFLICT yönetsin
  end if;
  select max_members into v_max from public.rooms where id = new.room_id for update;
  select count(*) into v_count from public.room_members where room_id = new.room_id;
  if v_count >= v_max then
    raise exception 'Bu oda en fazla % üyeye izin verir.', v_max;
  end if;
  return new;
end;
$$;

drop trigger if exists room_members_capacity on public.room_members;
create trigger room_members_capacity
  before insert on public.room_members
  for each row execute function public.enforce_room_capacity();

-- ---------------------------------------------------------------------
-- 4) YETKİLER (anon hiçbir şeye erişemez; authenticated yalnızca gerekene)
-- ---------------------------------------------------------------------
revoke all on public.profiles, public.rooms, public.room_members, public.room_state from anon, authenticated;

grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;
grant select on public.rooms to authenticated;
grant select on public.room_members to authenticated;
grant select on public.room_state to authenticated;
grant insert (room_id, video_url, source_type, is_playing, position_seconds) on public.room_state to authenticated;
grant update (room_id, video_url, source_type, is_playing, position_seconds) on public.room_state to authenticated;

-- ---------------------------------------------------------------------
-- 5) ROW LEVEL SECURITY
-- ---------------------------------------------------------------------
alter table public.profiles     enable row level security;
alter table public.rooms        enable row level security;
alter table public.room_members enable row level security;
alter table public.room_state   enable row level security;

drop policy if exists "profiles_select_self_or_roommate" on public.profiles;
create policy "profiles_select_self_or_roommate" on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.shares_room_with(id));

drop policy if exists "profiles_update_self" on public.profiles;
create policy "profiles_update_self" on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

drop policy if exists "rooms_select_members" on public.rooms;
create policy "rooms_select_members" on public.rooms
  for select to authenticated
  using (public.is_room_member(id));

drop policy if exists "room_members_select_members" on public.room_members;
create policy "room_members_select_members" on public.room_members
  for select to authenticated
  using (public.is_room_member(room_id));
-- room_members için INSERT/UPDATE/DELETE politikası YOK: üyelik yalnızca yönetici (SQL) tarafından verilir.

drop policy if exists "room_state_select_members" on public.room_state;
create policy "room_state_select_members" on public.room_state
  for select to authenticated
  using (public.is_room_member(room_id));

drop policy if exists "room_state_insert_members" on public.room_state;
create policy "room_state_insert_members" on public.room_state
  for insert to authenticated
  with check (public.is_room_member(room_id));

drop policy if exists "room_state_update_members" on public.room_state;
create policy "room_state_update_members" on public.room_state
  for update to authenticated
  using (public.is_room_member(room_id))
  with check (public.is_room_member(room_id));

-- ---------------------------------------------------------------------
-- 6) REALTIME YETKİLENDİRMESİ (private kanallar: broadcast + presence)
-- ---------------------------------------------------------------------
drop policy if exists "ourcinema_realtime_receive" on realtime.messages;
create policy "ourcinema_realtime_receive" on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension in ('broadcast', 'presence')
    and public.is_room_topic_member(realtime.topic())
  );

drop policy if exists "ourcinema_realtime_send" on realtime.messages;
create policy "ourcinema_realtime_send" on realtime.messages
  for insert to authenticated
  with check (
    realtime.messages.extension in ('broadcast', 'presence')
    and public.is_room_topic_member(realtime.topic())
  );

-- ---------------------------------------------------------------------
-- 7) TEK ÖZEL ODA
-- ---------------------------------------------------------------------
insert into public.rooms (slug, name, max_members)
values ('main', 'OurCinema', 2)
on conflict (slug) do nothing;

insert into public.room_state (room_id)
select id from public.rooms where slug = 'main'
on conflict (room_id) do nothing;
