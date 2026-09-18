# Deploy rehberi

QR-VCard tek bir konteyner olarak çalışır: arayüz, `/api/*` ve QR görselleri tek
portta (8080) sunulur. Tarayıcı Directus'a hiç bağlanmaz; Directus bilgileri yalnızca
sunucu tarafındaki ortam değişkenlerindedir. **Derleme sırasında hiçbir değişken
gerekmez** — aynı imaj her Directus ile çalışır.

Konteyner her açılışta sırasıyla şunları yapar:

1. **Değişkenleri doğrular.** Eksik, hatalı ya da şablonda kalmış değer varsa hangi
   değişkenin düzeltileceğini tek satırda yazar ve durur.
2. **Directus'u bekler.** `DIRECTUS_WAIT_SECONDS` (varsayılan 120 sn) boyunca
   `/server/ping` yanıt verene kadar dener; Directus yeni açılıyorsa çökme döngüsüne
   girmez.
3. **Token'ı kontrol eder.** Geçerli mi, Administrator yetkisi var mı.
4. **Şemayı kurar/onarır.** Koleksiyonlar, alanlar, roller ve izinler boş bir
   Directus'ta oluşturulur, eskisinde tamamlanır. Tekrar tekrar çalışması güvenlidir;
   geçici hatada 3 kez dener. Demo veri oluşturmaz.
5. **Sunucuyu başlatır.** `docker stop` / yeniden deploy'da açık istekleri bitirip
   temiz kapanır.

## Hangi yolu seçmeli?

| Durum | Yol |
|---|---|
| Directus'unuz zaten var (en yaygın) | **A** — Coolify/Railway (Nixpacks veya Dockerfile) ya da `docker compose up` |
| Her şey tek sunucuda, sıfırdan | **B** — `docker-compose.full.yml` (PostgreSQL + Directus + uygulama) |

## Ortam değişkenleri

Tam liste ve açıklamalar: [`.env.example`](../.env.example).

| Değişken | Gerekli | Açıklama |
|---|---|---|
| `DIRECTUS_URL` | **evet** | Directus adresi — *uygulama sunucusunun* eriştiği adres. Konteyner içinde `localhost` konteynerin kendisidir; domain veya Docker servis adı (`http://directus:8055`) kullanın. |
| `DIRECTUS_TOKEN` | **evet** | Administrator rolündeki bir Directus kullanıcısının statik token'ı. |
| `SESSION_SECRET` | önerilir | Oturum çerezi imza anahtarı, en az 16 karakter: `openssl rand -hex 32`. Boşsa token'dan türetilir (token değişince herkes çıkış yapar). |
| `PUBLIC_URL` | önerilir | Uygulamanın herkese açık adresi, ör. `https://kart.alanadiniz.com` (sonunda yol olmadan). QR kodları `PUBLIC_URL/c/<kod>` adresini taşır. |
| `TRUST_PROXY` | proxy arkasında `1` | Coolify/Traefik, Railway, nginx, Cloudflare arkasında `1`. Aksi hâlde tüm ziyaretçiler tek bir hız sınırı kovasını paylaşır ve giriş denemeleri birbirini kilitler. |
| `QR_API_KEY` | isteğe bağlı | Sanatsal QR sağlayıcı anahtarı. Yoksa standart QR kodları yerelde üretilir. |
| `DIRECTUS_BOOTSTRAP` | isteğe bağlı | `1` (varsayılan) her açılışta şemayı kurar/onarır. `0`: şemayı ayrıca yönetiyorsanız. |
| `DIRECTUS_WAIT_SECONDS` | isteğe bağlı | Açılışta Directus için bekleme süresi, varsayılan `120`. |
| `MAX_CARDS_PER_USER` | isteğe bağlı | Standart kullanıcı başına kart sınırı, varsayılan `20`. |
| `QRV_TZ` | isteğe bağlı | Panel istatistiklerinin gün sınırı için saat dilimi, ör. `Europe/Istanbul` (varsayılan `UTC`). |
| `PORT` | isteğe bağlı | Dinlenen port; imajda `8080`. Platformlar genelde kendisi verir. |

### Directus token'ı nasıl alınır?

Directus Studio → **User Directory** → Administrator rolündeki kullanıcı (kendi admin
hesabınız olabilir) → **Token** alanında oluştur → **Save**. Kaydetmeden çıkarsanız
token geçerli olmaz.

Kendi admin hesabınızın token'ını kullanabilirsiniz: bu hesapla QR-VCard paneline de
giriş yaparsınız. Uygulamayı çalıştıran hesap olduğu için panelden **silinemez, askıya
alınamaz ve rolü düşürülemez** (uygulama kendini kilitlemesin diye). İsterseniz
şifresiz ayrı bir servis kullanıcısı açıp onun token'ını da verebilirsiniz; o hesap
panelde görünmez.

## A) Mevcut Directus ile

### Coolify

