# 🎬 OurCinema — Your private cinema.

İki kişinin farklı cihazlardan aynı videoyu **gerçek zamanlı senkronize** izleyebildiği, minimalist ve güvenli özel izleme odası.

- **Frontend:** React 18 + TypeScript + Vite + Tailwind CSS
- **Backend:** Supabase (Auth, PostgreSQL + RLS, Realtime Broadcast & Presence)
- **Video:** HTML5 `<video>`, hls.js (m3u8), YouTube IFrame API, Vimeo Player SDK, resmi Dailymotion/Twitch gömmeleri
- **Yayın:** Vercel

---

## 1. Mimari

```
┌──────────── Tarayıcı (Telefon / Bilgisayar) ────────────┐
│  LoginPage ──► AuthProvider (Supabase Auth, oturum)     │
│                    │                                    │
│  RoomPage ── useRoom (RLS ile oda/üye/durum okuma)      │
│     │                                                    │
│     ├─ VideoStage ─► Html5Player | YouTubePlayer |       │
│     │                VimeoPlayer | EmbedPlayer           │
│     │                (ortak PlayerController arayüzü)    │
│     │                                                    │
│     └─ SyncEngine ◄─► RoomChannel (private Realtime)    │
│           │             ├─ broadcast: play/pause/seek/load│
│           │             └─ presence: çevrimiçi kullanıcılar│
│           └─ room_state tablosuna kalıcı kayıt          │
└──────────────────────────────────────────────────────────┘
                     │  anon anahtar + kullanıcı JWT
┌──────────────────── Supabase ────────────────────────────┐
│ auth.users → profiles (tetikleyici)                       │
│ rooms · room_members (maks. 2) · room_state               │
│ RLS: yalnızca oda üyeleri okur/yazar                      │
│ realtime.messages RLS: yalnızca üyeler "room:<id>" kanalına│
└───────────────────────────────────────────────────────────┘
```

### Senkronizasyon nasıl çalışır?
1. Bir kullanıcı oynat/durdur/sar yaptığında **SyncEngine** komutu, sunucu saatine göre zaman damgasıyla (`sentAt`) özel kanala yayınlar ve `room_state` tablosuna kaydeder.
2. Karşı taraf komutu alır, ağ gecikmesini telafi ederek hedef saniyeyi hesaplar (`konum + (şimdi − sentAt)`), fark 0,75 sn'den büyükse sarar ve oynatır/durdurur.
3. Uzak komutun tetiklediği yerel olaylar 1,2 sn bastırılır → yankı döngüsü olmaz.
4. Son komutu veren kullanıcı ("lider") oynatırken 4 sn'de bir konum yayınlar; diğer taraf 1,5 sn'den fazla kayarsa düzeltilir.
5. Sonradan katılan kullanıcı önce veritabanındaki durumu uygular, ardından karşı taraftan **canlı durumu** ister.
6. İstemci saat farkı `server_time()` RPC'si ile ölçülür; cihaz saatleri farklı olsa da hesap doğru kalır.
7. Mobilde otomatik oynatma engellenirse "Oynatmayı başlatmak için dokunun" katmanı gösterilir; dokununca doğru saniyeden başlar.

### Klasör yapısı
```
ourcinema/
├─ supabase/
│  ├─ migrations/20261109000000_ourcinema_init.sql   # tablolar, RLS, Realtime yetkileri, oda
│  └─ add_members.sql                                # iki kullanıcıyı odaya ekleme
├─ src/
│  ├─ lib/            env.ts (anahtar güvenlik kontrolü), supabase.ts, rememberStorage.ts
│  ├─ components/     Brand, Spinner, CenteredCard, ConfigError, ErrorBoundary
│  ├─ features/
│  │  ├─ auth/        AuthProvider, LoginPage, authErrors
│  │  ├─ player/      detectSource, VideoStage, UrlBar, Html5/YouTube/Vimeo/Embed oynatıcılar
│  │  ├─ sync/        SyncEngine, serverClock, roomStateRepo, mesaj tipleri + doğrulama
│  │  ├─ realtime/    RoomChannel (broadcast + presence)
│  │  └─ room/        RoomPage, TopBar, PresenceBar, StatusLine, useRoom
│  ├─ types/youtube.d.ts
│  └─ utils/format.ts
├─ vercel.json        # SPA yönlendirme + güvenlik başlıkları (CSP vb.)
└─ .env.example
```

---

## 2. Desteklenen bağlantılar

| Kaynak | Örnek | Senkronizasyon |
|---|---|---|
| MP4 / WebM / MOV dosyası | `https://…/film.mp4` | ✅ Tam |
| HLS yayını | `https://…/index.m3u8` | ✅ Tam (sunucu CORS izni vermeli) |
| YouTube | `youtube.com/watch?v=…`, `youtu.be/…`, `/shorts/…` | ✅ Tam |
| Vimeo | `vimeo.com/123456`, gizli: `vimeo.com/123/abc` | ✅ Tam |
| Dailymotion | `dailymotion.com/video/…` | ⚠️ Yalnızca gömme (video ikinize de açılır, oynatma manuel) |
| Twitch | kanal, `/videos/…`, klip | ⚠️ Yalnızca gömme |
| Netflix, Disney+, Prime, Max, BluTV, Exxen, Gain, TOD, tabii, puhutv, MUBI… | — | ❌ DRM korumalı; açıklayıcı mesaj + "Kaynak sitesinde aç" |
| Diğer sayfalar (dizi siteleri vb.) | — | ❌ Açıklama + "Kaynak sitesinde aç" / "Video dosyası olarak dene" |

