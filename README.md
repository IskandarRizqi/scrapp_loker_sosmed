<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/ebd2ad58-fa28-41c5-a6c3-81e6807afac7

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## Fitur Facebook (Scraper Grup dengan Playwright)

Kartu **Facebook** di dashboard menggunakan otomasi browser (Playwright + Chromium) untuk:
login ke akun Facebook Anda, lalu membuka link grup yang ditempel di UI, menggulir feed
secara otomatis, dan mengambil loker (teks + gambar poster dianalisis AI) sesuai rentang hari.
Hasilnya bisa di-export ke Excel dengan format yang sama seperti card OCR.

- **Login sekali:** klik "Login ke Facebook" → jendela Chromium terbuka → selesaikan login di
  jendela itu (termasuk 2FA/CAPTCHA). Sesi disimpan ke `facebook-session.json`.
- **File sesi berisi kredensial** — sudah masuk `.gitignore`, jangan pernah di-commit.
- **Berjalan lokal/VM.** Saat di-deploy ke server ephemeral (mis. Cloud Run), sesi login tidak
  persisten dan browser otomasi tidak berjalan; fitur ini paling andal saat app dijalankan
  di komputer/VM Anda sendiri. Untuk memulai: `npm install && npx playwright install chromium`.
