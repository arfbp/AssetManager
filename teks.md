# Panduan Menjalankan OptiFleet-AI (Server & Agent) di Linux

Dokumen ini berisi rincian lengkap mengenai dependensi, cara instalasi, serta cara menjalankan Central Server dan Background Agent di lingkungan Linux.

---

## 1. OptiFleet Central Server (Node.js / TypeScript)

Server pusat berfungsi sebagai WebSocket hub, HTTP API untuk dashboard, penjelajah perintah bahasa alami (LLM via Groq), dan *security guardrail*.

### A. Dependensi Sistem
* **Node.js** (Versi 20+ disarankan)
* **Bun** atau **npm** (Proyek menggunakan `bun.lock` di dalam folder `server/`, tetapi bisa menggunakan npm/bun)
* **PostgreSQL** (Database untuk menyimpan data organisasi, audit, dan state perangkat)

### B. Cara Install & Konfigurasi Server
1. Masuk ke direktori server:
   ```bash
   cd server
   ```
2. Instal dependensi:
   ```bash
   bun install
   # atau menggunakan npm:
   npm install
   ```
3. Buat file konfigurasi `.env` di dalam folder `server/` (sesuaikan dengan template atau environment Anda):
   ```env
   PORT=3000
   DATABASE_URL="postgres://user:password@localhost:5432/optifleet"
   OPTIFLEET_HMAC_SECRET="shared_secret_yang_sama_dengan_agent"
   GROQ_API_KEY="gsk_..."
   ```
4. Jalankan migrasi database:
   ```bash
   bun run db:migrate
   # atau jika pakai npm:
   npm run db:migrate
   ```

### C. Cara Menjalankan Server
* **Mode Development (Watch mode):**
  ```bash
  npm run dev
  ```
* **Mode Production:**
  Build terlebih dahulu kode TypeScript-nya, lalu jalankan:
  ```bash
  npm run build
  npm start
  ```

---

## 2. Cara Menjalankan Server di aaPanel (Node Project)

**Bisa sekali.** aaPanel memiliki fitur bawaan **Node project** yang menggunakan Node Version Manager / PM2 untuk manajemen proses, auto-restart, dan reverse proxy Nginx.

### A. Persiapan di aaPanel
1. **Node.js Version Manager**: Buka menu **App Store** di aaPanel, cari dan pasang **Node.js Version Manager**. Pasang Node.js versi LTS terbaru (minimal **v20.x**).
2. **Database PostgreSQL**: Pasang PostgreSQL dari App Store aaPanel (atau gunakan PostgreSQL instance eksternal/server lokal). Buat database baru (misal: `optifleet_db`) beserta user & password-nya.
3. **Web Server**: Pastikan **Nginx** sudah terpasang di aaPanel untuk menangani SSL dan Reverse Proxy.

### B. Upload & Build Proyek di aaPanel
1. Letakkan folder proyek di path web aaPanel, misalnya `/www/wwwroot/optifleet/`.
2. Buka **Terminal** di aaPanel, lalu masuk ke direktori `server`:
   ```bash
   cd /www/wwwroot/optifleet/server
   ```
3. Buat file `.env`:
   ```bash
   cp config/agent-config-template.yaml config/agent-config.yaml # jika dibutuhkan
   nano .env
   ```
   Isi konfigurasi `.env`:
   ```env
   PORT=3000
   DATABASE_URL="postgres://username:password@127.0.0.1:5432/optifleet_db"
   OPTIFLEET_HMAC_SECRET="masukkan_random_secret_panjang_disini"
   GROQ_API_KEY="gsk_..."
   ```
4. Install dependensi, jalankan migrasi database, dan build TypeScript:
   ```bash
   npm install
   npm run db:migrate
   npm run build
   ```
   *(Hasil build akan berada di direktori `server/dist/index.js`)*