1. **New Resource → Application →** Git deposunu seçin.
2. Build Pack: **Nixpacks** (depodaki `nixpacks.toml` kullanılır) veya **Dockerfile**.
   İkisi de aynı sonucu verir; Dockerfile derlemesi daha küçük imaj üretir.
3. **Ports Exposes:** `8080`.
4. **Environment Variables:** `DIRECTUS_URL`, `DIRECTUS_TOKEN`, `SESSION_SECRET`,
   `PUBLIC_URL`, `TRUST_PROXY=1` (ve isterseniz `QR_API_KEY`). Hiçbiri "Build
   Variable" olmak zorunda değildir.
5. **Health Check:** yol `/healthz`, port `8080`.
6. Domain'i verip **Deploy**. Loglarda `[startup] Directus reachable`,
   `DIRECTUS_TOKEN accepted` ve `[app] serving` satırlarını görmelisiniz.
7. `PUBLIC_URL/panel` adresinden Directus admin e-posta/şifrenizle giriş yapın.

### Railway

Depoyu bağlayın; `nixpacks.toml` otomatik kullanılır. Değişkenleri **Variables**
sekmesine girin (`TRUST_PROXY=1` dahil), health check yolu `/healthz`.

### Docker Compose (kendi sunucunuz)

```bash
cp .env.example .env         # değerleri doldurun
npm run doctor               # isteğe bağlı: .env'i ve Directus bağlantısını sınar (Node 22+ gerekir)
docker compose up -d --build # http://sunucu:8080  (host portu: APP_PORT)
docker compose logs -f app
```

### Yalnızca Docker

```bash
docker build -t qr-vcard .
docker run -d --name qr-vcard --restart unless-stopped -p 8080:8080 --env-file .env qr-vcard
```

## B) Her şey tek yığında (PostgreSQL + Directus + uygulama)

```bash
cp .env.full.example .env    # her değeri doldurun (openssl rand -hex 32)
docker compose -f docker-compose.full.yml up -d --build
```

- İlk açılışta Directus, `DIRECTUS_ADMIN_EMAIL` / `DIRECTUS_ADMIN_PASSWORD` ile admin
  hesabını ve bu hesaba `DIRECTUS_TOKEN` token'ını tanımlar; uygulama aynı token ile
  şemayı kurar. Panele bu e-posta ve şifreyle girersiniz.
- `DIRECTUS_TOKEN` yalnızca **ilk** açılışta Directus'a yazılır. Sonradan `.env`'de
  değiştirmek Directus'taki token'ı değiştirmez; değiştirecekseniz önce Studio'dan
  admin kullanıcının token'ını güncelleyin.
- Directus Studio `DIRECTUS_PORT` (varsayılan 8055) üzerinden açıktır; dışarı
  açmak istemiyorsanız compose dosyasındaki `ports` satırını silin.
- Veriler `postgres_data` ve `directus_uploads` volume'lerindedir.

Coolify'da bu yol için Build Pack olarak **Docker Compose** seçip dosya yolunu
`docker-compose.full.yml` yapın; değişkenleri Coolify arayüzüne girin.

## Deploy sonrası kontrol

| Kontrol | Beklenen |
|---|---|
| `GET /healthz` | `{"ok":true,…,"sha":"<commit>"}` — süreç ayakta |
| `GET /api/health` | `{"ok":true,"directus":"ok","token":"valid"}` — Directus bağlantısı ve token |
| `/panel` | giriş ekranı; admin hesabıyla giriş |

Tam otomatik doğrulama (giriş, kullanıcı izolasyonu, Directus kilidi, QR):

```bash
SMOKE_BASE_URL=https://kart.alanadiniz.com PANEL_EMAIL=... PANEL_PASSWORD=... \
USER_EMAIL=... USER_PASSWORD=... DIRECTUS_URL=https://directus.alanadiniz.com npm run smoke
```

## Sorun giderme

Konteyner açılmıyorsa loglardaki `[startup] ERROR:` satırı nedeni ve çözümü yazar:

| Log | Çözüm |
|---|---|
| `… still holds the template value` | `.env.example`'daki örnek değer kalmış; gerçeğini girin. |
| `Directus at … did not answer within 120s` | `DIRECTUS_URL` yanlış ya da Directus kapalı. Konteyner içinden `localhost` kullanılmaz. |
| `Directus rejected DIRECTUS_TOKEN` | Token yanlış veya Studio'da **Save** yapılmamış. |
| `… lacks Administrator access` | Token'ın kullanıcısı Administrator rolünde değil. Rolü değiştirin ya da şemayı ayrıca yönetiyorsanız `DIRECTUS_BOOTSTRAP=0`. |
| `SESSION_SECRET must be at least 16 characters` | `openssl rand -hex 32` çıktısını kullanın. |
| Girişte sık sık "çok fazla deneme" | Proxy arkasındasınız: `TRUST_PROXY=1`. Sunucu bu durumu logda da uyarır. |

Yedekleme ve geri yükleme: [`backup-restore.md`](backup-restore.md).
