-- =====================================================================
-- OurCinema – iki kullanıcıyı özel odaya ekleme (yönetici işlemi)
-- 1) Önce Supabase > Authentication > Users > "Add user" ile iki hesabı
--    oluşturun ("Auto Confirm User" işaretli).
-- 2) Aşağıdaki e-posta ve isimleri değiştirip SQL Editor'da çalıştırın.
-- =====================================================================

-- Görünen isimler
update public.profiles p
set display_name = 'Duhan'
from auth.users u
where u.id = p.id and lower(u.email) = lower('SENIN-EPOSTAN@ornek.com');

update public.profiles p
set display_name = 'Sevgilim'
from auth.users u
where u.id = p.id and lower(u.email) = lower('ONUN-EPOSTASI@ornek.com');

-- Odaya üyelik (oda en fazla 2 kişiyi kabul eder)
insert into public.room_members (room_id, user_id)
select r.id, u.id
from public.rooms r
cross join auth.users u
where r.slug = 'main'
  and lower(u.email) in (lower('SENIN-EPOSTAN@ornek.com'), lower('ONUN-EPOSTASI@ornek.com'))
on conflict do nothing;

-- Kontrol
select p.display_name, u.email
from public.room_members m
join public.profiles p on p.id = m.user_id
join auth.users u on u.id = m.user_id;
