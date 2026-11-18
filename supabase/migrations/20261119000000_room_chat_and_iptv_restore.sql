-- Durable room chat. Access is limited to authenticated members of the room.
create table if not exists public.room_chat_messages (
  id         uuid primary key default gen_random_uuid(),
  room_id    uuid not null references public.rooms (id) on delete cascade,
  user_id    uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  content    text not null check (char_length(content) between 1 and 1000),
  created_at timestamptz not null default now(),
  constraint room_chat_messages_content_not_blank check (length(trim(content)) > 0)
);

create index if not exists room_chat_messages_room_created_idx
  on public.room_chat_messages (room_id, created_at desc);

-- Keep the room's IPTV selection without storing provider stream URLs.
alter table public.room_state
  add column if not exists iptv_channel_id text,
  add column if not exists iptv_content_type text,
  add column if not exists iptv_series_id text,
  add column if not exists iptv_episode_id text;

alter table public.room_state
  drop constraint if exists room_state_iptv_selection_check;
alter table public.room_state
  add constraint room_state_iptv_selection_check check (
    (iptv_channel_id is null or char_length(iptv_channel_id) between 1 and 256)
    and (iptv_content_type is null or iptv_content_type in ('live', 'movie', 'series'))
    and (iptv_series_id is null or iptv_series_id ~ '^\d{1,64}$')
    and (iptv_episode_id is null or iptv_episode_id ~ '^\d{1,64}$')
  );

grant insert (iptv_channel_id, iptv_content_type, iptv_series_id, iptv_episode_id)
  on public.room_state to authenticated;
grant update (iptv_channel_id, iptv_content_type, iptv_series_id, iptv_episode_id)
  on public.room_state to authenticated;

alter table public.room_chat_messages enable row level security;
revoke all on public.room_chat_messages from anon, authenticated;
grant select on public.room_chat_messages to authenticated;
grant insert (room_id, content) on public.room_chat_messages to authenticated;

drop policy if exists "room_chat_select_members" on public.room_chat_messages;
create policy "room_chat_select_members" on public.room_chat_messages
  for select to authenticated
  using (public.is_room_member(room_id));

drop policy if exists "room_chat_insert_members" on public.room_chat_messages;
create policy "room_chat_insert_members" on public.room_chat_messages
  for insert to authenticated
  with check (
    public.is_room_member(room_id)
    and user_id = auth.uid()
    and length(trim(content)) between 1 and 1000
  );