> **Bilinçli sınırlama:** DRM, CORS, erişim kontrolü veya platform güvenliğini aşmaya yönelik hiçbir yöntem (video çıkarma, proxy, indirme) yoktur. Yalnızca platformların resmi gömme/oynatıcı API'leri kullanılır. Kontrol API'si olmayan gömmelerde tam senkronizasyon varmış gibi gösterilmez; durum satırında açıkça belirtilir.

---

## 3. Kurulum (adım adım)

### 3.1 Supabase projesi
1. <https://supabase.com> → **New project**.
2. **SQL Editor** → `supabase/migrations/20261109000000_ourcinema_init.sql` içeriğini yapıştırıp **Run**.
   (Supabase CLI kullanıyorsanız: `supabase link` → `supabase db push`.)
3. **Authentication → Users → Add user → Create new user**: iki hesabı oluşturun, **Auto Confirm User** işaretli olsun.
4. `supabase/add_members.sql` dosyasındaki e-posta ve isimleri değiştirip SQL Editor'da çalıştırın. Son sorgu iki satır döndürmelidir.
5. **Authentication → Sign In / Providers → "Allow new users to sign up" KAPALI** (kimse kendi hesap açamaz).
6. **Realtime → Settings → "Allow public access" KAPALI** (yalnızca yetkili private kanallar çalışır).
7. **Project Settings → API**: `Project URL` ve **anon / publishable** anahtarını kopyalayın.

> ⚠️ `service_role` / `secret` anahtarını asla frontend'e koymayın. Uygulama bunu algılarsa çalışmayı reddeder.

### 3.2 Yerelde çalıştırma
```bash
npm install
cp .env.example .env        # değerleri doldurun
npm run dev                 # http://localhost:5173
```
Telefonla aynı Wi-Fi'dan test için terminalde görünen `Network:` adresini açın. (Not: mobil tarayıcılarda bazı özellikler yalnızca HTTPS'te tam çalışır; gerçek mobil testi Vercel adresinde yapın.)

### 3.3 Vercel'de yayınlama
1. Projeyi bir GitHub deposuna gönderin.
2. <https://vercel.com/new> → depoyu içe aktarın (Framework: **Vite** otomatik algılanır).
3. **Environment Variables**: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.
4. **Deploy**. `vercel.json` SPA yönlendirmesini ve güvenlik başlıklarını (CSP, HSTS, X-Frame-Options…) ekler.
5. Alternatif: `npm i -g vercel && vercel --prod`.

---

## 4. Test kontrol listesi (Aşama 10)
- [ ] Hatalı şifre → "E-posta veya şifre hatalı."; internet kapalı → bağlantı mesajı.
- [ ] "Beni hatırla" kapalıyken sekme kapatılınca oturum düşüyor.
- [ ] İki cihazda giriş → üstte iki yeşil nokta, `2/2 çevrimiçi`. Biri çıkınca gri.
- [ ] MP4 bağlantısı → diğer cihazda da açılıyor; oynat/durdur/sar ≤1 sn içinde eşleşiyor.
- [ ] YouTube ve Vimeo için aynı testler.
- [ ] Oynarken üçüncü sekmeden/sonradan giriş → doğru saniyeden devam (gerekirse "dokunun" katmanı).
- [ ] iPhone Safari & Android Chrome: tam ekran, dokunarak başlatma, dikey/yatay düzen.
- [ ] Netflix bağlantısı → DRM açıklaması; rastgele dizi sayfası → açıklama + kaynak bağlantısı.
- [ ] Uçak modu aç/kapat → "yeniden bağlanılıyor" → otomatik eşitleme.
- [ ] Twitch/Dailymotion → "senkronize edilmez" uyarısı görünüyor.

## 5. Güvenlik kontrolleri (Aşama 11)
- Tüm tablolarda **RLS açık**; `anon` rolünün hiçbir tabloya yetkisi yok.
- `room_members` için istemci yazma politikası **yok** → üyelik yalnızca SQL ile verilir; tetikleyici odayı **2 kişiyle sınırlar**.
- `room_state.updated_by/updated_at` sunucu tetikleyicisiyle damgalanır (taklit edilemez); yalnızca `https://` URL kabul edilir.
- Realtime kanalları **private**; `realtime.messages` RLS'i yalnızca oda üyelerinin `room:<oda-id>` kanalında yayın/presence yapmasına izin verir.
- Gelen her Realtime mesajı istemcide şema doğrulamasından geçer.
- Frontend yalnızca anon anahtar kullanır; secret anahtar tespit edilirse uygulama durur.
- CSP yalnızca gereken oynatıcı alan adlarına iframe/script izni verir; `frame-ancestors 'none'` ile clickjacking engellenir.

Doğrulama (SQL Editor, giriş yapmamış rol ile):
```sql
set role anon; select * from public.room_state; -- 0 satır / yetki hatası
reset role;
```

## 6. Bilinen teknik sınırlar ve alternatifler
| Engel | Neden | Güvenli alternatif |
|---|---|---|
| Netflix/Disney+/BluTV vb. oynatılamaz | DRM + gömme yasağı | Her iki taraf videoyu kendi hesabından açar; platformun kendi "birlikte izle" özelliği varsa o kullanılır |
| Bazı m3u8/mp4 bağlantıları açılmaz | Sunucu CORS veya hotlink koruması | Kendi depolama alanınıza (ör. Supabase Storage, Cloudflare R2) yüklediğiniz ve izniniz olan dosyaları kullanın |
| YouTube "yerleştirme devre dışı" videoları | Video sahibinin tercihi | YouTube'da açma bağlantısı gösterilir |
| Dailymotion/Twitch tam senkronize değil | Kontrol API'si kullanılmıyor | Durum satırında açıkça belirtilir; manuel başlatma |
| Mobilde ilk oynatma dokunuş ister | Tarayıcı otomatik oynatma politikası | "Dokunun" katmanı doğru saniyeden başlatır |