### C. Menambahkan Node Project di aaPanel
1. Buka menu **Website** -> tab **Node project** -> klik **Add Node project**.
2. Isi form konfigurasi sebagai berikut:
   * **Project directory**: `/www/wwwroot/optifleet/server`
   * **Project name**: `optifleet-server`
   * **Run opt**: Pilih **File** dan arahkan ke `dist/index.js` (atau pilih **start** script).
   * **Port**: `3000` (sesuaikan dengan nilai `PORT` di `.env`).
   * **Node version**: Pilih versi **v20.x** yang sudah dipasang.
   * **Run user**: `www`
   * **Domain**: Masukkan domain/subdomain yang ingin Anda gunakan (misal: `api.domainanda.com`).
3. Klik **Submit**. aaPanel akan otomatis menjalankan server menggunakan PM2.

### D. PENTING: Konfigurasi Nginx untuk WebSocket di aaPanel
Karena OptiFleet menggunakan koneksi WebSocket (`wss://`) untuk komunikasi real-time antara server dan agent, **Nginx wajib dikonfigurasi agar mendukung WebSocket Upgrade Header**.

1. Masuk ke menu **Website** -> **Node project** -> klik nama project Anda / klik **Settings** pada domain tersebut.
2. Buka tab **Config** (atau tab **Reverse proxy** -> Edit Reverse Proxy).
3. Pastikan blok `location /` memiliki konfigurasi header WebSocket berikut:
   ```nginx
   location / {
       proxy_pass http://127.0.0.1:3000;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
       
       # Supaya koneksi WebSocket jangka panjang tidak cepat timeout
       proxy_read_timeout 86400s;
       proxy_send_timeout 86400s;
   }
   ```
4. Simpan konfigurasi.
5. Buka tab **SSL** di settings domain aaPanel dan aktifkan **Let's Encrypt** agar agent dapat terhubung secara aman melalui `wss://`.

---

## 3. OptiFleet AI Agent (Go)

Agent berjalan di setiap perangkat target sebagai *background service* yang bertugas mengumpulkan telemetry, melakukan self-healing, dan mendengarkan perintah terenkripsi dari server via WebSocket.

### A. Dependensi Sistem
* **Go** (Versi 1.21+ atau terbaru)

### B. Cara Build Agent (Di Linux)
1. Masuk ke root direktori proyek (`OptiFleet-AI/`):
   ```bash
   cd /path/to/OptiFleet-AI
   ```
2. Lakukan build binary agent tanpa CGO dengan flag optimasi ukuran (`-s -w`):
   ```bash
   mkdir -p bin
   CGO_ENABLED=0 go build -ldflags "-s -w" -o bin/optifleet-agent ./cmd/agent
   ```
   Binary hasil build akan tersimpan di `bin/optifleet-agent`.

### C. Cara Install & Menjalankan Agent di Linux (Systemd)
Sebelum menjalankan service, pastikan environment variables yang wajib untuk keamanan (*secrets*) sudah diatur. **Jangan pernah menyimpan token rahasia di dalam file `agent.yaml`.**

1. Set environment variables (atau masukkan ke systemd service file):
   ```bash
   export OPTIFLEET_AUTH_TOKEN="token_dari_server"
   export OPTIFLEET_HMAC_SECRET="shared_secret_yang_sama_dengan_server"
   ```
2. Daftarkan agent sebagai systemd service (harus menggunakan hak akses `sudo`):
   ```bash
   sudo ./bin/optifleet-agent -service install -config configs/agent.yaml
   ```
3. Jalankan service:
   ```bash
   sudo ./bin/optifleet-agent -service start -config configs/agent.yaml
   ```

### D. Perintah Pengelolaan Service Agent
* **Cek Status:**
  ```bash
  sudo systemctl status OptiFleetAIAgent
  ```
* **Melihat Log Agent:**
  ```bash
  sudo journalctl -u OptiFleetAIAgent -f
  ```
* **Menghentikan Service:**
  ```bash
  sudo ./bin/optifleet-agent -service stop -config configs/agent.yaml
  ```
* **Uninstall Service:**
  ```bash
  sudo ./bin/optifleet-agent -service uninstall -config configs/agent.yaml
  ```
