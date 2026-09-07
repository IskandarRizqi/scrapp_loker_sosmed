import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'fs';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, Type } from '@google/genai';
import dotenv from 'dotenv';
import { chromium } from 'playwright';
import { isDeadlineExpired, formatDateLabel, parseDiscoveryDate } from './src/utils/deadline';
import { expandPositions, positionTitles, countTotalPositions } from './src/utils/positions';

// Load .env.local first (local secrets), then fall back to .env
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const GEMINI_MODEL = 'gemini-3.6-flash';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Neutral UA for r.jina.ai (a full browser UA triggers Cloudflare's bot challenge -> 403)
const JINA_USER_AGENT = 'node';

// r.jina.ai public reader proxy config (free tier, rate-limited ~20 RPM / IP)
const JINA_READER_BASE = process.env.JINA_READER_BASE_URL || 'https://r.jina.ai';
// Max discovery queries per run + delay between them + how many DDG result pages to fetch.
// Tune these via .env if you hit rate limits or want an even wider crawl.
// (Dinaikkan karena user minta akun IG "sebanyak banyaknya" — kini ~80+ akun di
// loker-sources.json, masing-masing 2 query; budget jina juga dinaikkan supaya akun
// yang baru ditambahkan benar-benar ikut dipindai, bukan tersingkir oleh query limit.)
const DISCOVERY_QUERY_LIMIT = Math.max(1, Number(process.env.DISCOVERY_QUERY_LIMIT) || 180);
const DISCOVERY_DELAY_MS = Math.max(0, Number(process.env.DISCOVERY_DELAY_MS) || 1500);
const DISCOVERY_CONCURRENCY = Math.max(1, Number(process.env.DISCOVERY_CONCURRENCY) || 3);
const DISCOVERY_MAX_PAGES = Math.max(1, Number(process.env.DISCOVERY_MAX_PAGES) || 2);
const DISCOVERY_MAX_JINA_REQUESTS = Math.max(1, Number(process.env.DISCOVERY_MAX_JINA_REQUESTS) || 200);
const ANALYZE_CONCURRENCY = Math.max(1, Number(process.env.ANALYZE_CONCURRENCY) || 8);
const SCAN_SOURCES_FILE = process.env.SCAN_SOURCES_FILE || 'loker-sources.json';
const MAX_SLIDES = 12;
// Langkah AI kedua (per-position refinement): ketika ekstraksi awal menghasilkan <= 1 entri
// positions, Gemini diminta membaca ULANG semua slide + caption untuk mendaftar SATU entri per
// posisi (jangan menggabungkan) berikut jobspek/jobdesk uniknya. Set false untuk mematikan.
const POSITION_REFINE = process.env.POSITION_REFINE !== 'false';
// Auto-scan Instagram HANYA menerima lembaga BPR / Koperasi / LPD (bank BPR syariah
// termasuk). Bank umum/BUMN/Persero/BPD/bank umum syariah (BSI), Pegadaian, Asuransi,
// dan Fintech/Pembiayaan DITOLAK sebagai NON-BPR.
const ALLOWED_INSTITUTION_RE =
  /\b(?:bprs?|bank (?:perekonomian|perkreditan) rakyat|koperasi|ksp|usp|lpd|perkreditan desa|lembaga perkreditan desa)\b/i;
// Max Facebook search queries per whole-FB auto-scan run (each query = one search feed scroll).
const FB_SEARCH_QUERY_LIMIT = Math.max(1, Number(process.env.FB_SEARCH_QUERY_LIMIT) || 5);
// Max groups crawled per search query (group feeds are the richest source of posts).
const FB_GROUP_CRAWL_LIMIT = Math.max(1, Number(process.env.FB_GROUP_CRAWL_LIMIT) || 3);
// Global time budget for the whole-FB auto-scan collection phase.
const FB_RUN_BUDGET_MS = Math.max(1, Number(process.env.FB_RUN_BUDGET_MS) || 25 * 60 * 1000);
// Banking / financial-sector terms used to rank groups and pre-filter collected posts.
const FB_BANKING_TERM_RE =
  /bpr|bank|koperasi|simpan\s*pinjam|perbankan|lembaga\s*keuangan|pegadaian|asuransi|kredit|pinjaman|syariah|fintech/i;

// Twitter/X auto-scan: waktu maksimal koleksi tweet per run (auto-scroll) + jumlah scroll
// berturut-turut tanpa tweet baru yang mentolerir sebelum dianggap selesai.
const TWITTER_SCAN_BUDGET_MS = Math.max(1, Number(process.env.TWITTER_SCAN_BUDGET_MS) || 4 * 60 * 1000);
const TWITTER_SCROLL_STALL_LIMIT = Math.max(1, Number(process.env.TWITTER_SCROLL_STALL_LIMIT) || 4);

// Threads auto-scan: waktu maksimal koleksi post per profil (auto-scroll) + jumlah scroll
// berturut-turut tanpa post baru yang mentolerir sebelum dianggap selesai.
const THREADS_SCAN_BUDGET_MS = Math.max(1, Number(process.env.THREADS_SCAN_BUDGET_MS) || 4 * 60 * 1000);
const THREADS_SCROLL_STALL_LIMIT = Math.max(1, Number(process.env.THREADS_SCROLL_STALL_LIMIT) || 4);

// Scraper Ingestion API: menerima hasil scraping lowongan ke draft database.
// SCRAPER_API_KEY kosong => pengiriman dilewati (log warning), tanpa merusak alur batch/Excel.
const SCRAPER_API_URL =
  process.env.SCRAPER_API_URL || 'https://bankiracademy.co.id/api/v1/scraper/loker-draft';
const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY || '';

// WhatsApp Notification: kirim jumlah loker hasil run ke nomor WA tujuan via Merchant API.
// Kosong => notifikasi dilewati (log warning), tanpa mengganggu alur batch/Excel/API.
const WA_API_URL = process.env.WA_API_URL || '';
const WA_API_KEY = process.env.WA_API_KEY || '';
const WA_TO_NUMBER = process.env.WA_TO_NUMBER || '';

// Facebook auto-scan discovery (search-based) is disabled by default because every free
// access path is login-walled. The dedicated Facebook card instead uses a Playwright
// browser session (see "Facebook Group Scraper" below) to log in once and scroll real groups.
const FACEBOOK_ENABLED = process.env.FACEBOOK_ENABLED === 'true';

// Increase payload size limit for base64 screenshots / images
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// ----------------------------- Types (server-side) -----------------------------

type Platform = 'Instagram' | 'Facebook' | 'Twitter' | 'Threads';

interface ScannedPost {
  url: string;
  shortcode?: string;
  platform: Platform;
  caption?: string;
  username?: string;
  imageUrl?: string;
  sourceLabel: string;
  postDate?: string;
}

interface InlineImage {
  mimeType: string;
  data: string;
}

type ContentPart = { text?: string; inlineData?: InlineImage };

// ----------------------------- Helpers -----------------------------

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Helper to initialize Gemini SDK safely
function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY tidak ditemukan di environment variable.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

const VACANCY_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    isVacancy: { type: Type.BOOLEAN, description: 'Apakah konten ini berisi lowongan kerja' },
    confidenceScore: { type: Type.INTEGER, description: 'Skor keyakinan 0-100%' },
    detectionReason: { type: Type.STRING, description: 'Alasan mengapa dianggap loker atau bukan loker' },
    companyName: { type: Type.STRING, description: 'Nama Perusahaan / Instansi / Toko / Brand' },
    jobTitle: { type: Type.STRING, description: 'Nama Posisi / Jabatan Pekerjaan (jika banyak, isi dengan posisi pertama atau gabungan dipisah koma)' },
    positions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING, description: 'Nama posisi/jabatan (satu baris per posisi)' },
          summary: { type: Type.STRING, description: 'Ringkasan eksekutif khusus posisi ini (2-3 kalimat)' },
          responsibilities: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Jobdesk AI (tugas & tanggung jawab) khusus posisi ini. Dikembangkan AI jika tidak tertulis eksplisit. JANGAN KOSONGKAN.',
          },
          requirements: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Jobspek (syarat & kualifikasi) khusus posisi ini. Salin persis jika tertulis, jika tidak rangkum kebutuhan umum posisi ini. JANGAN KOSONGKAN.',
          },
          skills: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Keahlian/kompetensi khusus posisi ini. JANGAN KOSONGKAN (minimal 1).',
          },
        },
        required: ['title'],
      },
      description:
        'Daftar seluruh posisi/jabatan yang dibuka dalam lowongan ini. Jika postingan menyebut beberapa posisi (misal "Marketing, Credit Analyst, Collection"), pecah menjadi satu entri per posisi. Jika hanya satu posisi, isi array dengan satu entri.',
    },
    jobCategory: { type: Type.STRING, description: 'Kategori Pekerjaan (misal IT, Marketing, Admin, Design, Retail, dll)' },
    jobType: { type: Type.STRING, description: 'Tipe Pekerjaan (Full-Time, Part-Time, Freelance, Magang, Kontrak)' },
    workLocation: { type: Type.STRING, description: 'Lokasi Kerja (Kota, Wilayah, Remote, Hybrid)' },
    salaryInfo: { type: Type.STRING, description: 'Informasi Gaji atau Kompensasi' },
    requirements: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Daftar syarat & kualifikasi pelamar',
    },
    responsibilities: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Daftar tugas & tanggung jawab kerja',
    },
    howToApply: { type: Type.STRING, description: 'Instruksi cara mendaftar/melamar' },
    contactInfo: {
      type: Type.OBJECT,
      properties: {
        email: { type: Type.STRING, description: 'Email tujuan kirim CV' },
        phoneWhatsapp: { type: Type.STRING, description: 'Nomor WhatsApp / Kontak HRD' },
        websiteForm: { type: Type.STRING, description: 'Link formulir / web pendaftaran' },
        instagramDm: { type: Type.STRING, description: 'Username IG / DM info' },
        address: { type: Type.STRING, description: 'Alamat fisik / lokasi walk-in' },
      },
    },
    deadline: { type: Type.STRING, description: 'Batas akhir waktu pendaftaran' },
    rawOcrText: { type: Type.STRING, description: 'Transkrip lengkap seluruh teks terbaca dari poster/gambar' },
    description: { type: Type.STRING, description: 'Deskripsi lengkap lowongan dari caption postingan' },
    isBankingSector: { type: Type.BOOLEAN, description: 'Apakah lowongan ini berada di sektor Perbankan / Jasa Keuangan / Lembaga Keuangan' },
    summary: { type: Type.STRING, description: 'Ringkasan eksekutif lowongan kerja dalam 2-3 kalimat' },
    skills: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Daftar keahlian/kompetensi spesifik yang dikembangkan AI dari lowongan (contoh: Microsoft Office, SIM C, MS Excel, komunikasi). WAJIB diisi, jangan pernah kosong (minimal 1 keahlian)',
    },
    logoBox: {
      type: Type.OBJECT,
      nullable: true,
      properties: {
        x: { type: Type.NUMBER, description: 'Posisi X kiri-atas kotak logo, ternormalisasi 0-1' },
        y: { type: Type.NUMBER, description: 'Posisi Y kiri-atas kotak logo, ternormalisasi 0-1' },
        w: { type: Type.NUMBER, description: 'Lebar kotak logo, ternormalisasi 0-1' },
        h: { type: Type.NUMBER, description: 'Tinggi kotak logo, ternormalisasi 0-1' },
      },
      description: 'Kotak logo perusahaan/instansi pada gambar/screenshot (koordinat ternormalisasi 0-1 dari kiri-atas) atau null jika tidak ada logo yang jelas',
    },
    companyWebsite: { type: Type.STRING, description: 'Domain / situs web resmi perusahaan atau instansi jika disebutkan di poster/caption (contoh www.bprxyz.co.id). Kosongkan jika tidak ada' },
    logoUrl: { type: Type.STRING, description: 'URL langsung gambar logo perusahaan dari situs webnya (misal https://www.bprxyz.co.id/logo.png) jika diketahui/tertera. Kosongkan jika tidak ada' },
    adminAddress: {
      type: Type.OBJECT,
      nullable: true,
      properties: {
        province: { type: Type.STRING, description: 'Provinsi' },
        regency: { type: Type.STRING, description: 'Kota / Kabupaten' },
        district: { type: Type.STRING, description: 'Kecamatan' },
        village: { type: Type.STRING, description: 'Kelurahan / Desa' },
      },
      description: 'Alamat administratif yang dirangkum AI dari alamat/lokasi pada poster (Provinsi, Kota/Kabupaten, Kecamatan, Kelurahan) atau null jika tidak dapat ditentukan',
    },
    institutionType: {
      type: Type.STRING,
      description:
        'Jenis institusi tempat lowongan dibuka. PILIH SALAH SATU dari: "BPR" (Bank Perekonomian Rakyat, termasuk BPR Syariah/BPRS), "Koperasi" (Koperasi Simpan Pinjam/KSP/USP/koperasi desa/UMKM), "LPD" (Lembaga Perkreditan Desa), "Bank Umum" (termasuk Bank BUMN/Persero, BPD, bank swasta, bank umum syariah seperti BSI), "Pegadaian", "Asuransi", "Fintech / Pembiayaan" (pinjol, P2P lending, leasing, perusahaan pembiayaan), atau "Bukan Lembaga Keuangan".',
    },
  },
  required: [
    'isVacancy',
    'confidenceScore',
    'detectionReason',
    'companyName',
    'jobTitle',
    'jobCategory',
    'jobType',
    'workLocation',
    'salaryInfo',
    'requirements',
    'responsibilities',
    'howToApply',
    'contactInfo',
    'deadline',
    'rawOcrText',
    'description',
    'isBankingSector',
    'summary',
    'institutionType',
  ],
};

function buildSystemPrompt(
  sourceLabel: string,
  url?: string,
  fetchedMetaText?: string,
  focusKeyword?: string
) {
  return `Anda adalah Asisten AI Spesialis Pendeteksi & Ekstraktor Lowongan Kerja (Loker) dari media sosial (Instagram, Facebook, LinkedIn, TikTok).
Tugas utama Anda:
1. Analisis seluruh teks dan/atau gambar poster, screenshot postingan, screenshot sorotan (highlights), atau story Instagram/Facebook yang diberikan.
2. Deteksi apakah konten ini mengandung Informasi Lowongan Kerja (LOKER / Recruitment / Career Opportunity).
3. Jika YA (isVacancy = true), lakukan OCR secara presisi dan ekstrak detail lowongan kerja dengan lengkap & terstruktur.
4. Jika TIDAK (isVacancy = false), jelaskan mengapa konten ini bukan loker (misalnya: iklan produk biasa, kata mutiara, meme, promosi jasa, dll).

- Baca SELURUH teks caption postingan dengan saksama, bukan hanya baris pertama. Caption sering memuat cara melamar (misal "Apply melalui: email...", "kirim CV ke...", "subject email: ...", "cc: ...", link pendaftaran, nomor WhatsApp, alamat walk-in).
- Jika caption atau gambar memuat informasi cara melamar, ekstrak LENGKAP ke field howToApply dan contactInfo (email, phoneWhatsapp, websiteForm, instagramDm, address). Jangan pernah mengosongkan howToApply bila informasi itu ada di caption/gambar.
- Field description diisi teks deskripsi/caption postingan yang memuat info lowongan (bisa diambil langsung dari teks caption).
- Field isBankingSector bernilai TRUE hanya jika lowongan ini memang dari sektor Perbankan / Jasa Keuangan / Lembaga Keuangan (bank BUMN/swasta, fintech, koperasi simpan pinjam, dll). FALSE untuk sektor lain (F&B, retail, kesehatan, IT, dsb).
- Field institutionType WAJIB diisi dengan menemukan JENIS INSTITUSI lowongan. Namun PERHATIKAN — pipeline auto-scan HANYA menerima lembaga jenis "BPR" (Bank Perekonomian Rakyat, termasuk BPR Syariah/BPRS), "Koperasi" (KSP/USP/koperasi desa), dan "LPD" (Lembaga Perkreditan Desa). Bank umum/BUMN/Persero/BPD/bank swasta/bank umum syariah (misal BSI), Pegadaian, Asuransi, dan Fintech/Pembiayaan BUKAN target — tetap klasifikasikan institutionType-nya dengan jujur agar auto-scan dapat menolaknya.
- Field logoBox: jika pada gambar/screenshot terdapat logo perusahaan/instansi yang jelas (umumnya di pojok kiri-atas poster), isi dengan koordinat kotak logo { "x": 0.00, "y": 0.00, "w": 0.00, "h": 0.00 } yang ternormalisasi 0-1 terhadap lebar & tinggi gambar (x,y = kiri-atas kotak; w,h = lebar & tinggi kotak). Jika TIDAK ada logo yang jelas, isi null.
- Field companyWebsite: isi dengan domain situs web resmi perusahaan/instansi jika tertera di poster/caption (terutama bank/BPR — misal www.bprxyz.co.id). Kosongkan jika tidak ada.
- Field logoUrl: jika logo perusahaan diketahui berada di situs webnya (misal bank/BPR), isi URL langsung file gambar logonya (misal https://www.bprxyz.co.id/logo.png atau gambar logo di header situs). Kosongkan jika tidak yakin.
- Field contactInfo.address: isi PERSIS alamat fisik sebagaimana tertulis di gambar/poster (alamat walk-in/kantor).
- Field adminAddress: dari alamat fisik/lokasi yang tertulis di poster, rangkum menjadi alamat administratif: province (Provinsi), regency (Kota/Kabupaten), district (Kecamatan), village (Kelurahan/Desa). Kosongkan bagian yang tidak dapat ditentukan; isi null jika seluruhnya tidak jelas.
- Field requirements (Jobspek): salin kualifikasi/syarat PERSIS sebagaimana tertulis di gambar/poster (jangan dikarang). Jika tidak ada syarat eksplisit di gambar, rangkum kualifikasi umum yang dibutuhkan untuk posisi tersebut. JANGAN KOSONGKAN.
- Field skills (Keahlian): kembangkan DAFTAR keahlian/kompetensi spesifik yang dibutuhkan posisi ini (contoh: Microsoft Office/Excel, SIM C, kemampuan komunikasi, manajemen waktu, marketing). JANGAN KOSONGKAN — selalu isi minimal 1 keahlian.
- Field summary (Ringkasan AI) dan responsibilities (Jobdesk AI): WAJIB selalu terisi; jika tidak tertulis eksplisit di gambar, kembangkan dari konteks lowongan tersebut. JANGAN KOSONGKAN.
- PENTING — POSISI JAMAK (positions): Jika postingan membuka BEBERAPA posisi sekaligus (misal "Dibutuhkan Marketing, Credit Analyst, Collection, Team Leader Kredit"), PECAH menjadi satu entri per posisi di array positions. BACA SEMUA slide carousel/gambar yang dikirim — daftar posisi sering TIDAK memakai pemisah (koma) dan bisa tersebar di beberapa slide, amati dari teks pada gambar maupun caption. DILARANG menggabungkan beberapa posisi dalam satu title pada entri positions. Setiap entri positions memiliki title sendiri serta summary, responsibilities (jobdesk AI), requirements (jobspek), dan skills yang dikembangkan KHUSUS untuk posisi itu — jangan menyatukan semua posisi ke satu respons. Field jobTitle boleh diisi gabungan nama posisi dipisah koma. Field bersama (companyName, workLocation, salaryInfo, deadline, jobType, contactInfo, howToApply, adminAddress) cukup diisi SEKALI di level vacancy (sama untuk semua posisi). Postingan dengan SATU posisi tetap mengisi array positions dengan satu entri.

Konteks Sumber: ${sourceLabel || 'Media Sosial / Gambar Uploaded'}
${url ? `URL Tautan: ${url}` : ''}
${fetchedMetaText || ''}
${focusKeyword ? `Fokus Pencarian Pengguna: "${focusKeyword}". Konten yang TIDAK relevan dengan lowongan kerja yang dicari berdasarkan fokus ini (misal: iklan produk, promo jasa, postingan pribadi, kata mutiara) harus dinyatakan isVacancy = false.` : ''}

Mohon kembalikan respons HANYA dalam format JSON valid sesuai skema yang ditentukan.`;
}

// Shared structured JSON generation with Gemini (same vacancy schema)
async function generateVacancyJson(parts: ContentPart[]): Promise<Record<string, unknown>> {
  const ai = getGeminiClient();
  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: { parts: parts as any },
    config: {
      responseMimeType: 'application/json',
      responseSchema: VACANCY_SCHEMA,
    },
  });
  const jsonText = response.text || '{}';
  try {
    return JSON.parse(jsonText);
  } catch {
    throw new Error('Respons AI bukan JSON valid: ' + jsonText.slice(0, 200));
  }
}

// Schema khusus pasangan ekstraksi kedua: HANYA daftar posisi (satu entri per posisi).
const POSITIONS_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    positions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: {
            type: Type.STRING,
            description:
              'Nama posisi/jabatan. SATU posisi per entri — DILARANG menggabungkan beberapa posisi dalam satu title.',
          },
          summary: { type: Type.STRING, description: 'Ringkasan eksekutif khusus posisi ini (2-3 kalimat).' },
          responsibilities: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Jobdesk AI (tugas & tanggung jawab) khusus posisi ini.',
          },
          requirements: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Jobspek (syarat & kualifikasi) khusus posisi ini.',
          },
          skills: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Keahlian/kompetensi khusus posisi ini (minimal 1).',
          },
        },
        required: ['title', 'summary', 'responsibilities', 'requirements', 'skills'],
      },
    },
  },
  required: ['positions'],
};

function buildPositionsRefinePrompt(opts: {
  sourceLabel: string;
  url?: string;
  currentJobTitle?: string;
  currentPositions?: unknown;
}): string {
  const current = Array.isArray(opts.currentPositions)
    ? (opts.currentPositions as Array<{ title?: unknown }>)
        .map((p) => (p && typeof p.title === 'string' ? p.title : ''))
        .filter(Boolean)
        .join(', ')
    : (opts.currentJobTitle || '');
  return `Anda adalah Asisten AI Spesialis Penyusun Daftar POSISI Lowongan Kerja dari media sosial (Instagram, Facebook, Threads, Twitter).
Langkah pertama sudah menghasilkan ekstraksi awal lowongan. Tugas Anda sekarang: periksa ULANG konten di bawah (SEMUA gambar/slide + caption) dengan SAKSAMA, lalu susun daftar LENGKAP seluruh posisi/jabatan yang dibuka oleh lowongan ini.

ATURAN WAJIB:
1. Baca SEMUA gambar, termasuk setiap slide carousel/stories yang dikirim, beserta caption. Daftar posisi sering TIDAK memakai tanda baca pemisah (koma), atau tersebar di beberapa slide/gambar — amati dari teks di gambar maupun caption.
2. Kembalikan SATU entri per posisi di array positions. DILARANG menggabungkan beberapa posisi dalam satu title (misal "Marketing, Credit Analyst, Collection" harus pecah menjadi satu entri per posisi).
3. Untuk setiap posisi, kembangkan summary, responsibilities (jobdesk AI), requirements (jobspek), dan skills yang SPESIFIK untuk posisi tersebut — jangan sekadar menyalin teks umum lowongan.
4. Contoh jenis posisi: Marketing, Credit Analyst, Collection, Team Leader Kredit, Teller, Customer Service, Admin, dsb.
5. Jika setelah pemeriksaan menyeluruh lowongan memang hanya membuka SATU posisi, kembalikan array dengan satu entri.

Posisi yang terdeteksi sebelumnya (konteks saja): "${current || '(tidak ada)'}"
${opts.url ? `URL Tautan: ${opts.url}` : ''}
Konteks Sumber: ${opts.sourceLabel}

Kembalikan HANYA JSON valid sesuai skema.`;
}

// Pasangan ekstraksi kedua: minta Gemini membaca ulang SEMUA slide/gambar + caption untuk
// memastikan array positions berisi SATU entri per posisi (dengan jobspek/jobdesk unik).
// Mengembalikan null bila gagal sehingga pemanggil aman memakai hasil awal.
async function refineVacancyPositions(params: {
  sourceLabel: string;
  url?: string;
  caption?: string;
  currentJobTitle?: string;
  currentPositions?: unknown;
  imageParts: ContentPart[];
}): Promise<import('./src/types').JobPosition[] | null> {
  if (!POSITION_REFINE) return null;
  const ai = getGeminiClient();
  const parts: ContentPart[] = [
    {
      text: buildPositionsRefinePrompt({
        sourceLabel: params.sourceLabel,
        url: params.url,
        currentJobTitle: params.currentJobTitle,
        currentPositions: params.currentPositions,
      }),
    },
  ];
  if (params.caption && params.caption.trim().length > 0) {
    parts.push({ text: `--- TEKS CAPTION POSTINGAN ---\n${params.caption.trim()}` });
  }
  for (const p of params.imageParts) {
    if (p && p.inlineData) parts.push(p);
  }
  try {
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: { parts: parts as any },
      config: { responseMimeType: 'application/json', responseSchema: POSITIONS_SCHEMA },
    });
    const parsed = JSON.parse(response.text || '{}') as {
      positions?: Array<Record<string, unknown>>;
    };
    const list = Array.isArray(parsed.positions) ? parsed.positions : [];
    const clean: import('./src/types').JobPosition[] = [];
    for (const item of list.slice(0, MAX_SLIDES)) {
      const title = typeof item?.title === 'string' && item.title.trim() ? item.title.trim() : '';
      if (!title) continue;
      const arr = (v: unknown): string[] =>
        Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : [];
      clean.push({
        title,
        summary:
          typeof item.summary === 'string' && item.summary.trim().length > 0 ? item.summary : undefined,
        responsibilities: arr(item.responsibilities),
        requirements: arr(item.requirements),
        skills: arr(item.skills),
      });
    }
    if (clean.length === 0) return null;
    return clean;
  } catch (err: any) {
    console.warn(`[refine-posisi] gagal: ${err.message || 'unknown error'}`);
    return null;
  }
}

// Jina per-run budget shared across the discovery phase. Spacing is handled by
// DISCOVERY_DELAY_MS in discoverPosts; here we only cap total r.jina.ai requests so the
// free tier (~20 RPM/IP) is never blown. Budget is reset at the start of each auto-scan run.
const jinaState = { calls: 0 };

function resetJinaBudget() {
  jinaState.calls = 0;
}

// Consume one budget slot. Returns false when the budget is exhausted (callers then stop
// gracefully instead of throwing).
async function useJinaBudget(): Promise<boolean> {
  if (jinaState.calls >= DISCOVERY_MAX_JINA_REQUESTS) return false;
  jinaState.calls++;
  return true;
}

// Fetch a page through the r.jina.ai public reader proxy (renders JS, returns markdown).
// Mempunyai retry 1x pada rate-limit (403/429) supaya query discovery jarang gagal senyap
// (penyebab umum "tidak ada data" saat free-tier r.jina.ai sesak). Budget jina TIDAK
// dikurangi ulang saat retry (tetap 1 slot untuk 1 request logis).
async function fetchViaJinaReader(targetUrl: string, attempt: number = 0): Promise<string> {
  if (attempt === 0) {
    if (!(await useJinaBudget())) {
      throw new Error('JINA_BUDGET_EXCEEDED');
    }
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(`${JINA_READER_BASE}/${targetUrl}`, {
      signal: controller.signal,
      headers: {
        Accept: 'text/markdown',
        'User-Agent': JINA_USER_AGENT,
      },
    });

    clearTimeout(timeout);

    if (!response.ok) {
      // Retry sekali saat rate-limit / transient 5xx, dengan jeda agar token refresh.
      if (attempt === 0 && response.status >= 429) {
        await sleep(3000);
        return await fetchViaJinaReader(targetUrl, 1);
      }
      throw new Error(`HTTP ${response.status} dari r.jina.ai`);
    }

    return await response.text();
  } catch (err: any) {
    clearTimeout(timeout);
    if (err?.name === 'AbortError' && attempt === 0) {
      // Timeout 20s — coba sekali lagi (IG/jina kadang lambat).
      return await fetchViaJinaReader(targetUrl, 1);
    }
    throw err;
  }
}

// Per-run search stats (reset by the auto-scan pipeline before discovery starts).
const searchStats = { requests: 0, failed: 0, rateLimited: 0 };
function resetSearchStats() {
  searchStats.requests = 0;
  searchStats.failed = 0;
  searchStats.rateLimited = 0;
}

// Download a remote image as base64 so Gemini can do OCR on posters
async function fetchImageAsBase64(imageUrl: string): Promise<InlineImage | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);

    const response = await fetch(imageUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Referer: 'https://www.instagram.com/',
      },
    });

    clearTimeout(timeout);

    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    const mimeType = response.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
    return { mimeType, data: buffer.toString('base64') };
  } catch {
    return null;
  }
}

// ----------------------------- Company Logo Resolution -----------------------------
// Resolve the official company logo (e.g. bank/BPR logos hosted on their website) into
// a base64 data URL so it can be embedded directly in the Excel export.

function normalizeDomain(raw: string): string {
  let d = (raw || '').trim().toLowerCase();
  d = d.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  d = d.split(/[/?#]/)[0];
  d = d.split(':')[0];
  return d.trim();
}

async function fetchLogoImageAsBase64(imageUrl: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(imageUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
    });
    clearTimeout(timeout);
    if (!response.ok) return null;
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) return null;
    const mime = contentType.split(';')[0].trim() || 'image/png';
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > 8 * 1024 * 1024) return null;
    return `data:${mime};base64,${buffer.toString('base64')}`;
  } catch {
    return null;
  }
}

async function fetchWebsiteHtml(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
    });
    clearTimeout(timeout);
    if (!response.ok) return null;
    const ct = response.headers.get('content-type') || '';
    if (!ct.includes('text/html')) return null;
    return await response.text();
  } catch {
    return null;
  }
}

function extractLogoCandidatesFromHtml(html: string, baseUrl: string): string[] {
  const found: string[] = [];
  const add = (href: string) => {
    if (!href) return;
    try {
      const clean = href.replace(/\\\//g, '/').replace(/&amp;/g, '&');
      const resolved = new URL(clean, baseUrl).href;
      if (/^https?:/.test(resolved)) found.push(resolved);
    } catch {
      /* ignore invalid URL */
    }
  };

  // 1) <img> tags that look like a company logo (src/class/id/alt containing "logo"/"brand")
  const imgRe = /<img[^>]*>/gi;
  let imgMatch: RegExpExecArray | null;
  while ((imgMatch = imgRe.exec(html)) !== null) {
    if (!/logo|brand/i.test(imgMatch[0])) continue;
    const src = imgMatch[0].match(/src\s*=\s*["']([^"']+)["']/i);
    if (src) add(src[1]);
  }

  // 2) og:image
  const ogRe = /<meta[^>]+(?:property|name)\s*=\s*["']og:image["'][^>]*>/gi;
  let ogMatch: RegExpExecArray | null;
  while ((ogMatch = ogRe.exec(html)) !== null) {
    const content = ogMatch[0].match(/content\s*=\s*["']([^"']+)["']/i);
    if (content) add(content[1]);
  }

  // 3) rel="icon" / apple-touch-icon
  const iconRe = /<link[^>]+rel\s*=\s*["'][^"']*icon[^"']*["'][^>]*>/gi;
  let iconMatch: RegExpExecArray | null;
  while ((iconMatch = iconRe.exec(html)) !== null) {
    const href = iconMatch[0].match(/href\s*=\s*["']([^"']+)["']/i);
    if (href) add(href[1]);
  }

  // 4) common logo paths
  ['/logo.png', '/images/logo.png', '/assets/logo.png', '/img/logo.png', '/assets/img/logo.png', '/favicon-96x96.png', '/favicon-192x192.png'].forEach((p) => add(p));

  return Array.from(new Set(found));
}

async function resolveCompanyLogo(
  parsed: Record<string, unknown>,
  options: { deep?: boolean } = {}
): Promise<string | null> {
  const { deep = true } = options;
  const candidates: string[] = [];

  // Priority 1: direct logo image URL given by the AI
  if (parsed.logoUrl) candidates.push(String(parsed.logoUrl));

  // Priority 2: resolve from the official company website (homepage HTML scan)
  let domain = parsed.companyWebsite ? normalizeDomain(String(parsed.companyWebsite)) : '';
  const contact = (parsed.contactInfo || {}) as Record<string, unknown>;
  if (!domain && contact.websiteForm) domain = normalizeDomain(String(contact.websiteForm));
  if (domain) {
    const baseUrl = `https://${domain}`;
    if (deep) {
      const html = await fetchWebsiteHtml(baseUrl);
      if (html) candidates.push(...extractLogoCandidatesFromHtml(html, baseUrl));
    }
    // Priority 3: favicon services (lightweight fallback)
    candidates.push(`https://www.google.com/s2/favicons?sz=128&domain=${encodeURIComponent(domain)}`);
    candidates.push(`https://icon.horse/icon/${encodeURIComponent(domain)}`);
  }

  for (const url of candidates) {
    const dataUrl = await fetchLogoImageAsBase64(url);
    if (dataUrl) return dataUrl;
  }
  return null;
}

// ----------------------------- Carousel Slide Resolution -----------------------------

function cleanMediaUrl(raw: string): string {
  return raw.replace(/\\\//g, '/').replace(/\\u0026/g, '&');
}

function extractSlideUrls(html: string): string[] {
  const urls = new Set<string>();
  const re = /"display_url":"([^"]+)"/g;
  let m: RegExpMatchArray | null;
  while ((m = re.exec(html)) !== null) {
    const u = cleanMediaUrl(m[1]);
    if (/^https?:\/\//.test(u) && /cdninstagram\.com|fbcdn\.net/i.test(u)) urls.add(u);
  }
  return Array.from(urls);
}

function extractEmbedSlideUrls(html: string): string[] {
  const urls = new Set<string>();
  const re = /<img[^>]+src="([^"]+)"/g;
  let m: RegExpMatchArray | null;
  while ((m = re.exec(html)) !== null) {
    const u = cleanMediaUrl(m[1]);
    if (/^https?:\/\//.test(u) && /cdninstagram\.com|fbcdn\.net/i.test(u)) urls.add(u);
  }
  return Array.from(urls);
}

function extractMarkdownImageUrls(markdown: string): string[] {
  const urls = new Set<string>();
  const re = /!\[[^\]]*\]\(([^)]+)\)/g;
  let m: RegExpMatchArray | null;
  while ((m = re.exec(markdown)) !== null) {
    const u = cleanMediaUrl(m[1]);
    if (/^https?:\/\//.test(u) && /cdninstagram\.com|fbcdn\.net/i.test(u)) urls.add(u);
  }
  return Array.from(urls);
}

async function fetchPageHtml(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

// Resolve ALL carousel slide image URLs for a public IG post (layered fallbacks).
// Falls back to the single cover image when nothing else is parseable.
async function resolvePostSlideUrls(shortcode: string): Promise<string[]> {
  const fallback = [`https://www.instagram.com/p/${shortcode}/media/?size=l`];
  if (!shortcode) return fallback;

  try {
    const html = await fetchPageHtml(`https://www.instagram.com/p/${shortcode}/`);
    const urls = extractSlideUrls(html);
    if (urls.length > 0) return urls.slice(0, MAX_SLIDES);
  } catch {
    /* continue to next strategy */
  }

  try {
    const html = await fetchPageHtml(`https://www.instagram.com/p/${shortcode}/embed/captioned/`);
    const urls = extractEmbedSlideUrls(html);
    if (urls.length > 0) return urls.slice(0, MAX_SLIDES);
  } catch {
    /* continue to next strategy */
  }

  try {
    const markdown = await fetchViaJinaReader(`https://www.instagram.com/p/${shortcode}/`);
    const urls = extractMarkdownImageUrls(markdown);
    if (urls.length > 0) return urls.slice(0, MAX_SLIDES);
  } catch {
    /* continue to fallback */
  }

  return fallback;
}

// ----------------------------- Discovery -----------------------------

function loadScanSources(): {
  queries: string[];
  instagramAccounts: string[];
  threadsAccounts: string[];
  facebook: string[];
} {
  try {
    const raw = JSON.parse(readFileSync(path.join(process.cwd(), SCAN_SOURCES_FILE), 'utf-8'));
    return {
      queries: Array.isArray(raw.queries) ? raw.queries : [],
      instagramAccounts: Array.isArray(raw.instagramAccounts) ? raw.instagramAccounts : [],
      threadsAccounts: Array.isArray(raw.threadsAccounts) ? raw.threadsAccounts : [],
      facebook: Array.isArray(raw.facebook) ? raw.facebook : [],
    };
  } catch (err: any) {
    console.warn('Gagal membaca loker-sources.json:', err.message);
    return { queries: [], instagramAccounts: [], threadsAccounts: [], facebook: [] };
  }
}

// Decode a Bing redirect link (https://www.bing.com/ck/a?...&u=a1<base64url>) into the real URL.
function decodeBingRedirect(text: string): string {
  const u = text.match(/[?&]u=a1([^&\s'")\]}]+)/);
  if (u) {
    try {
      return Buffer.from(u[1], 'base64url').toString('utf-8');
    } catch {
      /* fall back to original text */
    }
  }
  return text;
}

// Extract an Instagram post/reel shortcode from any text (search result blocks, URLs).
function extractShortcode(text: string): string {
  const decoded = decodeBingRedirect(text);
  const m =
    decoded.match(/instagram\.com%2Fp%2F([A-Za-z0-9_-]{6,})/) ||
    decoded.match(/instagram\.com\/p\/([A-Za-z0-9_-]{6,})/) ||
    decoded.match(/instagram\.com%2Freel%2F([A-Za-z0-9_-]{6,})/) ||
    decoded.match(/instagram\.com\/reel\/([A-Za-z0-9_-]{6,})/);
  return m && m[1] ? m[1] : '';
}

// Sinyal loker untuk menyaring hasil discovery Instagram sebelum dianalisis Gemini.
const LOKER_SIGNALS = [
  'loker',
  'lowongan',
  'kerja',
  'pekerjaan',
  'rekrutmen',
  'recruitment',
  'hiring',
  'vacancy',
  'karir',
  'career',
  'dibutuhkan',
  'membutuhkan',
  'open recruitment',
  'buka lowongan',
  '#loker',
  'lamar',
  'posisi',
  'job',
];

// Parse one DuckDuckGo HTML result page (rendered as markdown blocks) into the shared pool.
// Each block looks like: "## [<title>](url)" followed by the DDG snippet
// "N likes, M comments - <user> on <date>: \"<caption>\"". The full post image is
// fetched later via the public /media/?size=l endpoint (no login needed).
function ingestDiscoveryPage(
  markdown: string,
  found: Map<string, ScannedPost>,
  daysBack: number
): number {
  const blocks = markdown.split(/^## \[/m).slice(1);
  let added = 0;
  for (const block of blocks) {
    const shortcode = extractShortcode(block);
    if (!shortcode) continue;
    if (found.has(shortcode)) continue;

    // Respect the recency window: posts with a parsed date older than daysBack are
    // skipped so the Gemini budget isn't wasted on old vacancies. Posts without a
    // parseable date are now SKIPPED (stricter filtering to prevent old posts from slipping through).
    
    // Try multiple date formats:
    // 1. English: "on August 28, 2026:" or "August 28, 2026"
    // 2. Indonesian: "pada 28 Agustus 2026" or "28 Agustus 2026"
    // 3. Relative: "1 hari lalu", "2 days ago"
    let postDateIso: string | null = null;
    
    // Format 1: English month-first "Month DD, YYYY"
    const dateMatchEn = block.match(/(?:on\s+)?([A-Za-z]+\s+\d{1,2},?\s+\d{4}):/);
    if (dateMatchEn && dateMatchEn[1]) {
      postDateIso = parseDiscoveryDate(dateMatchEn[1]);
    }
    
    // Format 2: Indonesian day-first "DD Month YYYY" or "pada DD Month YYYY"
    if (!postDateIso) {
      const dateMatchId = block.match(/(?:pada\s+)?(\d{1,2}\s+(?:Januari|Februari|Maret|April|Mei|Juni|Juli|Agustus|September|Oktober|November|Desember)\s+\d{4})/i);
      if (dateMatchId && dateMatchId[1]) {
        postDateIso = parseDiscoveryDate(dateMatchId[1]);
      }
    }
    
    // Format 3: Relative dates "X hari/jam/menit lalu" or "X days/hours/minutes ago"
    if (!postDateIso) {
      const dateMatchRelative = block.match(/(\d+\s+(?:hari|jam|menit|detik|minggu|bulan|days?|hours?|minutes?|seconds?|weeks?|months?)\s+(?:yang\s*lalu|lalu|ago))/i);
      if (dateMatchRelative && dateMatchRelative[1]) {
        postDateIso = parseDiscoveryDate(dateMatchRelative[1]);
      }
    }
    
    // Format 4: "Hari ini" / "Kemarin" / "Today" / "Yesterday"
    if (!postDateIso) {
      const dateMatchToday = block.match(/(Hari\s*ini|Kemarin|Today|Yesterday)/i);
      if (dateMatchToday && dateMatchToday[1]) {
        postDateIso = parseDiscoveryDate(dateMatchToday[1]);
      }
    }
    
    if (postDateIso) {
      const ageDays = Math.max(
        0,
        Math.floor((Date.now() - new Date(postDateIso).getTime()) / 86400000)
      );
      if (ageDays > daysBack) {
        discoveryRecencySkipped++;
        continue;
      }
    } else {
      // Cannot parse date → skip this post (stricter filtering)
      discoveryRecencySkipped++;
      continue;
    }

    // Caption snippet: "[<likes> likes, <n> comments - <user> on <date>: \"caption ...](url)".
    // DDG memotong caption dengan "..." tanpa kutip penutup sebelum ](https), jadi regex
    // TIDAK boleh mensyaratkan kutip penutup.
    const snippet = block.match(/: "([\s\S]*?)\]\(https/i);
    // Username right before " on " (DDG often omits the full date in the snippet)
    const userMatch = block.match(/-\s*([A-Za-z0-9_.]+)\s+on\s+/);

    let caption = snippet ? snippet[1] : '';
    if (!caption) {
      // Fallback: use the result title (account on Instagram: "<first line>")
      const title = block.match(/^([\s\S]*?)\]\(/);
      if (title) {
        const tc = title[1].match(/on Instagram:\s*"?([\s\S]*)$/i);
        if (tc) caption = tc[1];
      }
    }
    if (!caption) {
      // Fallback kedua: judul berbentuk "<TITLE> | <caption>" (jina menempatkan teks
      // caption di judul hasil untuk sebagian query).
      const title = block.match(/^([\s\S]*?)\]\(/);
      if (title) {
        const sep = title[1].match(/\|\s*([\s\S]*)$/);
        if (sep) caption = sep[1];
      }
    }

    // Precision: buang post yang jelas BUKAN loker sebelum menghabiskan budget
    // Gemini. Post dengan snippet terlalu pendek/kosong (tidak bisa dinilai)
    // tetap diambil agar recall tidak turun.
    const snippetTxt = `${caption || ''} ${userMatch ? userMatch[1] : ''}`.toLowerCase();
    if (snippetTxt.trim().length > 30 && !LOKER_SIGNALS.some((s) => snippetTxt.includes(s))) {
      discoveryNoiseSkipped++;
      continue;
    }

    found.set(shortcode, {
      url: `https://www.instagram.com/p/${shortcode}/`,
      shortcode,
      platform: 'Instagram',
      caption: caption
        ? caption.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim().slice(0, 2200)
        : '',
      username: userMatch ? userMatch[1] : '',
      imageUrl: `https://www.instagram.com/p/${shortcode}/media/?size=l`,
      sourceLabel: `Instagram Post (${shortcode})`,
      postDate: postDateIso || undefined,
    });
    added++;
  }
  return added;
}

// Counter post yang dibuang sebagai noise di discovery (untuk log & transparansi).
let discoveryNoiseSkipped = 0;
// Counter post yang dibuang karena umurnya melebihi rentang daysBack (recency window).
let discoveryRecencySkipped = 0;

// Statistik analisis IG auto-scan per run (direset di awal /api/auto-scan) untuk
// diagnostik di log server & UI saat hasil kosong/sebagian.
const autoScanStats = { bukanLoker: 0, errors: 0, duplicates: 0 };

function resetAutoScanStats() {
  autoScanStats.bukanLoker = 0;
  autoScanStats.errors = 0;
  autoScanStats.duplicates = 0;
}

// Buffer live untuk IG auto-scan (mirip fbScanProgress): dipoll frontend lewat
// GET /api/auto-scan/progress selama run berjalan supaya log & hasil tampil LIVE
// seperti bot Facebook (instruksi user), bukan menunggu sampai seluruh run selesai.
interface IgScanProgress {
  running: boolean;
  phase: 'starting' | 'discovering' | 'analyzing' | 'done';
  queriesTotal: number;
  queriesDone: number;
  postsDiscovered: number;
  postsAnalyzed: number;
  resultCount: number;
  bukanLoker: number;
  errorCount: number;
  postLog: string[];
  results: Record<string, unknown>[];
  message: string;
}

let igScanProgress: IgScanProgress = {
  running: false,
  phase: 'starting',
  queriesTotal: 0,
  queriesDone: 0,
  postsDiscovered: 0,
  postsAnalyzed: 0,
  resultCount: 0,
  bukanLoker: 0,
  errorCount: 0,
  postLog: [],
  results: [],
  message: '',
};

function resetIgScanProgress() {
  igScanProgress = {
    running: false,
    phase: 'starting',
    queriesTotal: 0,
    queriesDone: 0,
    postsDiscovered: 0,
    postsAnalyzed: 0,
    resultCount: 0,
    bukanLoker: 0,
    errorCount: 0,
    postLog: [],
    results: [],
    message: '',
  };
}

function updateIgScanProgress(patch: Partial<IgScanProgress>) {
  igScanProgress = { ...igScanProgress, ...patch };
  igScanProgress.bukanLoker = autoScanStats.bukanLoker;
  igScanProgress.errorCount = autoScanStats.errors;
}

// ----------------------------- IG Auto-Schedule (penjadwalan otomatis) -----------------------------
// Memungkinkan bot IG berjalan otomatis pada jadwal tetap (setiap N hari, jam & menit tertentu)
// tanpa harus membuka browser. Hasil tiap run disimpan ke file di server sebagai batch dan
// otomatis dihapus setelah 30 hari (retensi). Konfigurasi jadwal juga disimpan di file agar
// survive restart server.

const DATA_DIR = path.join(process.cwd(), 'data');
const IG_SCHEDULE_FILE = path.join(DATA_DIR, 'ig-schedule.json');
const IG_SCHEDULED_RESULTS_FILE = path.join(DATA_DIR, 'ig-scheduled-results.json');
const IG_RESULTS_RETENTION_DAYS = 30;
// Folder cadangan Excel hasil run terjadwal. Disimpan terpisah dari data/ (JSON) agar
// backup Excel tetap ada meski batch terkait dihapus manual dari UI "Backup / Lihat Data".
const EXPORT_DIR = path.join(process.cwd(), 'export');

interface IgScheduleConfig {
  enabled: boolean;
  intervalDays: number; // berjalan setiap N hari
  hour: number; // jam (0-23)
  minute: number; // menit (0-59)
  daysBack: number; // rentang hari yang dipindai
  maxPosts: number; // jumlah loker yang diminta per run
  lastRunAt?: string | null; // ISO timestamp run terakhir
  nextRunAt?: string | null; // ISO timestamp run berikutnya
  lastStatus?: string; // ringkasan status run terakhir
}

interface ScheduledBatch {
  id: string;
  capturedAt: string; // ISO timestamp
  daysBack: number;
  maxPosts: number;
  diagnostics: {
    discovered: number;
    analyzed: number;
    bukanLoker: number;
    errorCount: number;
    duplicates: number;
    results: number;
  };
  results: Record<string, unknown>[]; // daftar BotFeedItem
}

let igSchedule: IgScheduleConfig = {
  enabled: false,
  intervalDays: 3,
  hour: 8,
  minute: 0,
  daysBack: 3,
  maxPosts: 15,
  lastRunAt: null,
  nextRunAt: null,
  lastStatus: 'Belum pernah berjalan.',
};

function ensureDataDir() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const gitkeep = path.join(DATA_DIR, '.gitkeep');
    if (!existsSync(gitkeep)) writeFileSync(gitkeep, '', 'utf-8');
  } catch {
    /* ignore */
  }
}

function ensureExportDir() {
  try {
    mkdirSync(EXPORT_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
}

// Simpan satu batch hasil run sebagai file Excel (.xlsx) ke folder export/.
// Tujuannya sebagai backup permanen yang TETAP ADA meski batch JSON di data/
// dihapus manual dari UI atau kedaluwarsa (retensi 30 hari). Nama file unik per
// run (dari capturedAt) sehingga tidak saling menimpa. Kegagalan di sini tidak
// boleh menggagalkan alur penyimpanan batch, jadi dibungkus try/catch sendiri.
async function saveBatchToExcel(batch: ScheduledBatch): Promise<boolean> {
  try {
    if (!batch.results || batch.results.length === 0) return false;
    ensureExportDir();
    const vacancies = batch.results.map(
      (r) => (r as { vacancyData?: import('./src/types').JobVacancy }).vacancyData
    ).filter(Boolean) as import('./src/types').JobVacancy[];
    if (vacancies.length === 0) return false;
    const { exportVacanciesToExcelBuffer } = await import('./src/utils/excelExporter');
    const buffer = await exportVacanciesToExcelBuffer(vacancies);
    const stamp = batch.capturedAt.replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
    const filename = `Loker_IG_${stamp}.xlsx`;
    writeFileSync(path.join(EXPORT_DIR, filename), buffer);
    return true;
  } catch (err: any) {
    console.warn('[ig-schedule] gagal menyimpan Excel ke folder export:', err?.message || err);
    return false;
  }
}

type ApiPayload = Record<string, unknown>;

// Petakan satu JobVacancy + satu JobPosition menjadi objek payload sesuai dokumentasi
// Scraper Ingestion API. Dipanggil per posisi sehingga 1 posisi = 1 record payload.
// Hanya field yang wajib selalu disertakan; sisanya opsional (null/omitted bila kosong).
function mapVacancyToApiPayload(
  v: import('./src/types').JobVacancy,
  pos: import('./src/types').JobPosition
): ApiPayload {
  const p: ApiPayload = {
    source_type: 'social_media',
    nama_perusahaan: v.companyName,
    posisi: pos.title || v.jobTitle,
  };
  if (v.platform) p.platform = v.platform;
  if (v.logoUrl) p.logo_url = v.logoUrl;
  if (v.salaryInfo) p.gaji_raw = v.salaryInfo;
  if (v.salaryInfo) {
    const nums = (v.salaryInfo.match(/[\d.]+/g) || []).map((s) => Number(s.replace(/\./g, '')));
    if (nums.length === 2) {
      p.gaji_min = Math.min(nums[0], nums[1]);
      p.gaji_max = Math.max(nums[0], nums[1]);
    } else if (nums.length === 1) {
      p.gaji_min = nums[0];
    }
  }
  if (pos.summary || v.summary) p.ringkasan_ai = pos.summary || v.summary;
  if (pos.responsibilities && pos.responsibilities.length > 0) p.jobdesk = pos.responsibilities.join(', ');
  if (pos.requirements && pos.requirements.length > 0) p.kualifikasi_jobspek = pos.requirements.join(', ');
  if (pos.skills && pos.skills.length > 0) p.keahlian_skill = pos.skills.join(', ');
  if (v.jobType) p.tipe_pekerjaan = v.jobType;
  if (v.postDate) p.tanggal_posting = v.postDate;
  if (v.deadline) p.batas_pendaftaran = v.deadline;
  if (v.contactInfo?.phoneWhatsapp) p.no_hp = v.contactInfo.phoneWhatsapp;
  if (v.contactInfo?.websiteForm) p.website_form_url = v.contactInfo.websiteForm;
  else if (v.companyWebsite) p.website_form_url = v.companyWebsite;
  if (v.contactInfo?.instagramDm) p.instagram_dm = v.contactInfo.instagramDm;
  if (v.contactInfo?.email) p.email_perusahaan = v.contactInfo.email;
  if (v.howToApply) p.cara_melamar = v.howToApply;
  if (v.jobCategory) p.kategori_bidang = v.jobCategory;
  if (v.sourceUrl) p.sumber_url = v.sourceUrl;
  if (v.adminAddress || v.workLocation) {
    const parts: string[] = [];
    if (v.adminAddress?.village) parts.push(v.adminAddress.village);
    if (v.adminAddress?.district) parts.push(v.adminAddress.district);
    if (v.adminAddress?.regency) parts.push(v.adminAddress.regency);
    if (v.adminAddress?.province) parts.push(v.adminAddress.province);
    if (v.workLocation) parts.push(v.workLocation);
    if (parts.length > 0) p.alamat_raw = parts.join(', ');
  }
  if (v.adminAddress?.province) p.provinsi_raw = v.adminAddress.province;
  return p;
}

// Kirim seluruh lowongan dalam satu batch ke Scraper Ingestion API.
// Kegagalan di sini dibungkus try/catch agar tidak menggagalkan penyimpanan batch/Excel.
async function sendBatchToApi(batch: ScheduledBatch): Promise<void> {
  try {
    if (!SCRAPER_API_KEY) {
      console.warn('[scraper-api] SCRAPER_API_KEY kosong, pengiriman ke API dilewati.');
      return;
    }
    const vacancies = batch.results
      .map((r) => (r as { vacancyData?: import('./src/types').JobVacancy }).vacancyData)
      .filter(Boolean) as import('./src/types').JobVacancy[];
    if (vacancies.length === 0) return;
    // 1 posisi = 1 record payload (pecah posisi jamak menjadi beberapa payload).
    const payload: ApiPayload[] = [];
    for (const v of vacancies) {
      for (const pos of expandPositions(v)) {
        payload.push(mapVacancyToApiPayload(v, pos));
      }
    }
    if (payload.length === 0) return;
    const res = await fetch(SCRAPER_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Scraper-Api-Key': SCRAPER_API_KEY,
      },
      body: JSON.stringify(payload),
    });
    const text = await res.text().catch(() => '');
    if (res.ok) {
      console.log(`[scraper-api] terkirim ${payload.length} lowongan ke draft → HTTP ${res.status}`);
    } else {
      console.warn(`[scraper-api] gagal kirim → HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
  } catch (err: any) {
    console.warn('[scraper-api] error saat mengirim batch:', err?.message || err);
  }
}

// Kirim notifikasi WhatsApp berisi jumlah loker hasil run ke nomor tujuan.
// Jumlah 0 => pesan "tidak ada penambahan"; >0 => pesan "ada penambahan X".
// Parameter days (opsional) mengendalikan teks saat count=0: nilai dari "Jadwal Setting" (intervalDays)
// di UI. Kegagalan dibungkus try/catch agar tidak menggagalkan alur run/penyimpanan.
async function sendWhatsAppNotification(count: number, days?: number): Promise<void> {
  try {
    if (!WA_API_URL || !WA_API_KEY || !WA_TO_NUMBER) {
      console.warn('[wa-notif] WA_API_URL / WA_API_KEY / WA_TO_NUMBER kosong, notifikasi WA dilewati.');
      return;
    }
    let body: string;
    if (count > 0) {
      body = `📋 *Loker IG*\n\nHari ini ada Penambahan *${count} Lowongan Pekerjaan Baru* dari Loker IG Scrapper`;
    } else if (typeof days === 'number' && days > 1) {
      body = `📋 *Loker IG*\n\n${days} hari terakhir tidak ada penambahan Lowongan Pekerjaan Baru dari Loker IG Scrapper`;
    } else if (typeof days === 'number' && days >= 0) {
      body = `📋 *Loker IG*\n\nHari ini tidak ada penambahan Lowongan Pekerjaan Baru dari Loker IG Scrapper`;
    } else {
      body = `📋 *Loker IG*\n\nBeberapa Hari ini TIDAK ada Penambahan Lowongan Pekerjaan Baru dari Loker IG Scrapper`;
    }
    const res = await fetch(WA_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WA_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: WA_TO_NUMBER,
        body,
        external_id: `loker-ig-${Date.now()}`,
      }),
    });
    const text = await res.text().catch(() => '');
    if (res.ok) {
      console.log(`[wa-notif] terkirim ${count} loker → HTTP ${res.status}`);
    } else {
      console.warn(`[wa-notif] gagal kirim → HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
  } catch (err: any) {
    console.warn('[wa-notif] error saat kirim notifikasi:', err?.message || err);
  }
}

function loadIgSchedule(): void {
  ensureDataDir();
  try {
    if (existsSync(IG_SCHEDULE_FILE)) {
      const raw = JSON.parse(readFileSync(IG_SCHEDULE_FILE, 'utf-8'));
      igSchedule = { ...igSchedule, ...raw };
    }
  } catch (err: any) {
    console.warn('Gagal membaca ig-schedule.json:', err.message);
  }
}

function saveIgSchedule(): void {
  ensureDataDir();
  try {
    writeFileSync(IG_SCHEDULE_FILE, JSON.stringify(igSchedule, null, 2), 'utf-8');
  } catch (err: any) {
    console.warn('Gagal menyimpan ig-schedule.json:', err.message);
  }
}

function loadScheduledResults(): ScheduledBatch[] {
  ensureDataDir();
  try {
    if (existsSync(IG_SCHEDULED_RESULTS_FILE)) {
      const raw = JSON.parse(readFileSync(IG_SCHEDULED_RESULTS_FILE, 'utf-8'));
      if (Array.isArray(raw)) return raw as ScheduledBatch[];
    }
  } catch (err: any) {
    console.warn('Gagal membaca ig-scheduled-results.json:', err.message);
  }
  return [];
}

// Simpan batch dengan retensi: hapus batch yang usia-nya melebihi 30 hari (berdasarkan
// capturedAt). Data terbaru ditaruh di depan.
function saveScheduledResults(batch: ScheduledBatch): void {
  ensureDataDir();
  const now = Date.now();
  const cutoff = now - IG_RESULTS_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const existing = loadScheduledResults().filter((b) => {
    const t = new Date(b.capturedAt).getTime();
    return !isNaN(t) && t >= cutoff;
  });
  const dedup = new Map<string, ScheduledBatch>();
  for (const b of [batch, ...existing]) {
    if (!dedup.has(b.id)) dedup.set(b.id, b);
  }
  const merged = Array.from(dedup.values()).sort(
    (a, b) => new Date(b.capturedAt).getTime() - new Date(a.capturedAt).getTime()
  );
  try {
    writeFileSync(IG_SCHEDULED_RESULTS_FILE, JSON.stringify(merged, null, 2), 'utf-8');
  } catch (err: any) {
    console.warn('Gagal menyimpan ig-scheduled-results.json:', err.message);
  }
}

// Hapus batch yang sudah melewati batas retensi (dipanggil saat membaca hasil / oleh scheduler).
function pruneScheduledResults(): void {
  const now = Date.now();
  const cutoff = now - IG_RESULTS_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const kept = loadScheduledResults().filter((b) => {
    const t = new Date(b.capturedAt).getTime();
    return !isNaN(t) && t >= cutoff;
  });
  try {
    writeFileSync(IG_SCHEDULED_RESULTS_FILE, JSON.stringify(kept, null, 2), 'utf-8');
  } catch {
    /* ignore */
  }
}

// Temukan kemunculan HH:MM berikutnya yang STRICT setelah baseline.
// - Jika HH:MM hari ini masih di masa depan → hari ini.
// - Jika sudah lewat hari ini → besok (bukan lompat +intervalDays).
// Ini penting agar saat user set jam, bot jalan di kemunculan berikutnya (bukan kebablasan
// beberapa hari) — inilah akar masalah "set jam tapi tidak jalan".
function findNextOccurrence(fromIso: string, hour: number, minute: number): string {
  const from = new Date(fromIso);
  const next = new Date(from);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= from.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next.toISOString();
}

// Untuk run berulang: tambah intervalDays ke baseline, lalu rapikan ke HH:MM berikutnya.
function computeRecurring(fromIso: string, intervalDays: number, hour: number, minute: number): string {
  const base = new Date(fromIso);
  base.setDate(base.getDate() + intervalDays);
  return findNextOccurrence(base.toISOString(), hour, minute);
}

// Susun nextRunAt:
// - Belum pernah run (lastRunAt kosong) → kemunculan HH:MM berikutnya dari sekarang (hari ini/besok).
// - Sudah pernah run → lastRunAt + intervalDays, lalu geser jika sudah lewat sekarang.
// intervalDays === 0 berarti "hari ini": selalu dijadwalkan hari ini pada jam HH:MM, terlepas dari
// apakah sudah pernah run atau belum (agar user bisa set "0" dan bot jalan hari ini). Satu-satunya
// pengecualian adalah pemanggilan setelah run selesai (afterRun=true): saat itu interval 0 diperlakukan
// sebagai 1 (tiap hari) sehingga tidak berulang tanpa henti di hari yang sama.
function refreshNextRunAt(opts?: { afterRun?: boolean }) {
  if (!igSchedule.enabled) {
    igSchedule.nextRunAt = null;
    return;
  }
  const now = new Date();
  const nowIso = now.toISOString();

  // intervalDays === 0 diartikan "1x per hari di jam HH:MM" (bukan "jalankan hari ini terus").
  // Jadwal HARI INI di jam HH:MM jika jam belum lewat, atau BESOK pada jam yang sama bila sudah
  // lewat. Tidak pernah menghasilkan nowIso sehingga tidak memicu run ulang tiap 30 detik /
  // setiap server restart / setiap user menyimpan jadwal. Setelah run selesai (afterRun=true)
  // turun ke logika recurring (effInterval=1) untuk maju ke hari berikutnya.
  if (igSchedule.intervalDays === 0 && !opts?.afterRun) {
    const today = new Date(now);
    today.setHours(igSchedule.hour, igSchedule.minute, 0, 0);
    if (today.getTime() <= now.getTime()) {
      today.setDate(today.getDate() + 1);
    }
    igSchedule.nextRunAt = today.toISOString();
    return;
  }

  if (!igSchedule.lastRunAt) {
    igSchedule.nextRunAt = findNextOccurrence(nowIso, igSchedule.hour, igSchedule.minute);
    return;
  }

  // Interval efektif: intervalDays, namun 0 diperlakukan sebagai 1 (tiap hari) untuk run berikutnya
  // agar tidak langsung jalan lagi berulang di hari yang sama.
  const effInterval = igSchedule.intervalDays === 0 ? 1 : igSchedule.intervalDays;

  let next = computeRecurring(igSchedule.lastRunAt, effInterval, igSchedule.hour, igSchedule.minute);
  let guard = 0;
  while (new Date(next).getTime() <= now.getTime() && guard < 100) {
    next = computeRecurring(next, effInterval, igSchedule.hour, igSchedule.minute);
    guard++;
  }
  igSchedule.nextRunAt = next;
}

// Jalankan satu run terjadwal: memanggil logika inti, menyimpan batch ke file.
async function runScheduledIgScan(trigger: 'schedule' | 'manual'): Promise<void> {
  if (igScanProgress.running) {
    igSchedule.lastStatus = 'Dilewati — auto-scan IG sedang berjalan.';
    saveIgSchedule();
    return;
  }
  try {
    const result = await runIgAutoScan({ maxPosts: igSchedule.maxPosts, daysBack: igSchedule.daysBack });
    const capturedAt = new Date().toISOString();
    const batchId = `batch-${Date.now()}`;
    const batch: ScheduledBatch = {
      id: batchId,
      capturedAt,
      daysBack: igSchedule.daysBack,
      maxPosts: igSchedule.maxPosts,
      diagnostics: {
        discovered: result.diagnostics.discovered,
        analyzed: result.diagnostics.analyzed,
        bukanLoker: result.diagnostics.bukanLoker,
        errorCount: result.diagnostics.errorCount,
        duplicates: result.diagnostics.duplicates,
        results: result.diagnostics.results,
      },
      results: result.data,
    };
    if (batch.results.length > 0) {
      saveScheduledResults(batch);
      // Simpan juga cadangan Excel ke folder export/ (backup permanen, tahan dihapus batch).
      await saveBatchToExcel(batch);
      // Kirim juga ke Scraper Ingestion API (draft database). Kegagalan tidak menggagalkan alur.
      await sendBatchToApi(batch);
    }
    await sendWhatsAppNotification(countTotalPositions(batch.results), igSchedule.intervalDays);
    igSchedule.lastRunAt = capturedAt;
    igSchedule.lastStatus = `${trigger === 'schedule' ? 'Jadwal' : 'Manual'}: ${countTotalPositions(result.data ?? [])} loker dari ${result.diagnostics.discovered} ditemukan (${result.diagnostics.analyzed} dianalisis).`;
    if (result.warnings && result.warnings.length > 0) {
      igSchedule.lastStatus += ' ' + result.warnings.join(' ');
    }
  } catch (err: any) {
    igSchedule.lastRunAt = new Date().toISOString();
    igSchedule.lastStatus = `Gagal: ${err.message || 'unknown error'}`;
    console.warn('[ig-schedule] gagal menjalankan run:', err.message || err);
    if (trigger === 'manual') throw err;
  } finally {
    pruneScheduledResults();
    refreshNextRunAt({ afterRun: true });
    saveIgSchedule();
  }
}

// Cek berkala (tiap 30 detik) apakah jadwal sudah waktunya jalan.
// Callback async dibungkus try/catch agar error (mis. jadwal rusak, run gagal) TIDAK
// menjadi UnhandledPromiseRejection yang bisa mematikan seluruh proses server.
// Watchdog: bila igScanProgress.running tersangkut true lebih dari ambang (mis. run
// normal sangat jarang melewati 20 menit), paksa reset agar jadwal tidak selamanya macet.
const IG_RUN_WATCHDOG_MS = 20 * 60 * 1000;
let igRunStartedAt = 0;
setInterval(() => {
  (async () => {
    if (igScanProgress.running) {
      // Catat kapan run mulai; jika sudah terlalu lama tanpa selesai, reset sebagai jaring
      // pengaman (menggantikan kemungkinan flag tersangkut true yang memblok semua auto-run).
      if (igRunStartedAt === 0) igRunStartedAt = Date.now();
      else if (Date.now() - igRunStartedAt > IG_RUN_WATCHDOG_MS) {
        console.warn('[ig-schedule] watchdog: run tersangkut, mereset flag running.');
        igScanProgress.running = false;
        igScanProgress.phase = 'done';
        igRunStartedAt = 0;
      }
    } else {
      igRunStartedAt = 0;
    }
    if (!igSchedule.enabled) return;
    if (igScanProgress.running) return; // jangan tabrak run yang sedang berjalan
    if (!igSchedule.nextRunAt) return;
    if (new Date().getTime() >= new Date(igSchedule.nextRunAt).getTime()) {
      console.log('[ig-schedule] 🕐 Waktunya jalan otomatis, menjalankan run...');
      await runScheduledIgScan('schedule');
    }
  })().catch((err: any) => {
    console.error('[ig-schedule] error pada siklus cek jadwal:', err?.message || err);
    igSchedule.lastStatus = `Gagal pada siklus jadwal: ${(err?.message || 'unknown').slice(0, 200)}`;
    try { saveIgSchedule(); } catch { /* ignore */ }
  });
}, 30 * 1000);

// Use search engines to discover real public IG post/reel URLs.
// Account sources are searched first (they are the most precise), then the broader keyword
// queries. Queries are processed in parallel groups (DISCOVERY_CONCURRENCY) to cut wall time.
// Each query paginates DuckDuckGo through r.jina.ai (renders JS into markdown) until no new
// results (cap DISCOVERY_MAX_PAGES). A shared jina budget (DISCOVERY_MAX_JINA_REQUESTS)
// stops discovery cleanly once exhausted. Only posts inside the daysBack recency window
// (when a date is parseable) are kept. Newly found posts are streamed through onPost so
// analysis can start while discovery is still running, and shouldAbort lets the pipeline
// stop early.
async function discoverPosts(
  queries: string[],
  instagramAccounts: string[],
  daysBack: number,
  onPost?: (post: ScannedPost) => void,
  shouldAbort?: () => boolean,
  onQueryDone?: (done: number, total: number, query: string) => void
): Promise<ScannedPost[]> {
  const found = new Map<string, ScannedPost>();
  const pushedUrls = new Set<string>();
  const searchQueries: string[] = [];
  discoveryNoiseSkipped = 0;
  discoveryRecencySkipped = 0;

  for (const handle of instagramAccounts) {
    // "/p/" supaya hasilnya link POST asli, bukan halaman profil IG
    // (halaman profil tidak punya shortcode /p/ sehingga terbuang sia-sia).
    // Reels juga sering memuat lowongan kerja, jadi akun ikut dicari via /reel/.
    searchQueries.push(`site:instagram.com/p/ ${handle}`);
    searchQueries.push(`site:instagram.com/reel/ ${handle}`);
  }
  for (const q of queries) {
    searchQueries.push(`site:instagram.com/p/ ${q}`);
    searchQueries.push(`site:instagram.com/reel/ ${q}`);
  }

  const limited = searchQueries.slice(0, DISCOVERY_QUERY_LIMIT);
  resetSearchStats();
  console.log(
    `[discovery] ${limited.length} query dimulai (format baru: ${limited[0] || '(kosong)'})`
  );
  const startMs = Date.now();
  let budgetExhausted = false;

  const flushPushed = () => {
    if (!onPost) return;
    for (const post of found.values()) {
      if (pushedUrls.has(post.url)) continue;
      pushedUrls.add(post.url);
      onPost(post);
    }
  };

  const runQuery = async (query: string, index: number) => {
    if (shouldAbort?.() || budgetExhausted) return;
    const encoded = encodeURIComponent(query);

    // Paginate DDG via r.jina.ai (renders JS into markdown). Direct DDG/Google/Bing fetch is
    // blocked or returns no IG post links from this network, so jina is the primary path.
    for (let page = 0; page < DISCOVERY_MAX_PAGES; page++) {
      if (shouldAbort?.() || budgetExhausted) return;
      await sleep(DISCOVERY_DELAY_MS + (index % DISCOVERY_CONCURRENCY) * 200);

      const ddgUrl =
        page === 0
          ? `https://html.duckduckgo.com/html/?q=${encoded}`
          : `https://html.duckduckgo.com/html/?q=${encoded}&s=${page * 30}`;

      let pageHtml = '';
      try {
        searchStats.requests++;
        pageHtml = await fetchViaJinaReader(ddgUrl);
      } catch (err: any) {
        searchStats.failed++;
        if ((err.message || '').includes('JINA_BUDGET_EXCEEDED')) {
          budgetExhausted = true;
          return; // budget done -> stop gracefully, no per-query error spam
        }
        const msg = err.message || '';
        if (/4\d\d|rate|limit|aborted/i.test(msg)) {
          searchStats.rateLimited++;
          console.warn(`[discovery] rate-limit saat query "${query}" (halaman ${page + 1}); jeda 5 detik...`);
          await sleep(5000);
        } else {
          console.warn(`[discovery] query gagal "${query}" (halaman ${page + 1}): ${msg}`);
        }
        if (page === 0) return; // first page failed -> skip the whole query
        continue;
      }

      if (!pageHtml) {
        searchStats.failed++;
        console.warn(`[discovery] respons kosong untuk query "${query}" (halaman ${page + 1})`);
        if (page === 0) return;
        continue;
      }

      // r.jina.ai always returns markdown; parse it into the shared pool.
      const added = ingestDiscoveryPage(pageHtml, found, daysBack);
      flushPushed();
      console.log(
        `[discovery] query "${query}" halaman ${page + 1}: ${added} shortcode baru (total ${found.size})`
      );
      if (added === 0) break; // no new results -> stop paginating
    }
  };

  // Run queries in parallel groups (DISCOVERY_CONCURRENCY at a time).
  let queriesDone = 0;
  for (let start = 0; start < limited.length; start += DISCOVERY_CONCURRENCY) {
    if (shouldAbort?.() || budgetExhausted) break;
    const group = limited.slice(start, start + DISCOVERY_CONCURRENCY);
    await Promise.all(
      group.map(async (query, offset) => {
        await runQuery(query, start + offset);
        queriesDone++;
        onQueryDone?.(queriesDone, limited.length, query);
      })
    );
  }

  flushPushed();
  const elapsed = Math.round((Date.now() - startMs) / 1000);
  if (budgetExhausted) {
    console.warn(
      `[discovery] jina budget habis (${DISCOVERY_MAX_JINA_REQUESTS}) → discovery dihentikan lebih awal`
    );
  }
  console.log(
    `[discovery] selesai: ${limited.length} query, ${searchStats.requests} request, ${searchStats.failed} gagal (${searchStats.rateLimited} rate-limited), ${elapsed} detik, ${found.size} shortcode (${discoveryNoiseSkipped} dibuang non-loker, ${discoveryRecencySkipped} dibuang di luar daysBack=${daysBack})`
  );
  return Array.from(found.values());
}

// ----------------------------- Analysis -----------------------------

function cleanCaptionRaw(raw: string): string {
  return raw
    .replace(/\\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\u0026/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Extract the full caption from an Instagram post page HTML (og:description or caption_text JSON).
function extractCaptionFromHtml(html: string): string {
  const ogMatch =
    html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([\s\S]*?)["']/i) ||
    html.match(/<meta[^>]*content=["']([\s\S]*?)["'][^>]*property=["']og:description["']/i);
  if (ogMatch) {
    const og = cleanCaptionRaw(ogMatch[1])
      .replace(/^[^:]* on Instagram:\s*"?/, '')
      .replace(/"\s*$/, '');
    if (og.length > 20) return og.slice(0, 2200);
  }
  const ctMatch = html.match(/"caption_text":"([\s\S]*?)","/);
  if (ctMatch) {
    const ct = cleanCaptionRaw(ctMatch[1]);
    if (ct.length > 20) return ct.slice(0, 2200);
  }
  return '';
}

// Fetch the full caption of a text-based IG post without login, so loker info that
// lives in the caption (not the poster image) is still detected & reported.
// Single fast attempt (8s): IG is often login-walled, so retries just burn time.
async function fetchFullPostCaption(postUrl: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(postUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
      },
    });
    if (!response.ok) return '';
    const html = await response.text();
    return extractCaptionFromHtml(html);
  } catch {
    return '';
  } finally {
    clearTimeout(timeout);
  }
}

// Analyze an Instagram post as a WHOLE (single image = cover + full caption). Each post
// produces at most ONE result / Excel row. Multi-slide carousels are NOT broken into
// separate rows; the caption and primary image carry the job details.

async function analyzeScrapedPost(
  post: ScannedPost,
  bankingOnly: boolean,
  platform: Platform = 'Instagram',
  sourceContext = 'Postingan Feed',
  focusKeyword?: string
): Promise<(Record<string, unknown> | null)[]> {
  const results: (Record<string, unknown> | null)[] = [];

  let caption = post.caption || '';

  // Enrich short/missing captions with the full post text so text-only loker posts
  // (no poster image) are still captured by the AI.
  if (caption.trim().length < 40) {
    const full = await fetchFullPostCaption(post.url);
    if (full && full.trim().length > caption.trim().length) {
      caption = full.trim();
    }
  }

  // Use the post's primary image (cover) as the single visual input.
  let imageUrl = post.imageUrl || '';
  if (!imageUrl && post.shortcode) {
    imageUrl = `https://www.instagram.com/p/${post.shortcode}/media/?size=l`;
  }

  try {
    const parts: ContentPart[] = [];
    parts.push({ text: buildSystemPrompt(post.sourceLabel, post.url, undefined, focusKeyword) });

    if (post.username) {
      parts.push({ text: `--- USERNAME AKUN ---\n@${post.username}` });
    }
    if (caption && caption.trim().length > 0) {
      parts.push({ text: `--- TEKS CAPTION POSTINGAN ---\n${caption.trim()}` });
    }
    if (post.url && post.url.trim().length > 0) {
      parts.push({ text: `--- URL POSTINGAN ---\n${post.url.trim()}` });
    }

    const usedImages: string[] = [];
    if (imageUrl) {
      const img = await fetchImageAsBase64(imageUrl);
      if (img) {
        usedImages.push(imageUrl);
        parts.push({ inlineData: img });
      }
    }

    const parsed = await generateVacancyJson(parts);

    if (parsed.isVacancy === false) {
      autoScanStats.bukanLoker++;
      console.log(
        `[auto-scan] BUKAN LOKER: ${post.shortcode} "${(caption || '').replace(/\s+/g, ' ').slice(0, 60)}"`
      );
      return results;
    }

    if (bankingOnly && parsed.isBankingSector !== true) {
      autoScanStats.bukanLoker++;
      console.log(
        `[auto-scan] NON-BANKING: ${post.shortcode} "${parsed.jobTitle || ''}" sektor=${parsed.isBankingSector}`
      );
      return results;
    }

    // Langkah kedua (per-position refinement): jika ekstraksi awal menghasilkan <= 1 entri
    // positions (misal AI menggabungkan beberapa posisi dalam satu title, atau daftar posisi
    // hanya ada di slide/gambar tanpa pemisah), minta Gemini membaca ULANG semua slide + caption
    // untuk mendaftar SATU entri per posisi beserta jobdesk/jobspek/keahlian yang unik.
    if ((Array.isArray(parsed.positions) ? parsed.positions.length : 0) <= 1) {
      const refined = await refineVacancyPositions({
        sourceLabel: post.sourceLabel,
        url: post.url,
        caption,
        currentJobTitle: typeof parsed.jobTitle === 'string' ? parsed.jobTitle : '',
        currentPositions: parsed.positions,
        imageParts: parts.filter((p) => Boolean(p.inlineData)),
      });
      if (refined) parsed.positions = refined as unknown as Record<string, unknown>[];
    }

    const now = new Date();
    const vacancyId = `loker-${now.getTime()}-${Math.random().toString(36).substring(2, 7)}`;
    const feedId = `bot-${now.getTime()}-${Math.random().toString(36).substring(2, 7)}`;

    const accountName = post.username ? `@${post.username}` : post.sourceLabel;
    const description = (parsed.description as string) || caption || '';
    const jobTitle = (parsed.jobTitle as string) || '';
    const postDateLabel = post.postDate ? formatDateLabel(post.postDate) : 'Hari ini';
    const daysAgo = post.postDate
      ? Math.max(0, Math.floor((now.getTime() - new Date(post.postDate).getTime()) / 86400000))
      : 0;
    // Tandai hasil tanpa email (tetap dimasukkan) agar jelas di UI bahwa ini disengaja.
    const contactInfo = ((parsed.contactInfo as Record<string, unknown> | undefined) ||
      {}) as Record<string, unknown>;
    const hasEmail = typeof contactInfo.email === 'string' && contactInfo.email.trim().length > 0;

    // Lightweight favicon-only logo lookup for auto-scan (keeps the batch fast)
    const autoLogoDataUrl = await resolveCompanyLogo(parsed, { deep: false });

    results.push({
      id: feedId,
      platform,
      sourceContext,
      accountName,
      accountHandle: post.username ? `@${post.username}` : '',
      avatarUrl: '',
      postTitle: jobTitle || (parsed.companyName as string) || 'Lowongan Kerja',
      postSnippet: description || (parsed.summary as string) || (parsed.detectionReason as string) || '',
      postDate: postDateLabel,
      daysAgo,
      imageUrl: usedImages[0] || '',
      isBanking: parsed.isBankingSector === true,
      vacancyData: {
        id: vacancyId,
        ...parsed,
        description,
        sourceUrl: post.url,
        platform,
        sourceContext,
        detectedAt: now.toISOString(),
        postDate: postDateLabel,
        daysAgo,
        images: usedImages,
        logoDataUrl: autoLogoDataUrl || undefined,
        contactEmailMissing: hasEmail ? false : true,
      },
    });
  } catch (err: any) {
    autoScanStats.errors++;
    console.warn(
      `[auto-scan] gagal menganalisis ${post.shortcode}: ${err.message || 'unknown error'}`
    );
  }

  return results;
}

// ----------------------------- API: Analyze Loker (manual multimodal) -----------------------------

// Utility to attempt open-graph / public metadata fetching for direct URLs
async function fetchUrlMetadata(targetUrl: string) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    const response = await fetch(targetUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
      },
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return { htmlText: '', ogImages: [], error: `HTTP status ${response.status}` };
    }

    const html = await response.text();

    // Basic extraction of meta tags
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const ogTitleMatch = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
    const ogDescMatch = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i);
    const ogImageMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i);

    // Clean html to text snippet
    const cleanText = html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 3000);

    const metaInfo = [
      ogTitleMatch ? `Judul OG: ${ogTitleMatch[1]}` : titleMatch ? `Judul: ${titleMatch[1]}` : '',
      ogDescMatch ? `Deskripsi OG: ${ogDescMatch[1]}` : '',
    ].filter(Boolean).join('\n');

    return {
      metaText: metaInfo || cleanText.slice(0, 800),
      ogImage: ogImageMatch ? ogImageMatch[1] : null,
      rawSnippet: cleanText.slice(0, 1500),
    };
  } catch (err: any) {
    console.warn('URL Fetch warning:', err.message);
    return { metaText: '', ogImage: null, rawSnippet: '', error: err.message };
  }
}

app.post('/api/analyze-loker', async (req, res) => {
  try {
    const { url, text, images, sourceType } = req.body;

    if (!text && (!images || images.length === 0) && !url) {
      return res.status(400).json({
        success: false,
        error: 'Sediakan salah satu: URL postingan/profil, Teks caption, atau Tangkapan Layar (Gambar poster/sorotan IG).',
      });
    }

    let fetchedMetaText = '';
    let fetchedOgImage = null;
    let urlFetchWarning = '';

    if (url && url.trim().length > 0) {
      const metadata = await fetchUrlMetadata(url.trim());
      if (metadata.metaText || metadata.rawSnippet) {
        fetchedMetaText = `\n--- TEKS METADATA DARI URL (${url}) ---\n${metadata.metaText}\n${metadata.rawSnippet}`;
      }
      if (metadata.ogImage) {
        fetchedOgImage = metadata.ogImage;
      }
      if (metadata.error) {
        urlFetchWarning = `Sistem telah memproses tautan, namun halaman terlindungi login wall/CORS (${metadata.error}). Hasil analisis dioptimalkan dari teks & tangkapan layar yang Anda sediakan.`;
      }
    }

    // Prepare content parts for Gemini Multimodal
    const parts: ContentPart[] = [];

    parts.push({
      text: buildSystemPrompt(sourceType || 'Media Sosial / Gambar Uploaded', url, fetchedMetaText),
    });

    // Include text if provided
    if (text && text.trim().length > 0) {
      parts.push({
        text: `--- TEKS CAPTION / DOKUMEN INPUT USER ---\n${text.trim()}`,
      });
    }

    // Include image attachments (base64 data)
    if (Array.isArray(images) && images.length > 0) {
      for (const imgBase64 of images) {
        // Strip data:image/...;base64, prefix if present
        let cleanBase64 = imgBase64;
        let mimeType = 'image/jpeg';

        if (imgBase64.startsWith('data:')) {
          const mimeMatch = imgBase64.match(/data:([^;]+);base64,/);
          if (mimeMatch) {
            mimeType = mimeMatch[1];
          }
          cleanBase64 = imgBase64.replace(/^data:[^;]+;base64,/, '');
        }

        parts.push({
          inlineData: {
            mimeType,
            data: cleanBase64,
          },
        });
      }
    }

    // If the pasted URL is an Instagram post, also resolve all carousel slides (multi-image)
    const igSlideUrls: string[] = [];
    if (url && url.trim().length > 0 && /instagram\.com\/p\//i.test(url)) {
      const shortcode = url.match(/\/p\/([A-Za-z0-9_-]{6,})/)?.[1];
      if (shortcode) {
        const slides = await resolvePostSlideUrls(shortcode);
        for (const s of slides.slice(0, MAX_SLIDES)) {
          const img = await fetchImageAsBase64(s);
          if (img) {
            igSlideUrls.push(s);
            parts.push({ inlineData: img });
          }
        }
      }
    }

    const parsedResult = await generateVacancyJson(parts);

    // Pasangkan kedua (per-position refinement) untuk alur manual/paste-link: jika ekstraksi
    // awal menghasilkan <= 1 entri positions, baca ulang semua slide + gambar untuk mendaftar
    // SATU entri per posisi (AI menangani daftar tanpa pemisah / tersebar di slide).
    if ((Array.isArray(parsedResult.positions) ? parsedResult.positions.length : 0) <= 1) {
      const refined = await refineVacancyPositions({
        sourceLabel: sourceType || 'Media Sosial / Gambar Uploaded',
        url,
        caption: typeof parsedResult.description === 'string' ? parsedResult.description : undefined,
        currentJobTitle: typeof parsedResult.jobTitle === 'string' ? parsedResult.jobTitle : '',
        currentPositions: parsedResult.positions,
        imageParts: parts.filter((p) => Boolean(p.inlineData)),
      });
      if (refined) parsedResult.positions = refined as unknown as Record<string, unknown>[];
    }

    // Resolve the official company logo (bank/BPR logo from its website) for the Excel export
    const logoDataUrl = await resolveCompanyLogo(parsedResult);

    // Map platform and context
    let platform: 'Instagram' | 'Facebook' | 'Uploaded Screenshot' | 'Lainnya' = 'Uploaded Screenshot';
    if (url) {
      if (url.includes('instagram.com')) platform = 'Instagram';
      else if (url.includes('facebook.com') || url.includes('fb.com')) platform = 'Facebook';
      else platform = 'Lainnya';
    }

    let sourceContext: 'Sorotan (Highlights)' | 'Postingan Feed' | 'InstaStory' | 'Grup Facebook' | 'Halaman Profil' | 'Poster / Gambar' = 'Poster / Gambar';
    if (sourceType === 'instagram_highlight') sourceContext = 'Sorotan (Highlights)';
    else if (sourceType === 'instagram_post') sourceContext = 'Postingan Feed';
    else if (sourceType === 'instagram_story') sourceContext = 'InstaStory';
    else if (sourceType === 'facebook_group') sourceContext = 'Grup Facebook';
    else if (sourceType === 'facebook_post') sourceContext = 'Postingan Feed';

    const resultData = {
      id: `loker-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      ...parsedResult,
      sourceUrl: url || undefined,
      platform,
      sourceContext,
      detectedAt: new Date().toISOString(),
      images: images || (igSlideUrls.length > 0 ? igSlideUrls : fetchedOgImage ? [fetchedOgImage] : []),
      logoDataUrl: logoDataUrl || undefined,
      isExpired: isDeadlineExpired(parsedResult.deadline as string | undefined),
    };

    return res.json({
      success: true,
      data: resultData,
      warning: urlFetchWarning || undefined,
    });
  } catch (err: any) {
    console.error('Error in /api/analyze-loker:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Gagal menganalisis lowongan kerja dengan Gemini AI.',
    });
  }
});

// ----------------------------- API: Auto-Scan Bot (real dynamic IG data) -----------------------------

// Summary of configured sources for the UI
app.get('/api/auto-scan/sources', (_req, res) => {
  try {
    const config = loadScanSources();
    const instagramCount = config.queries.length + config.instagramAccounts.length;
    return res.json({
      success: true,
      data: {
        instagram: config.instagramAccounts.map((h) => ({
          url: `https://www.instagram.com/${h}/`,
          accountName: h,
          accountHandle: `@${h}`,
          sourceContext: 'Halaman Profil',
          isBanking: false,
        })),
        facebook: config.facebook.map((g) => {
          const isGroup = /groups\//i.test(g);
          return {
            url: g,
            accountName: g,
            accountHandle: g,
            sourceContext: isGroup ? 'Grup Facebook' : 'Halaman Profil',
            isBanking: false,
          };
        }),
        queryCount: config.queries.length,
        facebookEnabled: FACEBOOK_ENABLED,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message || 'Gagal membaca daftar sumber.' });
  }
});

// Live progress/log/results untuk IG auto-scan (dipoll frontend tiap ~2 detik saat run
// berlangsung — pola sama seperti /api/facebook/auto-scan/progress).
app.get('/api/auto-scan/progress', (_req, res) => {
  res.json({ success: true, progress: igScanProgress });
});

// Run the actual bot: discover IG posts -> fetch caption+image -> Gemini OCR -> banking vacancies
// ----------------------------- IG Auto-Scan (manual + scheduled) -----------------------------

interface IgAutoScanParams {
  maxPosts?: number;
  daysBack?: number;
}

interface IgAutoScanResult {
  success: boolean;
  data: Record<string, unknown>[];
  warnings: string[];
  diagnostics: {
    queries: number;
    discovered: number;
    analyzed: number;
    bukanLoker: number;
    errorCount: number;
    duplicates: number;
    results: number;
  };
  error?: string;
}

// Logika inti auto-scan Instagram, dipakai bersama oleh endpoint manual dan penjadwal
// otomatis (scheduler). Menjalankan discovery -> analisis Gemini -> hasil loker perbankan,
// sekaligus memperbarui igScanProgress agar UI polling tetap live.
async function runIgAutoScan(params: IgAutoScanParams = {}): Promise<IgAutoScanResult> {
  const { maxPosts, daysBack } = params;
  const warnings: string[] = [];

  const config = loadScanSources();

  if (!config.queries.length && !config.instagramAccounts.length) {
    return {
      success: false,
      error: `Tidak ada query/akun terkonfigurasi di ${SCAN_SOURCES_FILE}.`,
      data: [],
      warnings,
      diagnostics: { queries: 0, discovered: 0, analyzed: 0, bukanLoker: 0, errorCount: 0, duplicates: 0, results: 0 },
    };
  }

  // Query HANYA dari loker-sources.json (instruksi user: jangan pakai keyword UI).
  // Keyword UI diabaikan supaya hasil selalu ada dari query paten yang terbukti.
  const queries = Array.from(
    new Set(
      (Array.isArray(config.queries) ? config.queries : [])
        .map((s) => String(s).trim())
        .filter(Boolean)
    )
  );

  const daysBackNum = Math.max(1, Math.min(365, Number(daysBack) || 30));
  resetJinaBudget();
  resetSearchStats();

  // Seluruh alur scan (running → selesai/error) dibungkus try/finally agar flag running
  // SELALU di-reset, apa pun yang terjadi. Sebelumnya flag hanya di-set false di akhir
  // alur normal; jika terjadi error di tengah, running tersangkut true dan membuat
  // scheduler auto-run selamanya di-skip ("Dilewati — sedang berjalan"). Ini akar
  // masalah jadwal otomatis "tidak jalan".
  try {
  // Stage 1: Discovery — find real public Instagram post URLs via search engine.
  // Pipeline: discovery runs in the background and streams posts to the analyzers as soon
  // as they are found, so discovery and analysis overlap (total time ~ max, not sum).
  // Discovery aborts early once the target is reached; if the pool runs dry first, analysis
  // stops at whatever was found. Hanya hasil BPR/Koperasi/LPD yang diterima (auto-scan IG),
  // dan target dihitung sebagai JUMLAH POSISI (bukan jumlah lowongan), jadi "Ambil 20"
  // menghasilkan ±20 posisi. Lowongan terakhir dibiarkan utuh (tanpa pemangkasan posisi),
  // sehingga total akhir bisa sedikit lebih (20-31). Hanya hasil sektor perbankan yang diterima (banking-only).
  const target = Math.max(1, Math.min(100, Number(maxPosts) || 15));
  const results: Record<string, unknown>[] = [];
  const seenUrls = new Set<string>();
  const discovered: ScannedPost[] = [];
  let discoveryDone = false;
  let nextPostIndex = 0;
  let analyzedCount = 0;
  let positionCount = 0;
  resetAutoScanStats();
  resetIgScanProgress();
  igScanProgress.running = true;
  igScanProgress.phase = 'discovering';
  igScanProgress.queriesTotal = queries.length * 2 + config.instagramAccounts.length * 2;
  igScanProgress.message = 'Mencari postingan loker di Instagram...';

  const discoveryPromise = discoverPosts(
    queries,
    config.instagramAccounts,
    daysBackNum,
    (post) => {
      discovered.push(post);
      igScanProgress.postsDiscovered = discovered.length;
      const handle = post.username || post.sourceLabel;
      const cap =
        (post.caption || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 90);
      igScanProgress.postLog = [
        ...igScanProgress.postLog.slice(-59),
        `IG ${handle} | ${post.shortcode}${cap ? ` | ${cap}${cap.length >= 90 ? '...' : ''}` : ''}`,
      ];
    },
    () => positionCount >= target,
    (done, total, query) => {
      igScanProgress.queriesDone = done;
      igScanProgress.queriesTotal = total;
      igScanProgress.phase = 'discovering';
      igScanProgress.message = `Mencari postingan... query ${done}/${total} (${query})`;
    }
  ).finally(() => {
    discoveryDone = true;
  });
  discoveryPromise.catch((err: any) =>
    console.warn(`[auto-scan] discovery berhenti: ${err.message || 'unknown error'}`)
  );

  const worker = async () => {
    while (positionCount < target) {
      // Ambil indeks HANYA saat post tersedia. (Dulu indeks diambil dulu lalu dicek,
      // sehingga saat antrean masih kosong di awal discovery, indeks terbakar habis
      // melampaui discovered.length dan tidak ada satu post pun yang pernah diproses
      // → "0 dianalisis" meski ratusan post ditemukan.)
      if (nextPostIndex >= discovered.length) {
        // No post available yet: if discovery has finished, there is nothing left to analyze.
        if (discoveryDone) break;
        await sleep(150); // wait for more posts streaming in from background discovery
        continue;
      }
      const post = discovered[nextPostIndex++];
      try {
        // bankingOnly=true: hasil HANYA lowongan sektor perbankan (bank/BPR,
        // fintech, koperasi simpan pinjam). F&B/crew outlet/retail/hotel dll
        // ditolak sebagai NON-BANKING. Untuk auto-scan IG, setelah analisis,
        // lowongan dengan institutionType di luar BPR/Koperasi/LPD ditolak NON-BPR.
        //
        // analyzeScrapedPost menganalisis SATU postingan utuh (gambar utama +
        // caption) dan mengembalikan maksimal 1 hasil per postingan = 1 baris Excel.
        const vacancies = await analyzeScrapedPost(post, true);
        analyzedCount++;
        igScanProgress.postsAnalyzed = analyzedCount;
        igScanProgress.phase = 'analyzing';
        const postUrl = post.url;
        for (const vacancy of vacancies) {
          if (!vacancy) continue;
          const vd = (vacancy.vacancyData as Record<string, unknown> | undefined) || {};
          // Filter jenis institusi: HANYA BPR / Koperasi (KSP/USP) / LPD yang diterima.
          // Bank umum/BUMN/Persero/BPD/bank umum syariah (BSI), Pegadaian, Asuransi,
          // dan Fintech/Pembiayaan dihitung sebagai NON-BPR dan dibuang.
          const inst = typeof vd.institutionType === 'string' ? vd.institutionType : '';
          if (!ALLOWED_INSTITUTION_RE.test(inst)) {
            autoScanStats.bukanLoker++;
            console.log(
              `[auto-scan] NON-BPR: ${post.shortcode} "${vd.jobTitle || ''}" jenis=${inst || '(tidak diketahui)'} | ${postUrl}`
            );
            continue;
          }
          // Dedupe berdasarkan ID vacancy (unik per hasil) untuk keamanan ekstra.
          const vId = String((vacancy.vacancyData as { id?: unknown } | undefined)?.id || vacancy.id);
          if (seenUrls.has(vId)) {
            autoScanStats.duplicates++;
            continue;
          }
          seenUrls.add(vId);
          // Guard target posisi: berhenti menerima lowongan baru begitu target posisi
          // tercapai (lowongan yang sedang diproses tetap masuk utuh, tanpa pangkas posisi).
          if (positionCount >= target) break;
          results.push(vacancy);
          const nPos = expandPositions(vd as unknown as import('./src/types').JobVacancy).length;
          positionCount += nPos;
          igScanProgress.resultCount = positionCount;
          igScanProgress.results = [...results];
          igScanProgress.message = `Menganalisis... ${analyzedCount} diproses, ${positionCount} posisi loker terkumpul`;
          console.log(
            `[auto-scan] HASIL #${positionCount}: ${vd.companyName || '-'} — ${vd.jobTitle || '-'} (${nPos} posisi) | ${postUrl}`
          );
        }
      } catch (err: any) {
        analyzedCount++;
        autoScanStats.errors++;
        igScanProgress.postsAnalyzed = analyzedCount;
        console.warn(`[auto-scan] gagal memproses ${post.url}: ${err.message || 'unknown error'}`);
      }
    }
  };

  await Promise.all(Array.from({ length: ANALYZE_CONCURRENCY }, () => worker()));
  igScanProgress.running = false;
  igScanProgress.phase = 'done';
  igScanProgress.resultCount = positionCount;
  igScanProgress.results = [...results];
  igScanProgress.message = `Selesai: ${discovered.length} post ditemukan, ${analyzedCount} dianalisis, ${positionCount} posisi loker terkumpul`;
  const diagnostics = {
    queries: queries.length,
    discovered: discovered.length,
    analyzed: analyzedCount,
    bukanLoker: autoScanStats.bukanLoker,
    errorCount: autoScanStats.errors,
    duplicates: autoScanStats.duplicates,
    results: results.length,
    positionCount,
  };
  console.log(
    `[auto-scan] ringkasan: ${queries.length} query, ${discovered.length} post ditemukan, ${analyzedCount} dianalisis (${autoScanStats.bukanLoker} bukan loker, ${autoScanStats.errors} error, ${autoScanStats.duplicates} duplikat), ${positionCount} posisi dari ${results.length} lowongan`
  );

  if (positionCount === 0) {
    warnings.push(
      `Tidak ditemukan lowongan BPR/koperasi: ${discovered.length} post ditemukan, ${analyzedCount} dianalisis (${autoScanStats.bukanLoker} bukan loker/BPR, ${autoScanStats.errors} error). Discovery: ${searchStats.requests} request, ${searchStats.failed} query gagal (${searchStats.rateLimited} rate-limit), ${discoveryRecencySkipped} post dibuang karena di luar rentang ${daysBackNum} hari. Coba tambah akun IG BPR/koperasi di loker-sources.json atau perbesar jumlah postingan/rentang hari.`
    );
  } else if (positionCount < target) {
    warnings.push(
      `Diminta ${target} posisi, terkumpul ${positionCount} posisi dari ${results.length} lowongan (${analyzedCount} dianalisis: ${autoScanStats.bukanLoker} bukan loker/BPR, ${autoScanStats.errors} error). Coba tambah akun IG BPR/koperasi di loker-sources.json.`
    );
  }

  return { success: true, data: results.slice(0, target), warnings, diagnostics };
  } finally {
    // Jaring pengaman: pastikan flag running selalu bersih agar scheduler auto-run
    // tidak selamanya terkunci baik pada sukses maupun saat terjadi error tak terduga.
    igScanProgress.running = false;
    igScanProgress.phase = 'done';
  }
}

app.post('/api/auto-scan', async (req, res) => {
  try {
    const { useInstagram, maxPosts, daysBack } = req.body || {};

    const wantsIG = useInstagram !== false;
    const wantsFB = req.body.platforms ? req.body.platforms.includes('Facebook') : false;

    if (wantsFB && !FACEBOOK_ENABLED) {
      return res.status(400).json({
        success: false,
        error:
          'Facebook untuk sementara nonaktif karena seluruh jalur akses publiknya login-wall. Aktifkan Instagram (checkbox IG) atau set FACEBOOK_ENABLED=true jika Anda menyediakan token Graph API.',
      });
    }

    if (!wantsIG) {
      return res.status(400).json({
        success: false,
        error: 'Pilih minimal satu platform aktif (Instagram).',
      });
    }

    if (igScanProgress.running) {
      return res.status(400).json({
        success: false,
        error: 'Auto-scan IG sedang berjalan. Tunggu sampai selesai.',
      });
    }

    const result = await runIgAutoScan({ maxPosts, daysBack });
    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }
    await sendWhatsAppNotification(countTotalPositions(result.data ?? []), daysBack);
    return res.json({ success: true, data: result.data, warnings: result.warnings, diagnostics: result.diagnostics });
  } catch (err: any) {
    console.error('Error in /api/auto-scan:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Gagal menjalankan auto-scan bot.',
    });
  }
});

// ----------------------------- API: IG Auto-Schedule -----------------------------

// Baca konfigurasi jadwal otomatis.
app.get('/api/auto-scan/scheduled', (_req, res) => {
  loadIgSchedule();
  pruneScheduledResults();
  res.json({ success: true, schedule: igSchedule });
});

// Simpan / perbarui konfigurasi jadwal otomatis.
app.post('/api/auto-scan/scheduled', (req, res) => {
  try {
    const body = req.body || {};
    const enabled = Boolean(body.enabled);
    const rawInterval = Number(body.intervalDays);
    const intervalDays = Math.max(0, Math.min(365, Number.isNaN(rawInterval) ? 3 : rawInterval));
    const hour = Math.max(0, Math.min(23, Number(body.hour) || 0));
    const minute = Math.max(0, Math.min(59, Number(body.minute) || 0));
    const daysBack = Math.max(1, Math.min(365, Number(body.daysBack) || 3));
    const maxPosts = Math.max(1, Math.min(100, Number(body.maxPosts) || 15));

    igSchedule = {
      ...igSchedule,
      enabled,
      intervalDays,
      hour,
      minute,
      daysBack,
      maxPosts,
    };

    if (enabled) {
      // Susun nextRunAt dengan benar:
      // - Belum pernah run → kemunculan HH:MM berikutnya (hari ini bila masih belum lewat, besok bila sudah lewat).
      // - Sudah pernah run → lastRunAt + intervalDays (jarak "setiap N hari" tetap dihormati).
      // Untuk menghindari kebingungan saat user baru set jam di menit yang lewat hari itu, run
      // perdana selalu dijadwalkan ke kemunculan berikutnya — bukan lompat beberapa hari.
      refreshNextRunAt();
    } else {
      igSchedule.nextRunAt = null;
    }
    saveIgSchedule();
    res.json({ success: true, schedule: igSchedule });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || 'Gagal menyimpan jadwal.' });
  }
});

// Jalankan run terencana sekarang (untuk tombol "Jalankan Sekarang").
app.post('/api/auto-scan/scheduled/run-now', async (_req, res) => {
  try {
    if (igScanProgress.running) {
      return res.status(400).json({ success: false, error: 'Auto-scan IG sedang berjalan. Tunggu sampai selesai.' });
    }
    await runScheduledIgScan('manual');
    return res.json({ success: true, schedule: igSchedule });
  } catch (err: any) {
    console.error('Error in /api/auto-scan/scheduled/run-now:', err);
    return res.status(500).json({ success: false, error: err.message || 'Gagal menjalankan run sekarang.' });
  }
});

// Daftar batch hasil terjadwal (urut waktu terbaru), retensi 30 hari sudah diterapkan.
app.get('/api/auto-scan/scheduled/results', (_req, res) => {
  pruneScheduledResults();
  const batches = loadScheduledResults().map((b) => ({
    ...b,
    results: undefined,
    vacancyCount: b.results.length,
  }));
  res.json({ success: true, data: batches });
});

// Detail satu batch (untuk preview / export).
app.get('/api/auto-scan/scheduled/results/:id', (req, res) => {
  const batches = loadScheduledResults();
  const batch = batches.find((b) => b.id === req.params.id);
  if (!batch) {
    return res.status(404).json({ success: false, error: 'Batch tidak ditemukan atau sudah kedaluwarsa (30 hari).' });
  }
  res.json({ success: true, data: batch });
});

// Generate & unduh Excel untuk satu batch.
app.post('/api/auto-scan/scheduled/results/:id/export', async (req, res) => {
  try {
    const batches = loadScheduledResults();
    const batch = batches.find((b) => b.id === req.params.id);
    if (!batch) {
      return res.status(404).json({ success: false, error: 'Batch tidak ditemukan atau sudah kedaluwarsa (30 hari).' });
    }
    const vacancies = batch.results.map((r) => r.vacancyData as import('./src/types').JobVacancy);
    const { exportVacanciesToExcelBuffer } = await import('./src/utils/excelExporter');
    const buffer = await exportVacanciesToExcelBuffer(vacancies);
    const filename = `Backup_IG_${batch.capturedAt.replace(/[:.]/g, '-')}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err: any) {
    console.error('Error exporting scheduled batch:', err);
    res.status(500).json({ success: false, error: err.message || 'Gagal mengekspor batch.' });
  }
});

// Hapus satu batch secara manual.
app.delete('/api/auto-scan/scheduled/results/:id', (req, res) => {
  const batches = loadScheduledResults();
  const next = batches.filter((b) => b.id !== req.params.id);
  if (next.length === batches.length) {
    return res.status(404).json({ success: false, error: 'Batch tidak ditemukan.' });
  }
  try {
    writeFileSync(IG_SCHEDULED_RESULTS_FILE, JSON.stringify(next, null, 2), 'utf-8');
    res.json({ success: true, message: 'Batch dihapus.' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || 'Gagal menghapus batch.' });
  }
});

// ----------------------------- API: Facebook Group Scraper (Playwright) -----------------------------
// The user logs in to Facebook once inside an app-controlled Playwright window. The session
// (storageState) is saved to facebook-session.json, then a group URL pasted by the user is
// opened with that session and auto-scrolled to collect loker posts (text + poster images).

const FB_SESSION_FILE = path.join(process.cwd(), 'facebook-session.json');
const FB_LOGIN_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes to finish the manual login

let fbLoginRunning = false;
let fbLoginMessage = 'Belum login Facebook.';
let fbScrapeRunning = false;

// Progress auto-scan yang bisa dipantau frontend (polling) + flag untuk membatalkan.
interface FbScanProgress {
  running: boolean;
  phase: 'starting' | 'collecting' | 'analyzing' | 'done';
  query: string;
  queryIndex: number;
  queriesDone: number;
  queriesTotal: number;
  groupsCrawled: number;
  curatedDone: number;
  curatedTotal: number;
  postsCollected: number;
  postsAnalyzed: number;
  emailsFound: number;
  fallbackAdded: number;
  resultCount: number;
  progress: number;
  message: string;
  postLog: string[];
  results: Record<string, unknown>[];
  elapsedMs: number;
}
let fbScanProgress: FbScanProgress = {
  running: false,
  phase: 'starting',
  query: '',
  queryIndex: 0,
  queriesDone: 0,
  queriesTotal: 0,
  groupsCrawled: 0,
  curatedDone: 0,
  curatedTotal: 0,
  postsCollected: 0,
  postsAnalyzed: 0,
  emailsFound: 0,
  fallbackAdded: 0,
  resultCount: 0,
  progress: 0,
  message: '',
  postLog: [],
  results: [],
  elapsedMs: 0,
};
let fbScanAbort = false;
let fbScanStartMs = Date.now();

function updateFbScanProgress(patch: Partial<FbScanProgress>) {
  fbScanProgress = { ...fbScanProgress, ...patch, elapsedMs: Date.now() - fbScanStartMs };
  const p = fbScanProgress;
  let next: number;
  if (!p.running) {
    next = 100;
  } else if (p.phase === 'analyzing') {
    next = 60 + Math.min(1, p.postsAnalyzed / Math.max(1, p.postsCollected)) * 30;
  } else if (p.phase === 'collecting') {
    next = 25 + Math.min(1, p.queriesDone / Math.max(1, p.queriesTotal)) * 35;
  } else if (p.phase === 'starting' && p.curatedTotal > 0) {
    next = 5 + Math.min(1, p.curatedDone / p.curatedTotal) * 20;
  } else {
    next = 2;
  }
  fbScanProgress.progress = Math.round(Math.max(p.progress, Math.min(100, next)));
}

// Cache hasil pengecekan validitas sesi FB (file sesi ada ≠ sesi masih hidup).
let fbSessionValidCache: { valid: boolean; at: number } | null = null;
const FB_SESSION_PROBE_TTL_MS = 30 * 1000;

// Deteksi apakah halaman yang sedang dibuka adalah layar "belum login / sesi mati"
// (form login, prompt "continue as", halaman kosong "Not Found", dsb).
function isFacebookLoggedOutPage(page: any): Promise<boolean> {
  return page
    .evaluate(() => {
      const url = window.location.href || '';
      if (/\/login(\/|$|\?)|checkpoint/i.test(url)) return true;
      const text = (document.body ? document.body.innerText : '').replace(/\s+/g, ' ');
      if (document.querySelectorAll('input[name="email"]').length > 0) return true;
      if (document.documentElement.outerHTML.length < 2000) return true; // blank / "Not Found"
      return /(lanjutkan sebagai|continue as|gunakan profil lain|buat akun baru|masuk ke facebook|log into facebook)/i.test(
        text
      );
    })
    .catch(() => true);
}

// Verifikasi sesi FB benar-benar hidup: buka beranda, cek tidak ada layar login.
async function probeFacebookSession(): Promise<boolean> {
  if (!hasFacebookSession()) return false;
  if (fbSessionValidCache && Date.now() - fbSessionValidCache.at < FB_SESSION_PROBE_TTL_MS) {
    return fbSessionValidCache.valid;
  }
  let browser: any;
  try {
      browser = await chromium.launch({
        headless: process.env.FACEBOOK_HEADLESS === '1',
        args: ['--disable-blink-features=AutomationControlled'],
      });
      updateFbScanProgress({ message: 'Membuka browser…' });
      const context = await browser.newContext({
      locale: 'id-ID',
      timezoneId: 'Asia/Jakarta',
      viewport: { width: 1280, height: 900 },
      storageState: loadFacebookSession() as any,
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();
    await page
      .goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 45000 })
      .catch(() => {});
    await page.waitForTimeout(6000).catch(() => {});
    const valid = !(await isFacebookLoggedOutPage(page));
    fbSessionValidCache = { valid, at: Date.now() };
    console.log(`[fb-status] Sesi Facebook ${valid ? 'VALID' : 'KADALUARSA/TIDAK AKTIF'}`);
    return valid;
  } catch (err: any) {
    console.warn(`[fb-status] Gagal memverifikasi sesi: ${err?.message || 'unknown'}`);
    return false;
  } finally {
    try {
      await browser?.close();
    } catch {
      /* ignore */
    }
  }
}

function loadFacebookSession(): { cookies?: unknown[]; origins?: unknown[] } | null {
  try {
    if (!existsSync(FB_SESSION_FILE)) return null;
    return JSON.parse(readFileSync(FB_SESSION_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

function hasFacebookSession(): boolean {
  const s = loadFacebookSession();
  if (!s || !Array.isArray(s.cookies)) return false;
  return s.cookies.some(
    (c: any) => c && c.name === 'c_user' && c.value && c.value !== '0'
  );
}

function saveFacebookSession(state: unknown) {
  writeFileSync(FB_SESSION_FILE, JSON.stringify(state), 'utf-8');
}

function clearFacebookSession() {
  try {
    if (existsSync(FB_SESSION_FILE)) unlinkSync(FB_SESSION_FILE);
  } catch {
    /* ignore */
  }
}

function normalizeFacebookUrl(raw: string): string {
  let u = (raw || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  u = u.replace(/^https?:\/\/web\.facebook\.com/i, 'https://www.facebook.com');
  u = u.replace(/^https?:\/\/m\.facebook\.com/i, 'https://www.facebook.com');
  u = u.replace(/[?&]locale=[^&#]*/, '');
  return u;
}

function isFacebookUrl(u: string): boolean {
  return /(?:www\.|web\.|m\.)?facebook\.com|fb\.com/i.test(u);
}

function isFacebookGroupUrl(u: string): boolean {
  return /facebook\.com\/groups\//i.test(u);
}

// Parse Facebook's relative or absolute date strings into a Date (best-effort).
const ID_MONTHS: Record<string, number> = {
  januari: 0,
  februari: 1,
  maret: 2,
  april: 3,
  mei: 4,
  juni: 5,
  juli: 6,
  agustus: 7,
  september: 8,
  oktober: 9,
  november: 10,
  desember: 11,
};

function parseFacebookDate(text: string): Date | null {
  const t = (text || '').trim().toLowerCase();
  if (!t) return null;
  const now = new Date();

  if (/just now|baru saja|saat ini|tadi\b|semalam|hari ini/i.test(t)) return now;

  const minute = t.match(/(\d+)\s*(?:min|mnt|minutes?|menit|m)\b/);
  if (minute) return new Date(now.getTime() - parseInt(minute[1], 10) * 60000);

  const hour = t.match(/(\d+)\s*(?:hrs?|hours?|jam|h)\b/);
  if (hour) return new Date(now.getTime() - parseInt(hour[1], 10) * 3600000);

  if (/yesterday|kemarin/.test(t)) {
    return new Date(now.getTime() - 86400000);
  }
  const days = t.match(/(\d+)\s*(?:d|days?|hari)\b/);
  if (days) return new Date(now.getTime() - parseInt(days[1], 10) * 86400000);
  const weeks = t.match(/(\d+)\s*(?:w|weeks?|minggu)\b/);
  if (weeks) return new Date(now.getTime() - parseInt(weeks[1], 10) * 7 * 86400000);
  const months = t.match(/(\d+)\s*(?:mo|months?|bulan)\b/);
  if (months) return new Date(now.getTime() - parseInt(months[1], 10) * 30 * 86400000);
  const years = t.match(/(\d+)\s*(?:y|years?|tahun)\b/);
  if (years) return new Date(now.getTime() - parseInt(years[1], 10) * 365 * 86400000);

  // Absolute dates: "13 Agustus 2026" (id), "13 August 2026" / "August 13, 2026" (en)
  const idDate = t.match(/(\d{1,2})\s+([a-z]+)\s+(\d{4})/);
  if (idDate) {
    const month = ID_MONTHS[idDate[2]];
    if (month !== undefined) {
      const d = new Date(parseInt(idDate[3], 10), month, parseInt(idDate[1], 10));
      if (!isNaN(d.getTime())) return d;
    }
    const d = new Date(`${idDate[2]} ${idDate[1]}, ${idDate[3]}`);
    if (!isNaN(d.getTime())) return d;
  }
  const enDate = t.match(/([a-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (enDate) {
    const d = new Date(`${enDate[1]} ${enDate[2]}, ${enDate[3]}`);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

// Launch a visible browser so the user can log in to Facebook manually once.
async function runFacebookLoginFlow() {
  let browser: any;
  try {
    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({
      locale: 'id-ID',
      viewport: { width: 1280, height: 820 },
    });
    const page = await context.newPage();
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });

    const deadline = Date.now() + FB_LOGIN_TIMEOUT_MS;
    let loggedIn = false;
    while (Date.now() < deadline) {
      await sleep(2000);
      const cookies: any[] = await context.cookies().catch(() => []);
      if (cookies.some((c) => c.name === 'c_user' && c.value && c.value !== '0')) {
        loggedIn = true;
        break;
      }
    }

    if (loggedIn) {
      const state = await context.storageState();
      saveFacebookSession(state);
      fbSessionValidCache = null; // paksa re-probe validitas
      fbLoginMessage = 'Berhasil terhubung ke Facebook (sesi tersimpan).';
    } else {
      fbLoginMessage = 'Login dibatalkan / melewati batas waktu. Silakan coba lagi.';
    }
  } catch (err: any) {
    fbLoginMessage = `Gagal membuka jendela login: ${err?.message || 'unknown error'}`;
  } finally {
    try {
      await browser?.close();
    } catch {
      /* ignore */
    }
    fbLoginRunning = false;
  }
}

async function dismissFacebookDialogs(page: any) {
  try {
    const allow = page.getByText(/Allow all cookies|Izinkan semua cookie/i).first();
    if (await allow.isVisible({ timeout: 2500 }).catch(() => false)) {
      await allow.click();
      await page.waitForTimeout(800);
    }
  } catch {
    /* ignore */
  }
}

// Best-effort: paksa sort "Recent posts / Postingan terbaru" di feed grup agar post
// terbaru (<= daysBack) muncul lebih dulu. FB default ke "Top posts" yang jarang memuat
// post baru di posisi atas — ini penyebab utama grup hanya menghasilkan sedikit post.
async function tryClickGroupRecentSort(page: any) {
  try {
    const direct = page
      .getByText(/recent posts|postingan terbaru|terbaru/i)
      .first();
    if (await direct.isVisible({ timeout: 2500 }).catch(() => false)) {
      await direct.click();
      await page.waitForTimeout(2500);
      return;
    }
    const sortBtn = page
      .getByRole('button', { name: /top posts|postingan teratas|sort|sortir/i })
      .first();
    if (await sortBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await sortBtn.click();
      await page.waitForTimeout(900);
      const recent = page
        .getByText(/recent posts|postingan terbaru/i)
        .first();
      if (await recent.isVisible({ timeout: 3000 }).catch(() => false)) {
        await recent.click();
        await page.waitForTimeout(2500);
      }
    }
  } catch {
    /* sort control optional */
  }
}

// Best-effort: pada halaman pencarian post, pilih hasil "Recent / Terbaru / Latest"
// (bukan "Top") agar postingan <= daysBack muncul lebih banyak.
async function tryClickSearchRecentFilter(page: any) {
  try {
    const recent = page
      .getByRole('button', { name: /recent|terbaru|latest|posted recently|diposting/i })
      .first();
    if (await recent.isVisible({ timeout: 2500 }).catch(() => false)) {
      await recent.click();
      await page.waitForTimeout(2500);
    }
  } catch {
    /* filter optional */
  }
}

// Postingan FB yang sama dapat berubah parameter pelacak (__cft__, __tn__, locale, ...)
// setiap kali halaman di-render → normalisasi agar dedup berdasarkan identitas post.
function normalizePostUrl(u: string): string {
  try {
    const url = new URL(u);
    url.hash = '';
    const keep = new Set(['fbid', 'set', 'story_fbid', 'id']);
    const sp = new URLSearchParams();
    for (const [k, v] of Array.from(url.searchParams.entries())) {
      if (keep.has(k)) sp.set(k, v);
    }
    url.search = sp.toString();
    return url.toString().replace(/\/\?$/, '');
  } catch {
    return u;
  }
}

// Scroll the group feed and collect post info (link, relative date, text, image URLs).
async function collectFacebookGroupPosts(
  page: any,
  maxPosts: number,
  daysBack: number,
  onProgress?: (count: number, snippet: string) => void
): Promise<{
  posts: any[];
  totalFound: number;
  oldestDate: string | null;
  stoppedByDate: boolean;
}> {
  const posts: any[] = [];
  const indexByUrl = new Map<string, number>();
  const MAX_SCROLLS = 150;
  const COLLECT_BUDGET_MS = 120000; // berhenti maks ~2 menit meski feed terus mengalir
  const collectStart = Date.now();
  const DATE_FRAGMENT_RE =
    /(?:baru saja|tadi\b|semalam|kemarin|hari ini|just now|yesterday|\d+\s*(?:min|mnt|menit|jam|hrs?|hours?|h|d|days?|hari|w|weeks?|minggu|mo|months?|bulan|y|years?|tahun)\b|\d{1,2}\s+[a-z]+\s+\d{4})/i;

  const extract = async (): Promise<any[]> => {
    try {
      return await page.evaluate(() => {
        // Kartu postingan dideteksi lewat tautan permalink, lalu diambil card-nya
        // dari container feed grup (div[role="feed"] > div) ATAU hasil pencarian
        // (div[role="article"]). Pendekatan ini bekerja di feed grup & halaman
        // pencarian Facebook sekaligus.
        const permalinkSel =
          'a[href*="/posts/"], a[href*="/permalink/"], a[href*="/photo/?fbid="], a[href*="?story_fbid="], a[href*="&story_fbid="]';
        const out: any[] = [];
        const cards = new Set<HTMLElement>();
        document.querySelectorAll(permalinkSel).forEach((link) => {
          const card = (link as HTMLElement).closest(
            'div[role="article"], div[role="feed"] > div'
          ) as HTMLElement | null;
          if (card) cards.add(card);
        });
        for (const card of cards) {
          const link = card.querySelector(permalinkSel) as HTMLElement | null;
          if (!link) continue;
          let href = link.getAttribute('href') || '';
          if (href.startsWith('/')) href = window.location.origin + href;
          if (!/^https?:\/\//i.test(href)) continue;
          if (out.some((p) => p.url === href)) continue;

          const authorEl = card.querySelector('a[aria-label]');
          // Tanggal relatif/absolut post diambil dari aria-label tautan permalink,
          // atau teks pendek (<=40 karakter) di dalam kartu yang cocok pola tanggal.
          let ts = '';
          const linkLabel = link.getAttribute('aria-label') || '';
          if (linkLabel && linkLabel.length <= 60) {
            ts = linkLabel;
          } else {
            const dateRe =
              /(baru saja|tadi|semalam|kemarin|hari ini|just now|yesterday|\d+\s*(?:min|mnt|menit|jam|hrs?|hours?|h|d|days?|hari|w|weeks?|minggu|mo|months?|bulan|y|years?|tahun)\b|\d{1,2}\s+[a-z]+\s+\d{4})/i;
            for (const el of Array.from(card.querySelectorAll<HTMLElement>('a, span, time, div'))) {
              const txt = (el.textContent || '').trim();
              if (txt.length > 4 && txt.length <= 40 && dateRe.test(txt)) {
                ts = txt;
                break;
              }
            }
          }
          const imgCandidates: { url: string; area: number }[] = [];
          card.querySelectorAll('img').forEach((img) => {
            const s = img.getAttribute('src') || '';
            if (!s || !s.startsWith('https') || !s.includes('scontent')) return;
            const el = img as HTMLImageElement;
            const w = el.naturalWidth || el.width || 0;
            const h = el.naturalHeight || el.height || 0;
            imgCandidates.push({ url: s, area: w * h });
          });
          card.querySelectorAll<HTMLElement>('[style*="background-image"]').forEach((el) => {
            const m = (el.style.backgroundImage || '').match(/url\(["']?([^"')]+)["']?\)/);
            const s = m ? m[1] : '';
            if (s && s.startsWith('https') && s.includes('scontent')) {
              imgCandidates.push({ url: s, area: 500000 });
            }
          });
          // Poster (gambar ukuran besar) diprioritaskan di depan; avatar kecil di
          // belakang, supaya Gemini menerima poster asli untuk OCR.
          const imgs = [
            ...new Set(
              imgCandidates
                .sort((a, b) => b.area - a.area)
                .map((i) => i.url)
            ),
          ].slice(0, 5);
          // Nama/metadata FB di-obfuscate per-karakter (U+034F/U+200B) dan teks
          // placeholder "Facebook" berulang → buang baris-baris tersebut.
          const text = (card.innerText || '')
            .trim()
            .split('\n')
            .filter(
              (l) => !/[\u034f\u200b]/.test(l) && l.trim() !== 'Facebook'
            )
            .join('\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
          // Kartu bergambar (poster loker) tetap diambil walau caption sangat pendek.
          if (text.length <= 20 && imgs.length === 0) continue;
          out.push({
            url: href,
            ts,
            imgs,
            author: authorEl
              ? authorEl.getAttribute('aria-label') || ''
              : '',
            text,
          });
        }
        return out;
      });
    } catch {
      return [];
    }
  };

  // 1) Tunggu sampai kartu postingan termuat (feed grup / hasil pencarian) — maks 30 detik.
  await page
    .waitForFunction(
      () => {
        const permalinkSel =
          'a[href*="/posts/"], a[href*="/permalink/"], a[href*="/photo/?fbid="], a[href*="?story_fbid="], a[href*="&story_fbid="]';
        for (const link of Array.from(document.querySelectorAll(permalinkSel))) {
          const card = (link as HTMLElement).closest(
            'div[role="article"], div[role="feed"] > div'
          );
          if (card && (card.textContent || '').trim().length > 20) return true;
        }
        return false;
      },
      { timeout: 30000 }
    )
    .catch(() => {
      /* timeout: lanjut, feed mungkin lambat */
    });

  const resolveDate = (p: any): Date | null => {
    let d = parseFacebookDate(p.ts);
    if (d) return d;
    const frag = (p.text || '').match(DATE_FRAGMENT_RE);
    return frag ? parseFacebookDate(frag[0]) : null;
  };

  // 2) Gulir bertahap & kumpulkan postingan hingga target / feed habis / lewat jendela hari.
  let emptyStreak = 0;
  let oldStreak = 0;
  let totalFound = 0;
  let feedHeight = 0;
  let stoppedByDate = false;

  // Ukur tinggi container scroll saat ini untuk mendeteksi apakah feed masih bertambah
  // (FB lazy-load). Hanya bila tinggi berhenti bertambah kita anggap feed benar-benar habis.
  const measureFeedHeight = async (): Promise<number> => {
    try {
      return await page.evaluate(() => {
        const feed = document.querySelector('div[role="feed"]');
        let el = feed;
        while (el && el !== document.body) {
          if (el.scrollHeight > el.clientHeight + 50) return el.scrollHeight;
          el = el.parentElement;
        }
        return document.body.scrollHeight;
      });
    } catch {
      return 0;
    }
  };

  // Warm-up: geser feed sedikit ke bawah lalu kembali agar kartu postingan ter-paksa dimuat
  // (feed FB kadang tidak mengisi kartu sebelum ada aksi scroll).
  try {
    await page.evaluate(() => {
      const feed = document.querySelector('div[role="feed"]');
      let el = feed;
      while (el && el !== document.body) {
        if (el.scrollHeight > el.clientHeight + 50) {
          el.scrollTop += window.innerHeight;
          return;
        }
        el = el.parentElement;
      }
      window.scrollBy(0, window.innerHeight);
    });
    await page.waitForTimeout(2500);
    await page.evaluate(() => {
      const feed = document.querySelector('div[role="feed"]');
      let el = feed;
      while (el && el !== document.body) {
        if (el.scrollHeight > el.clientHeight + 50) {
          el.scrollTop -= window.innerHeight;
          return;
        }
        el = el.parentElement;
      }
      window.scrollBy(0, -window.innerHeight);
    });
    await page.waitForTimeout(1500);
  } catch {
    /* ignore */
  }

  for (let i = 0; i < MAX_SCROLLS; i++) {
    const found = await extract();
    let newThisRound = 0;
    let oldThisRound = 0;

    for (const p of found) {
      const key = normalizePostUrl(p.url);
      const existing = indexByUrl.get(key);
      if (existing !== undefined) {
        if (existing === -1) continue; // sebelumnya ter-filter tanggal
        const prev = posts[existing];
        if ((p.text || '').length > (prev.text || '').length) {
          posts[existing] = { ...prev, ...p };
          const date = resolveDate(posts[existing]);
          if (date) {
            const age = Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000));
            if (age <= daysBack) posts[existing].postDate = date.toISOString();
          }
        }
        continue;
      }
      totalFound++;
      newThisRound++;
      const date = resolveDate(p);
      let kept = false;
      if (date) {
        const age = Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000));
        if (age > daysBack) {
          oldThisRound++;
        } else {
          p.postDate = date.toISOString();
          kept = true;
        }
      } else {
        kept = true; // tanggal tak terbaca → tetap diambil
      }
      if (kept) {
        indexByUrl.set(key, posts.length);
        posts.push(p);
        onProgress?.(posts.length, (p.text || '').replace(/\s+/g, ' ').slice(0, 110));
      } else {
        indexByUrl.set(key, -1);
      }
    }

    if (posts.length >= maxPosts) break;
    const prevHeight = feedHeight;
    const curHeight = await measureFeedHeight();
    const grew = curHeight > prevHeight + 50;
    feedHeight = curHeight;
    if (newThisRound === 0) {
      emptyStreak = grew ? emptyStreak : emptyStreak + 1;
      if (emptyStreak >= 12) break;
    } else {
      emptyStreak = 0;
    }
    if (oldThisRound > 0 && newThisRound === oldThisRound) {
      oldStreak++;
      if (oldStreak >= 4) {
        // Semua post baru sudah lebih tua dari jendela hari yang diminta → sudah sampai dasar jendela.
        stoppedByDate = true;
        break;
      }
    } else {
      oldStreak = 0;
    }

    try {
      await page.evaluate((bigJump: boolean) => {
        const feed = document.querySelector('div[role="feed"]');
        let el = feed;
        while (el && el !== document.body) {
          if (el.scrollHeight > el.clientHeight + 50) {
            if (bigJump) el.scrollTop = el.scrollHeight;
            else el.scrollTop += window.innerHeight * 0.9;
            return;
          }
          el = el.parentElement;
        }
        if (bigJump) window.scrollTo(0, document.body.scrollHeight);
        else window.scrollBy(0, window.innerHeight * 0.9);
      }, i % 5 === 4);
      await page.waitForTimeout(i % 5 === 4 ? 1800 : 1200);
    } catch {
      break;
    }
    if (Date.now() - collectStart > COLLECT_BUDGET_MS) break;
  }

  posts.sort((a: any, b: any) => {
    const da = a.postDate ? new Date(a.postDate).getTime() : Date.now();
    const db = b.postDate ? new Date(b.postDate).getTime() : Date.now();
    return db - da;
  });

  const dated = posts
    .map((p) => (p.postDate ? new Date(p.postDate).getTime() : NaN))
    .filter((n) => !isNaN(n));
  const oldestDate = dated.length ? new Date(Math.min(...dated)).toISOString() : null;
  if (stoppedByDate) {
    console.log(
      `[fb-auto-scan] 📅 Feed sudah mencapai post lebih tua dari ${daysBack} hari — berhenti menggulir di sini.`
    );
  }

  return { posts: posts.slice(0, maxPosts), totalFound, oldestDate, stoppedByDate };
}

// Download poster images inside the logged-in page context (signed scontent URLs).
async function fetchFacebookImagesBase64(
  page: any,
  urls: string[]
): Promise<{ mimeType: string; data: string }[]> {
  const out: { mimeType: string; data: string }[] = [];
  for (const u of urls.slice(0, 3)) {
    try {
      const b64 = await page.evaluate(async (url: string) => {
        const r = await fetch(url);
        if (!r.ok) return null;
        const ab = await r.arrayBuffer();
        const bytes = new Uint8Array(ab);
        let bin = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
        }
        return btoa(bin);
      }, u);
      if (b64) out.push({ mimeType: 'image/jpeg', data: b64 });
    } catch {
      /* skip image */
    }
  }
  return out;
}

// Shared analysis of a collected Facebook post (text + poster images) via Gemini.
// Used by both the group scraper and the whole-Facebook search auto-scan.
// opts.requireBanking keeps only posts the AI classifies as banking sector.
// opts.requireEmail keeps only posts that carry a contact email.
// onSkip is called with a reason whenever a candidate is filtered out (for warnings).
async function analyzeFacebookPost(
  page: any,
  post: any,
  opts: {
    requireBanking?: boolean;
    requireEmail?: boolean;
    defaultContext?: 'Grup Facebook' | 'Halaman Profil' | 'Pencarian Facebook';
  } = {},
  onSkip?: (reason: string, post: any) => void
): Promise<Record<string, unknown> | null> {
  const images = await fetchFacebookImagesBase64(page, post.imgs);
  const parts: ContentPart[] = [];
  const isGroup = isFacebookGroupUrl(post.url || '');
  const sourceContext = (isGroup
    ? 'Grup Facebook'
    : opts.defaultContext || 'Halaman Profil') as
    | 'Grup Facebook'
    | 'Halaman Profil'
    | 'Pencarian Facebook';
  parts.push({
    text: buildSystemPrompt(`Postingan Facebook ${isGroup ? 'Grup' : 'Halaman'}`, post.url),
  });
  if (post.text) {
    parts.push({ text: `--- TEKS POSTINGAN FACEBOOK ---\n${post.text.slice(0, 5000)}` });
  }
  if (post.url) {
    parts.push({ text: `--- URL POSTINGAN ---\n${post.url}` });
  }
  for (const img of images) parts.push({ inlineData: img });

  const parsed = await generateVacancyJson(parts);
  if (parsed.isVacancy === false) {
    onSkip?.('bukan loker', post);
    return null;
  }
  if (isDeadlineExpired(parsed.deadline as string)) {
    onSkip?.('deadline sudah lewat', post);
    return null;
  }
  if (opts.requireBanking && parsed.isBankingSector !== true) {
    onSkip?.('bukan sektor perbankan', post);
    return null;
  }
  const contact = (parsed.contactInfo || {}) as Record<string, unknown>;
  const hasEmail = typeof contact.email === 'string' && contact.email.trim().length > 0;
  if (opts.requireEmail && !hasEmail) {
    onSkip?.('perbankan tanpa email', post);
    return null;
  }

  const now = new Date();
  const dataUrls = images.map((i) => `data:${i.mimeType};base64,${i.data}`);
  const description = (parsed.description as string) || post.text || '';
  const postDateLabel = post.postDate ? formatDateLabel(post.postDate) : 'Hari ini';
  const daysAgo = post.postDate
    ? Math.max(0, Math.floor((now.getTime() - new Date(post.postDate).getTime()) / 86400000))
    : 0;
  const autoLogoDataUrl = await resolveCompanyLogo(parsed, { deep: false });

  const result = {
    id: `bot-fb-${now.getTime()}-${Math.random().toString(36).substring(2, 7)}`,
    platform: 'Facebook' as const,
    sourceContext,
    accountName: 'Anggota Grup Facebook',
    accountHandle: 'Anggota Grup Facebook',
    avatarUrl: '',
    postTitle: (parsed.jobTitle as string) || (parsed.companyName as string) || 'Lowongan Kerja',
    postSnippet: description || (parsed.summary as string) || '',
    postDate: postDateLabel,
    daysAgo,
    imageUrl: dataUrls[0] || '',
    isBanking: parsed.isBankingSector === true,
    vacancyData: {
      id: `loker-fb-${now.getTime()}-${Math.random().toString(36).substring(2, 7)}`,
      ...parsed,
      description,
      sourceUrl: post.url,
      platform: 'Facebook' as const,
      sourceContext,
      detectedAt: now.toISOString(),
      postDate: postDateLabel,
      daysAgo,
      images: dataUrls,
      logoDataUrl: autoLogoDataUrl || undefined,
    },
  };
  return result;
}

// One-time login: opens a visible browser window for the user to complete the login.
app.post('/api/facebook/login', (_req, res) => {
  if (fbLoginRunning) {
    return res.status(400).json({ success: false, error: 'Proses login Facebook sudah berjalan.' });
  }
  if (fbScrapeRunning) {
    return res.status(400).json({ success: false, error: 'Scrape sedang berjalan. Tunggu sampai selesai.' });
  }
  fbLoginRunning = true;
  fbLoginMessage = 'Membuka jendela login Facebook...';
  runFacebookLoginFlow(); // fire-and-forget; UI polls /api/facebook/status
  return res.json({
    success: true,
    message: 'Jendela login Facebook dibuka. Selesaikan login di jendela browser yang muncul.',
  });
});

app.get('/api/facebook/status', async (_req, res) => {
  const hasFile = hasFacebookSession();
  const connected = fbLoginRunning ? true : await probeFacebookSession();
  return res.json({
    success: true,
    connected,
    loggingIn: fbLoginRunning,
    message: fbLoginRunning
      ? 'Jendela login Facebook sedang terbuka — silakan selesaikan login di jendela tersebut.'
      : connected
        ? 'Terhubung ke Facebook (sesi tersimpan & aktif).'
        : hasFile
          ? 'Sesi Facebook tersimpan tapi tampaknya sudah kadaluarsa — silakan login ulang.'
          : fbLoginMessage,
  });
});

app.post('/api/facebook/logout', (_req, res) => {
  clearFacebookSession();
  fbSessionValidCache = null;
  fbLoginMessage = 'Sesi Facebook dihapus.';
  return res.json({ success: true, message: 'Sesi Facebook dihapus.' });
});

// ----------------------------- API: Twitter / X Scraper (Playwright) -----------------------------
// Mirip Facebook: user login X sekali di jendela Playwright, sesi (storageState) disimpan ke
// twitter-session.json. Link X (profil / pencarian / list) yang ditempel user dibuka dengan sesi
// itu lalu di-auto-scroll untuk mengumpulkan tweet (teks + tautan + tanggal), dianalisis Gemini
// dengan filter perbankan (banking-only), dan hasilnya streaming live seperti IG/FB.

const TWITTER_SESSION_FILE = path.join(process.cwd(), 'twitter-session.json');
const TWITTER_LOGIN_TIMEOUT_MS = 10 * 60 * 1000; // 10 menit untuk menyelesaikan login manual

let twLoginRunning = false;
let twLoginMessage = 'Belum login X / Twitter.';

interface TwitterScanProgress {
  running: boolean;
  phase: 'starting' | 'collecting' | 'analyzing' | 'done';
  link: string;
  tweetsCollected: number;
  tweetsAnalyzed: number;
  resultCount: number;
  message: string;
  postLog: string[];
  results: Record<string, unknown>[];
  elapsedMs: number;
}
let twScanProgress: TwitterScanProgress = {
  running: false,
  phase: 'starting',
  link: '',
  tweetsCollected: 0,
  tweetsAnalyzed: 0,
  resultCount: 0,
  message: '',
  postLog: [],
  results: [],
  elapsedMs: 0,
};
let twScanAbort = false;
let twScanStartMs = Date.now();

function updateTwitterScanProgress(patch: Partial<TwitterScanProgress>) {
  twScanProgress = { ...twScanProgress, ...patch, elapsedMs: Date.now() - twScanStartMs };
}

// ----------------------------- API: Threads Scraper (Playwright, tanpa login) -----------------------------
// Threads (threads.net/threads.com) tidak punya public API, tapi profil publik bisa dibaca tanpa
// login: post dirender server-side + DOM [data-pressable-container]. Bot membuka setiap akun
// BPR/bank/koperasi dari loker-sources.json (threadsAccounts), auto-scroll, lalu hasilnya
// dianalisis Gemini dengan filter perbankan (banking-only) — output sama persis seperti IG.

interface ThreadsScanProgress {
  running: boolean;
  phase: 'starting' | 'collecting' | 'analyzing' | 'done';
  accountsTotal: number;
  accountsDone: number;
  currentAccount: string;
  postsCollected: number;
  postsAnalyzed: number;
  resultCount: number;
  message: string;
  postLog: string[];
  results: Record<string, unknown>[];
  elapsedMs: number;
}

let thScanProgress: ThreadsScanProgress = {
  running: false,
  phase: 'starting',
  accountsTotal: 0,
  accountsDone: 0,
  currentAccount: '',
  postsCollected: 0,
  postsAnalyzed: 0,
  resultCount: 0,
  message: '',
  postLog: [],
  results: [],
  elapsedMs: 0,
};
let thScanAbort = false;
let thScanStartMs = Date.now();

function updateThreadsScanProgress(patch: Partial<ThreadsScanProgress>) {
  thScanProgress = { ...thScanProgress, ...patch, elapsedMs: Date.now() - thScanStartMs };
}

// Normalisasi username Threads: "@handle" / "handle" -> "handle" (tanpa @).
function normalizeThreadsHandle(raw: string): string {
  return String(raw || '').trim().replace(/^@/, '').toLowerCase();
}

// Auto-scroll sebuah profil Threads (https://www.threads.net/@handle) dan kumpulkan post
// (teks + tautan + tanggal + gambar pertama). Setiap post baru dipanggil via onPost secara live.
// Tanpa login, profil publik Threads tetap menampilkan post terbaru (cukup untuk loker).
async function scrapeThreadsProfile(
  page: any,
  handle: string,
  daysBackNum: number,
  maxPosts: number,
  onPost?: (post: ScannedPost, total: number) => void
): Promise<ScannedPost[]> {
  const out: ScannedPost[] = [];
  const seen = new Set<string>();
  const deadline = Date.now() + THREADS_SCAN_BUDGET_MS;
  const cutoff = Date.now() - daysBackNum * 86400000;
  const profileUrl = `https://www.threads.net/@${handle}`;

  await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(6000).catch(() => {});

  let staleScrolls = 0;
  while (Date.now() < deadline && out.length < maxPosts && !thScanAbort) {
    const items = await page
      .evaluate(() => {
        const rows: any[] = [];
        const containers = document.querySelectorAll('[data-pressable-container]');
        containers.forEach((a) => {
          const textEl = a.querySelector('span[dir="auto"]') || a;
          const timeEl = a.querySelector('time[datetime]');
          const linkEl = a.querySelector('a[href*="/post/"]');
          const imgEl = a.querySelector('img[src*="cdninstagram"]');
          let href = linkEl ? linkEl.getAttribute('href') || '' : '';
          const m = href.match(/\/(@[A-Za-z0-9_.]+)\/post\/([A-Za-z0-9_-]+)/);
          const permalink = m ? `https://www.threads.net/${m[1]}/post/${m[2]}` : '';
          rows.push({
            text: (textEl as HTMLElement).innerText || '',
            datetime: timeEl ? timeEl.getAttribute('datetime') || '' : '',
            permalink,
            handle: m ? m[1].replace(/^@/, '') : '',
            img: imgEl ? (imgEl as HTMLImageElement).src : '',
          });
        });
        return rows;
      })
      .catch(() => []);

    let addedThisScroll = 0;
    for (const it of items) {
      if (out.length >= maxPosts) break;
      if (!it.permalink || seen.has(it.permalink)) continue;
      const dt = it.datetime ? new Date(it.datetime) : null;
      if (dt && !isNaN(dt.getTime()) && dt.getTime() < cutoff) continue; // di luar rentang hari
      // Precision: buang post yang jelas BUKAN loker sebelum menghabiskan budget Gemini.
      const txt = `${it.text || ''}`.toLowerCase();
      if (txt.trim().length > 30 && !LOKER_SIGNALS.some((s) => txt.includes(s))) continue;
      seen.add(it.permalink);
      const post: ScannedPost = {
        url: it.permalink,
        platform: 'Threads',
        caption: it.text,
        username: it.handle || handle,
        imageUrl: it.img || '',
        sourceLabel: it.handle ? `@${it.handle}` : `@${handle}`,
        postDate: it.datetime || undefined,
      };
      out.push(post);
      addedThisScroll++;
      onPost?.(post, out.length);
    }
    if (addedThisScroll === 0) {
      staleScrolls++;
      if (staleScrolls >= THREADS_SCROLL_STALL_LIMIT) break;
    } else {
      staleScrolls = 0;
    }
    await page.evaluate(() => window.scrollBy(0, 1200)).catch(() => {});
    await page.waitForTimeout(1800).catch(() => {});
  }
  return out;
}

// Status & jumlah akun Threads terkonfigurasi (dipakai UI untuk menampilkan sumber).
app.get('/api/threads/status', (_req, res) => {
  try {
    const config = loadScanSources();
    const accounts = (config.threadsAccounts || []).map(normalizeThreadsHandle).filter(Boolean);
    return res.json({
      success: true,
      enabled: true,
      accountsCount: accounts.length,
      accounts: accounts.map((h) => `https://www.threads.net/@${h}`),
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message || 'Gagal membaca akun Threads.' });
  }
});

// Live progress/log/results untuk Threads auto-scan (dipoll frontend tiap ~2 detik saat run).
app.get('/api/threads/auto-scan/progress', (_req, res) => {
  res.json({ success: true, progress: thScanProgress });
});

// Hentikan auto-scan Threads yang sedang berjalan (dicek pada loop koleksi & analisis).
app.post('/api/threads/auto-scan/stop', (_req, res) => {
  thScanAbort = true;
  console.log('[th-auto-scan] ⏹️ Permintaan stop diterima.');
  res.json({ success: true, message: 'Perintah stop diterima.' });
});

// Run the Threads bot: buka setiap akun di loker-sources.json -> auto-scroll -> Gemini OCR
// (banking-only) -> hasil streaming live sama seperti IG.
app.post('/api/threads/auto-scan', async (req, res) => {
  try {
    const { daysBack, maxPosts } = req.body || {};
    const config = loadScanSources();
    const accounts = (config.threadsAccounts || []).map(normalizeThreadsHandle).filter(Boolean);

    if (accounts.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Tidak ada akun Threads terkonfigurasi di loker-sources.json (key "threadsAccounts").',
      });
    }
    if (thScanProgress.running) {
      return res.status(400).json({
        success: false,
        error: 'Auto-scan Threads sedang berjalan. Tunggu sampai selesai.',
      });
    }

    const daysBackNum = Math.max(1, Math.min(365, Number(daysBack) || 30));
    const target = Math.max(1, Math.min(100, Number(maxPosts) || 15));
    const collectPerAccount = Math.min(target * 3, 40);
    const warnings: string[] = [];
    const bukanLokerStart = autoScanStats.bukanLoker;
    let thErrors = 0;
    let thDuplicates = 0;

    thScanAbort = false;
    thScanStartMs = Date.now();
    updateThreadsScanProgress({
      running: true,
      phase: 'starting',
      accountsTotal: accounts.length,
      accountsDone: 0,
      currentAccount: '',
      postsCollected: 0,
      postsAnalyzed: 0,
      resultCount: 0,
      message: 'Memulai pindai Threads...',
      postLog: [],
      results: [],
    });
    console.log(
      `[th-auto-scan] 🚀 dimulai ${JSON.stringify({ accounts: accounts.length, target, daysBack: daysBackNum, collectPerAccount })}`
    );

    const results: Record<string, unknown>[] = [];
    const seenUrls = new Set<string>();
    let analyzedCount = 0;
    let totalCollected = 0;
    let browser: any;
    try {
      const launched = await launchTwitterBrowser(process.env.FACEBOOK_HEADLESS === '1');
      browser = launched.browser;
      const context = await newTwitterContext(browser, {});
      const page = await context.newPage();

      for (let i = 0; i < accounts.length && !thScanAbort && results.length < target; i++) {
        const handle = accounts[i];
        updateThreadsScanProgress({
          accountsDone: i,
          currentAccount: handle,
          phase: 'collecting',
          message: `Membuka profil @${handle} & mengumpulkan post (auto-scroll)...`,
        });
        console.log(`[th-auto-scan] 📡 membuka profil https://www.threads.net/@${handle}`);

        const posts = await scrapeThreadsProfile(
          page,
          handle,
          daysBackNum,
          collectPerAccount,
          (post, total) => {
            totalCollected++;
            updateThreadsScanProgress({
              postsCollected: totalCollected,
              postLog: [
                ...thScanProgress.postLog.slice(-49),
                `@${post.username || handle} | ${(post.caption || '').replace(/\s+/g, ' ').slice(0, 90)} | ${post.url}`,
              ],
            });
          }
        );
        console.log(`[th-auto-scan] ✅ @${handle}: ${posts.length} post terkumpul.`);

        updateThreadsScanProgress({
          phase: 'analyzing',
          message: `Menganalisis ${posts.length} post dari @${handle} dengan AI...`,
        });

        // Worker pool — pola sama seperti IG/Twitter: hasil di-cap di target supaya tidak
        // pernah melebihi angka yang diminta di UI.
        let nextPostIndex = 0;
        const worker = async () => {
          while (results.length < target && !thScanAbort) {
            const idx = nextPostIndex++;
            if (idx >= posts.length) break;
            const post = posts[idx];
            try {
              // bankingOnly=true: hasil HANYA lowongan sektor perbankan.
              const vacancies = await analyzeScrapedPost(post, true, 'Threads', 'Profil Threads');
              analyzedCount++;
              updateThreadsScanProgress({ postsAnalyzed: analyzedCount, phase: 'analyzing' });
              for (const vacancy of vacancies) {
                if (!vacancy) continue;
                const postUrl = post.url;
                const vId = String(
                  (vacancy.vacancyData as { id?: unknown } | undefined)?.id || vacancy.id
                );
                if (seenUrls.has(vId)) {
                  thDuplicates++;
                  continue;
                }
                seenUrls.add(vId);
                if (results.length >= target) break;
                results.push(vacancy);
                updateThreadsScanProgress({
                  resultCount: results.length,
                  results: [...results].slice(0, target),
                  message: `Menganalisis... ${analyzedCount} diproses, ${results.length} loker perbankan`,
                });
                const vd = (vacancy.vacancyData as Record<string, unknown> | undefined) || {};
                console.log(
                  `[th-auto-scan] HASIL #${results.length}: ${vd.companyName || '-'} — ${vd.jobTitle || '-'} | ${postUrl}`
                );
              }
            } catch (err: any) {
              analyzedCount++;
              thErrors++;
              updateThreadsScanProgress({ postsAnalyzed: analyzedCount });
              console.warn(`[th-auto-scan] gagal memproses ${post.url}: ${err.message || 'unknown error'}`);
            }
          }
        };
        await Promise.all(Array.from({ length: ANALYZE_CONCURRENCY }, () => worker()));
      }
    } finally {
      try {
        await browser?.close();
      } catch {
        /* ignore */
      }
    }

    updateThreadsScanProgress({
      running: false,
      phase: 'done',
      accountsDone: accounts.length,
      resultCount: results.length,
      results: [...results].slice(0, target),
      message: `Selesai: ${totalCollected} post terkumpul, ${analyzedCount} dianalisis, ${results.length} loker perbankan`,
    });
    const diagnostics = {
      accounts: accounts.length,
      collected: totalCollected,
      analyzed: analyzedCount,
      bukanLoker: autoScanStats.bukanLoker - bukanLokerStart,
      errorCount: thErrors,
      duplicates: thDuplicates,
      results: results.length,
    };
    console.log(
      `[th-auto-scan] ringkasan: ${accounts.length} akun, ${totalCollected} post, ${analyzedCount} dianalisis (${autoScanStats.bukanLoker - bukanLokerStart} bukan loker, ${thErrors} error, ${thDuplicates} duplikat), ${results.length} hasil`
    );

    if (results.length === 0) {
      warnings.push(
        `Tidak ditemukan loker perbankan dari ${accounts.length} akun Threads: ${totalCollected} post terkumpul. Coba tambah akun Threads BPR/bank/koperasi di loker-sources.json.`
      );
    } else if (results.length < target) {
      warnings.push(
        `Diminta ${target} data, terkumpul ${results.length} loker perbankan dari ${totalCollected} post.`
      );
    }

    return res.json({ success: true, data: results.slice(0, target), warnings, diagnostics });
  } catch (err: any) {
    console.error('Error in /api/threads/auto-scan:', err);
    updateThreadsScanProgress({ running: false, phase: 'done' });
    return res
      .status(500)
      .json({ success: false, error: err.message || 'Gagal menjalankan auto-scan Threads.', data: [] });
  }
});

function loadTwitterSession(): { cookies?: unknown[]; origins?: unknown[] } | null {
  try {
    if (!existsSync(TWITTER_SESSION_FILE)) return null;
    return JSON.parse(readFileSync(TWITTER_SESSION_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

function hasTwitterSession(): boolean {
  const s = loadTwitterSession();
  if (!s || !Array.isArray(s.cookies)) return false;
  return s.cookies.some(
    (c: any) => c && c.name === 'auth_token' && typeof c.value === 'string' && c.value.length > 0
  );
}

function saveTwitterSession(state: unknown) {
  writeFileSync(TWITTER_SESSION_FILE, JSON.stringify(state), 'utf-8');
}

function clearTwitterSession() {
  try {
    if (existsSync(TWITTER_SESSION_FILE)) unlinkSync(TWITTER_SESSION_FILE);
  } catch {
    /* ignore */
  }
}

// Normalisasi link X: "x.com/..." / "twitter.com/..." / "@handle" / "handle" -> https://x.com/...
function normalizeTwitterUrl(raw: string): string {
  let u = (raw || '').trim();
  if (!u) return '';
  const bare = u.match(/^@?([A-Za-z0-9_]{1,15})$/);
  if (bare) return `https://x.com/${bare[1]}`;
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  u = u.replace(/^https?:\/\/(www\.)?twitter\.com/i, 'https://x.com');
  return u;
}

// ---------------------------------------------------------------
// X / Twitter umumnya memblokir Chromium bawaan Playwright (sidik
// jari otomasi & navigator.webdriver). Solusi: pakai Chrome asli
// yang terpasang (channel 'chrome') dengan fallback Chromium bawaan.
// ---------------------------------------------------------------

const TWITTER_CHROME_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-first-run',
  '--no-default-browser-check',
  '--start-maximized',
];

const TWITTER_REAL_CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA
    ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`
    : '',
].filter(Boolean);

async function launchTwitterBrowser(headless: boolean): Promise<{ browser: any; isRealChrome: boolean }> {
  // 1) Prefer Chrome asli yang terpasang (paling kecil kemungkinan diblokir X).
  for (const p of TWITTER_REAL_CHROME_PATHS) {
    try {
      if (existsSync(p)) {
        const browser = await chromium.launch({ executablePath: p, headless, args: TWITTER_CHROME_ARGS });
        console.log(`[tw-browser] menggunakan Chrome asli: ${p}`);
        return { browser, isRealChrome: true };
      }
    } catch (err: any) {
      console.warn(`[tw-browser] gagal pakai ${p}: ${err?.message || 'unknown'}`);
    }
  }
  // 2) channel 'chrome' (resolusi Playwright ke Chrome for Testing).
  try {
    const browser = await chromium.launch({ channel: 'chrome', headless, args: TWITTER_CHROME_ARGS });
    console.log('[tw-browser] menggunakan Chrome (channel: chrome).');
    return { browser, isRealChrome: true };
  } catch (err: any) {
    console.warn(`[tw-browser] channel chrome gagal (${err?.message || 'unknown'}), fallback Chromium bawaan.`);
  }
  // 3) Fallback Chromium bawaan Playwright.
  const browser = await chromium.launch({ headless, args: TWITTER_CHROME_ARGS });
  console.warn('[tw-browser] fallback ke Chromium bawaan Playwright.');
  return { browser, isRealChrome: false };
}

// Context X dengan profil realistis + stealth ringan (navigator.webdriver dihilangkan).
async function newTwitterContext(
  browser: any,
  opts: { storageState?: any; viewport?: { width: number; height: number } } = {}
): Promise<any> {
  const context = await browser.newContext({
    locale: 'id-ID',
    timezoneId: 'Asia/Jakarta',
    viewport: opts.viewport || { width: 1280, height: 900 },
    storageState: opts.storageState,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    try {
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    } catch {
      /* ignore */
    }
    try {
      Object.defineProperty(navigator, 'languages', { get: () => ['id-ID', 'id', 'en-US', 'en'] });
    } catch {
      /* ignore */
    }
  });
  return context;
}

// Verifikasi sesi X benar-benar hidup: buka x.com/home, cek komposer muncul (hanya saat login).
async function probeTwitterSession(): Promise<boolean> {
  if (!hasTwitterSession()) return false;
  let browser: any;
  try {
    const launched = await launchTwitterBrowser(process.env.FACEBOOK_HEADLESS === '1');
    browser = launched.browser;
    const context = await newTwitterContext(browser, {
      storageState: loadTwitterSession() as any,
    });
    const page = await context.newPage();
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(5000).catch(() => {});
    const alive = await page
      .evaluate(() => {
        if (document.querySelector('[data-testid="SideNav_NewTweet_Button"]')) return true;
        if (document.querySelector('[data-testid="tweetTextarea_0"]')) return true;
        const text = (document.body ? document.body.innerText : '').replace(/\s+/g, ' ');
        return !/(sign in to x|log in to x|masuk ke x|login to x)/i.test(text);
      })
      .catch(() => false);
    return alive;
  } catch {
    return false;
  } finally {
    try {
      await browser?.close();
    } catch {
      /* ignore */
    }
  }
}

// Buka jendela browser terlihat supaya user login X sekali secara manual.
async function runTwitterLoginFlow() {
  let browser: any;
  try {
    const launched = await launchTwitterBrowser(false);
    browser = launched.browser;
    twLoginMessage = `Jendela login X dibuka${
      launched.isRealChrome ? ' (Chrome asli)' : ' (Chromium)'
    }. Selesaikan login di jendela itu.`;
    const context = await newTwitterContext(browser, {
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();

    // Catat error halaman untuk debugging kalau X menampilkan layar error.
    page.on('pageerror', (err: any) => console.warn(`[tw-login] pageerror: ${err?.message || err}`));
    page.on('console', (msg: any) => {
      try {
        if ((msg?.type?.() || '') === 'error') console.warn(`[tw-login] console.error: ${msg.text()}`);
      } catch {
        /* ignore */
      }
    });

    await page.goto('https://x.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e: any) => {
      console.warn(`[tw-login] goto x.com gagal: ${e?.message || e}`);
    });
    await page.waitForTimeout(4000).catch(() => {});

    // Deteksi dinding login -> klik "Sign in" (lebih andal daripada memaksa /i/flow/login).
    const walled = await page
      .evaluate(() => {
        if (document.querySelector('[data-testid="SideNav_NewTweet_Button"]')) return false;
        const t = (document.body ? document.body.innerText : '').replace(/\s+/g, ' ');
        return /sign in|log in|masuk|daftar/i.test(t);
      })
      .catch(() => false);
    if (walled) {
      const signIn = page
        .locator('a[href="/i/flow/login"], [data-testid="loginButton"], [data-testid="login"]')
        .first();
      if (await signIn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await signIn.click().catch(() => {});
        console.log('[tw-login] dinding login terdeteksi, klik "Sign in".');
      }
    }
    await page.waitForTimeout(2500).catch(() => {});

    const deadline = Date.now() + TWITTER_LOGIN_TIMEOUT_MS;
    let loggedIn = false;
    while (Date.now() < deadline) {
      if (page.isClosed()) {
        twLoginMessage = 'Jendela login X ditutup. Silakan coba lagi.';
        console.log('[tw-login] jendela ditutup oleh pengguna.');
        return;
      }
      await sleep(2000);

      // Auto-reload jika X menampilkan "Something went wrong".
      const wentWrong = await page
        .evaluate(() =>
          /something went wrong|terjadi kesalahan|try reloading/i.test(
            (document.body ? document.body.innerText : '').replace(/\s+/g, ' ')
          )
        )
        .catch(() => false);
      if (wentWrong) {
        console.warn('[tw-login] terdeteksi "Something went wrong" -> reload otomatis.');
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
        await page.waitForTimeout(3000).catch(() => {});
      }

      const cookies: any[] = await context.cookies().catch(() => []);
      const hasToken = cookies.some((c) => c.name === 'auth_token' && c.value && c.value.length > 0);
      const url = page.url() || '';
      if (hasToken && (!/\/i\/flow/i.test(url) || /\/home/i.test(url))) {
        loggedIn = true;
        break;
      }
    }

    if (loggedIn) {
      await page.waitForTimeout(3000).catch(() => {});
      const state = await context.storageState();
      saveTwitterSession(state);
      twLoginMessage = 'Berhasil terhubung ke X / Twitter (sesi tersimpan).';
      console.log('[tw-login] ✅ sesi X tersimpan.');
    } else {
      twLoginMessage = 'Login X dibatalkan / melewati batas waktu. Silakan coba lagi.';
      console.log('[tw-login] timeout / dibatalkan.');
    }
  } catch (err: any) {
    twLoginMessage = `Gagal membuka jendela login X: ${err?.message || 'unknown error'}`;
    console.error(`[tw-login] error: ${err?.message || err}`);
  } finally {
    try {
      await browser?.close();
    } catch {
      /* ignore */
    }
    twLoginRunning = false;
  }
}

// Auto-scroll sebuah link X (profil / pencarian / list) dan kumpulkan tweet (teks + tautan +
// tanggal + gambar pertama). Setiap tweet baru dipanggil melalui onTweet secara live.
async function scrapeTweetsFromLink(
  page: any,
  link: string,
  daysBackNum: number,
  maxTweets: number,
  onTweet?: (post: ScannedPost, total: number) => void
): Promise<ScannedPost[]> {
  const out: ScannedPost[] = [];
  const seen = new Set<string>();
  const deadline = Date.now() + TWITTER_SCAN_BUDGET_MS;
  const cutoff = Date.now() - daysBackNum * 86400000;

  await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(6000).catch(() => {});

  let staleScrolls = 0;
  while (Date.now() < deadline && out.length < maxTweets && !twScanAbort) {
    const items = await page
      .evaluate(() => {
        const rows: any[] = [];
        const articles = document.querySelectorAll('article[data-testid="tweet"]');
        articles.forEach((a) => {
          const textEl = a.querySelector('[data-testid="tweetText"]');
          const timeEl = a.querySelector('time[datetime]');
          const linkEl = a.querySelector('a[href*="/status/"]');
          const imgEl = a.querySelector('img[src*="pbs.twimg.com/media/"]');
          let href = linkEl ? linkEl.getAttribute('href') || '' : '';
          const m = href.match(/^\/([^/]+)\/status\/(\d+)/);
          const permalink = m ? `https://x.com/${m[1]}/status/${m[2]}` : '';
          rows.push({
            text: textEl ? (textEl as HTMLElement).innerText : '',
            datetime: timeEl ? timeEl.getAttribute('datetime') || '' : '',
            permalink,
            handle: m ? m[1] : '',
            img: imgEl ? (imgEl as HTMLImageElement).src : '',
          });
        });
        return rows;
      })
      .catch(() => []);

    let addedThisScroll = 0;
    for (const it of items) {
      if (out.length >= maxTweets) break;
      if (!it.permalink || seen.has(it.permalink)) continue;
      const dt = it.datetime ? new Date(it.datetime) : null;
      if (dt && !isNaN(dt.getTime()) && dt.getTime() < cutoff) continue; // di luar rentang hari
      seen.add(it.permalink);
      const post: ScannedPost = {
        url: it.permalink,
        platform: 'Twitter',
        caption: it.text,
        username: it.handle || '',
        imageUrl: it.img || '',
        sourceLabel: it.handle ? `@${it.handle}` : 'Twitter',
        postDate: it.datetime || undefined,
      };
      out.push(post);
      addedThisScroll++;
      onTweet?.(post, out.length);
    }
    if (addedThisScroll === 0) {
      staleScrolls++;
      if (staleScrolls >= TWITTER_SCROLL_STALL_LIMIT) break;
    } else {
      staleScrolls = 0;
    }
    await page.evaluate(() => window.scrollBy(0, 1400)).catch(() => {});
    await page.waitForTimeout(1800).catch(() => {});
  }
  return out;
}

// Live progress auto-scan Twitter (dipoll frontend tiap ~2 detik saat run berlangsung).
app.get('/api/twitter/auto-scan/progress', (_req, res) => {
  res.json({ success: true, progress: twScanProgress });
});

// Hentikan auto-scan Twitter yang sedang berjalan (dicek pada loop koleksi & analisis).
app.post('/api/twitter/auto-scan/stop', (_req, res) => {
  twScanAbort = true;
  updateTwitterScanProgress({
    running: false,
    phase: 'done',
    message: 'Pindaian X dihentikan oleh pengguna.',
  });
  return res.json({ success: true, message: 'Perintah stop diterima.' });
});

// Login X / Twitter sekali (jendela Playwright terlihat, sesi disimpan).
app.post('/api/twitter/login', (_req, res) => {
  if (twLoginRunning) {
    return res.status(400).json({ success: false, error: 'Proses login X sudah berjalan.' });
  }
  if (twScanProgress.running) {
    return res.status(400).json({
      success: false,
      error: 'Auto-scan X sedang berjalan. Tunggu sampai selesai.',
    });
  }
  twLoginRunning = true;
  twLoginMessage = 'Membuka jendela login X...';
  runTwitterLoginFlow(); // fire-and-forget; UI polls /api/twitter/status
  return res.json({
    success: true,
    message: 'Jendela login X dibuka. Selesaikan login di jendela browser yang muncul.',
  });
});

app.get('/api/twitter/status', async (_req, res) => {
  const hasFile = hasTwitterSession();
  const connected = twLoginRunning ? true : await probeTwitterSession();
  return res.json({
    success: true,
    connected,
    loggingIn: twLoginRunning,
    message: twLoginRunning
      ? 'Jendela login X sedang terbuka — silakan selesaikan login di jendela tersebut.'
      : connected
        ? 'Terhubung ke X / Twitter (sesi tersimpan & aktif).'
        : hasFile
          ? 'Sesi X tersimpan tapi tampaknya sudah kadaluarsa — silakan login ulang.'
          : twLoginMessage,
  });
});

app.post('/api/twitter/logout', (_req, res) => {
  clearTwitterSession();
  twLoginMessage = 'Sesi X dihapus.';
  return res.json({ success: true, message: 'Sesi X dihapus.' });
});

// Auto-scan Twitter: buka link -> auto-scroll kumpulkan tweet -> Gemini (banking-only) -> live.
app.post('/api/twitter/auto-scan', async (req, res) => {
  try {
    const { link, daysBack, maxPosts } = req.body || {};
    const linkStr = String(link || '').trim();
    if (!linkStr) {
      return res.status(400).json({
        success: false,
        error: 'Masukkan link X / Twitter (profil, pencarian, atau list) terlebih dahulu.',
      });
    }
    if (twLoginRunning) {
      return res.status(400).json({
        success: false,
        error: 'Proses login X sedang berjalan. Tunggu sampai selesai.',
      });
    }
    if (twScanProgress.running) {
      return res.status(400).json({
        success: false,
        error: 'Auto-scan X sedang berjalan. Tunggu sampai selesai.',
      });
    }
    if (!hasTwitterSession()) {
      return res.status(400).json({
        success: false,
        error: 'Belum terhubung ke X. Klik "Login ke X" terlebih dahulu.',
      });
    }

    const daysBackNum = Math.max(1, Math.min(365, Number(daysBack) || 30));
    const target = Math.max(1, Math.min(50, Number(maxPosts) || 10));
    const collectTarget = Math.min(target * 4, 60);
    const warnings: string[] = [];
    const normalizedLink = normalizeTwitterUrl(linkStr);
    const bukanLokerStart = autoScanStats.bukanLoker;
    let twErrors = 0;
    let twDuplicates = 0;

    twScanAbort = false;
    twScanStartMs = Date.now();
    updateTwitterScanProgress({
      running: true,
      phase: 'starting',
      link: normalizedLink,
      tweetsCollected: 0,
      tweetsAnalyzed: 0,
      resultCount: 0,
      message: 'Memulai pindai X / Twitter...',
      postLog: [],
      results: [],
    });
    console.log(
      `[tw-auto-scan] 🚀 dimulai ${JSON.stringify({ link: normalizedLink, target, daysBack: daysBackNum, collectTarget })}`
    );

    const results: Record<string, unknown>[] = [];
    const seenUrls = new Set<string>();
    let analyzedCount = 0;
    let posts: ScannedPost[] = [];
    let browser: any;
    try {
      const session = loadTwitterSession();
      const launched = await launchTwitterBrowser(process.env.FACEBOOK_HEADLESS === '1');
      browser = launched.browser;
      const context = await newTwitterContext(browser, {
        storageState: session as any,
      });
      const page = await context.newPage();
      updateTwitterScanProgress({
        phase: 'collecting',
        message: 'Membuka link & mengumpulkan tweet (auto-scroll)...',
      });

      posts = await scrapeTweetsFromLink(page, normalizedLink, daysBackNum, collectTarget, (post, total) => {
        updateTwitterScanProgress({
          tweetsCollected: total,
          postLog: [
            ...twScanProgress.postLog.slice(-49),
            `@${post.username || '-'} | ${(post.caption || '').replace(/\s+/g, ' ').slice(0, 90)} | ${post.url}`,
          ],
        });
      });

      updateTwitterScanProgress({
        phase: 'analyzing',
        message: `Menganalisis ${posts.length} tweet dengan AI...`,
      });
      console.log(`[tw-auto-scan] ✅ ${posts.length} tweet terkumpul dari ${normalizedLink}, mulai analisis.`);

      // Worker pool — pola sama seperti IG: indeks diambil HANYA saat post tersedia, hasil
      // di-cap di target supaya tidak pernah melebihi angka yang diminta di UI.
      let nextPostIndex = 0;
      const worker = async () => {
        while (results.length < target && !twScanAbort) {
          const idx = nextPostIndex++;
          if (idx >= posts.length) break;
          const post = posts[idx];
          try {
            // bankingOnly=true: hasil HANYA lowongan sektor perbankan.
            const vacancies = await analyzeScrapedPost(post, true, 'Twitter', 'Tweet / Timeline');
            analyzedCount++;
            updateTwitterScanProgress({ tweetsAnalyzed: analyzedCount, phase: 'analyzing' });
            for (const vacancy of vacancies) {
              if (!vacancy) continue;
              const postUrl = post.url;
              const vId = String(
                (vacancy.vacancyData as { id?: unknown } | undefined)?.id || vacancy.id
              );
              if (seenUrls.has(vId)) {
                twDuplicates++;
                continue;
              }
              seenUrls.add(vId);
              if (results.length >= target) break;
              results.push(vacancy);
              updateTwitterScanProgress({
                resultCount: results.length,
                results: [...results].slice(0, target),
                message: `Menganalisis... ${analyzedCount} diproses, ${results.length} loker perbankan`,
              });
              const vd = (vacancy.vacancyData as Record<string, unknown> | undefined) || {};
              console.log(
                `[tw-auto-scan] HASIL #${results.length}: ${vd.companyName || '-'} — ${vd.jobTitle || '-'} | ${postUrl}`
              );
            }
          } catch (err: any) {
            analyzedCount++;
            twErrors++;
            updateTwitterScanProgress({ tweetsAnalyzed: analyzedCount });
            console.warn(`[tw-auto-scan] gagal memproses ${post.url}: ${err.message || 'unknown error'}`);
          }
        }
      };
      await Promise.all(Array.from({ length: ANALYZE_CONCURRENCY }, () => worker()));
    } finally {
      try {
        await browser?.close();
      } catch {
        /* ignore */
      }
    }

    updateTwitterScanProgress({
      running: false,
      phase: 'done',
      resultCount: results.length,
      results: [...results].slice(0, target),
      message: `Selesai: ${posts.length} tweet terkumpul, ${analyzedCount} dianalisis, ${results.length} loker perbankan`,
    });
    const diagnostics = {
      link: normalizedLink,
      tweetsCollected: posts.length,
      analyzed: analyzedCount,
      bukanLoker: autoScanStats.bukanLoker - bukanLokerStart,
      errorCount: twErrors,
      duplicates: twDuplicates,
      results: results.length,
    };
    console.log(
      `[tw-auto-scan] ringkasan: ${posts.length} tweet, ${analyzedCount} dianalisis (${autoScanStats.bukanLoker - bukanLokerStart} bukan loker, ${twErrors} error, ${twDuplicates} duplikat), ${results.length} hasil`
    );

    if (results.length === 0) {
      warnings.push(
        `Tidak ditemukan loker perbankan dari ${normalizedLink}: ${posts.length} tweet terkumpul. Coba link profil BPR/bank/koperasi lain.`
      );
    } else if (results.length < target) {
      warnings.push(
        `Diminta ${target} data, terkumpul ${results.length} loker perbankan dari ${posts.length} tweet.`
      );
    }

    return res.json({ success: true, data: results.slice(0, target), warnings, diagnostics });
  } catch (err: any) {
    console.error('Error in /api/twitter/auto-scan:', err);
    updateTwitterScanProgress({ running: false, phase: 'done' });
    return res
      .status(500)
      .json({ success: false, error: err.message || 'Gagal menjalankan auto-scan X.', data: [] });
  }
});

// Auto-scroll a Facebook group and scrape loker posts (text + poster images) via Gemini.
app.post('/api/facebook/scrape-group', async (req, res) => {
  try {
    const { groupUrl, daysBack, maxPosts, keyword } = req.body || {};

    if (fbLoginRunning) {
      return res.status(400).json({
        success: false,
        error: 'Proses login Facebook sedang berjalan. Tunggu sampai selesai.',
      });
    }
    if (fbScrapeRunning) {
      return res.status(400).json({
        success: false,
        error: 'Scrape Facebook sedang berjalan. Tunggu sampai selesai.',
      });
    }
    if (!hasFacebookSession()) {
      return res.status(400).json({
        success: false,
        error: 'Belum terhubung ke Facebook. Klik "Login ke Facebook" terlebih dahulu.',
      });
    }

    const url = normalizeFacebookUrl(groupUrl);
    if (!url || !isFacebookUrl(url)) {
      return res.status(400).json({
        success: false,
        error:
          'Link Facebook tidak valid. Contoh grup: https://www.facebook.com/groups/namagrup atau hasil pencarian: https://www.facebook.com/search/posts?q=loker%20bank',
      });
    }

    const isGroup = isFacebookGroupUrl(url);
    const isSearchUrl = /facebook\.com\/search\//i.test(url);
    const qMatch = url.match(/[?&]q=([^&]+)/);
    const searchQuery = qMatch ? decodeURIComponent(qMatch[1]).trim() : '';
    // Link hasil pencarian ("search/top?q=...") diarahkan ke tab Posts yang sudah
    // terbukti bisa dikoleksi (sama seperti mode Pindai Semua), agar tidak kosong.
    const scrapeUrl =
      isSearchUrl && searchQuery
        ? `https://www.facebook.com/search/posts?q=${encodeURIComponent(searchQuery)}`
        : isGroup
          ? `${url}${url.includes('?') ? '&' : '?'}sorting_setting=CHRONOLOGICAL`
          : url;
    const sourceContext = isGroup
      ? 'Grup Facebook'
      : isSearchUrl
        ? 'Pencarian Facebook'
        : 'Halaman Profil';

    const daysBackNum = Math.max(1, Math.min(365, Number(daysBack) || 7));
    const target = Math.max(1, Math.min(50, Number(maxPosts) || 15));
    const warnings: string[] = [];
    let browser: any;

    fbScrapeRunning = true;
    try {
      const session = loadFacebookSession();
      browser = await chromium.launch({
        headless: process.env.FACEBOOK_HEADLESS === '1',
        args: ['--disable-blink-features=AutomationControlled'],
      });
      const context = await browser.newContext({
        locale: 'id-ID',
        timezoneId: 'Asia/Jakarta',
        viewport: { width: 1280, height: 900 },
        storageState: session as any,
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      });
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(window, 'chrome', { get: () => ({ runtime: {} }) });
      });
      const page = await context.newPage();
      await page.goto(scrapeUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(6000).catch(() => {});
      await dismissFacebookDialogs(page);
      if (isSearchUrl) {
        if (await isFacebookLoggedOutPage(page)) {
          throw new Error(
            'Facebook memblokir sesi ini saat membuka pencarian (login wall / checkpoint). Klik "Putuskan Sesi" lalu "Login ke Facebook" kembali.'
          );
        }
        // Pastikan berada di tab "Posts" (beberapa layout perlu diklik sekali) lalu
        // pilih hasil "Recent/Terbaru" agar postingan <= daysBack lebih banyak muncul.
        try {
          const postsTab = page.getByRole('tab', { name: /posts|postingan/i }).first();
          if (await postsTab.isVisible({ timeout: 2000 }).catch(() => false)) {
            await postsTab.click();
            await page.waitForTimeout(3000);
          }
        } catch {
          /* tab optional */
        }
        await tryClickSearchRecentFilter(page);
      } else {
        await tryClickGroupRecentSort(page);
      }

      const finalUrl = page.url() || '';
      const isLoginWall = /login|checkpoint|two_step|unsupported browser/i.test(finalUrl);
      let seesLoginPrompt = false;
      try {
        seesLoginPrompt = await page
          .getByText(/You must log in|Harap masuk|Please log in/i)
          .first()
          .isVisible({ timeout: 2000 });
      } catch {
        seesLoginPrompt = false;
      }
      if (isLoginWall || seesLoginPrompt) {
        throw new Error(
          'Facebook memblokir sesi ini (login wall / checkpoint). Klik "Putuskan Sesi" lalu "Login ke Facebook" kembali.'
        );
      }

      let rawPosts: any[] = [];
      let totalFound = 0;
      try {
        const first = await collectFacebookGroupPosts(
          page,
          Math.min(target * 8, 120),
          daysBackNum
        );
        rawPosts = first.posts;
        totalFound = first.totalFound;
      } catch {
        /* halaman mungkin tertutup → muat ulang & coba sekali lagi */
      }
      if (rawPosts.length === 0) {
        try {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
          await page.waitForTimeout(8000);
        } catch {
          /* halaman tertutup → lewati retry */
        }
        const again = await collectFacebookGroupPosts(
          page,
          Math.min(target * 8, 120),
          daysBackNum
        ).catch(() => ({
          posts: [] as any[],
          totalFound: 0,
          oldestDate: null,
          stoppedByDate: false,
        }));
        if (again.posts.length > rawPosts.length) {
          rawPosts = again.posts;
          totalFound = again.totalFound;
        }
      }

      if (rawPosts.length === 0) {
        if (totalFound > 0) {
          warnings.push(
            `Ditemukan ${totalFound} postingan, tapi semuanya lebih tua dari ${daysBackNum} hari terakhir. Perbesar rentang hari.`
          );
        } else {
          warnings.push(
            'Tidak ada postingan yang berhasil diambil. Sumber mungkin private/tertutup, sesi tidak valid, atau feed belum termuat.'
          );
        }
      } else if (rawPosts.length < target) {
        warnings.push(
          `Hanya ditemukan ${rawPosts.length} postingan dalam ${daysBackNum} hari terakhir (diminta ${target}, total ${totalFound} dibaca).`
        );
      }

      const kw = typeof keyword === 'string' ? keyword.trim().toLowerCase() : '';
      // Keyword generik = "semua loker": cocokkan post yang mengandung sinyal loker apa pun.
      // Keyword spesifik (mis. "marketing", "BPR") hanya mencocokkan istilah tsb.
      const LOKER_GENERIC_TERMS = [
        'loker',
        'lowongan',
        'kerja',
        'pekerjaan',
        'job',
        'vacancy',
        'hiring',
        'rekrutmen',
        'recruitment',
      ];
      const LOKER_SIGNALS = [
        ...LOKER_GENERIC_TERMS,
        'dibutuhkan',
        'membutuhkan',
        'butuh',
        'karir',
        'career',
        'posisi',
        'lamar',
        'open recruitment',
        'buka lowongan',
      ];
      // Pisahkan keyword pada koma/titik-koma/baris (bukan hanya spasi) supaya
      // "bpr, perbankan, koperasi" menjadi 3 token yang valid untuk dicocokkan.
      const kwTokens = kw
        .split(/[,;\n]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const isGenericKw = kwTokens.some((w) => LOKER_GENERIC_TERMS.includes(w));
      const matchesKeyword = (p: any): boolean => {
        const t = `${p.text || ''} ${p.author || ''} ${p.ts || ''}`.toLowerCase();
        if (isGenericKw) return LOKER_SIGNALS.some((s) => t.includes(s));
        return kwTokens.some((w) => t.includes(w));
      };
      // Keyword = sinyal prioritas, bukan filter keras: post yang cocok dianalisis
      // duluan, lalu sisa budget diisi post lain. Keyword sering muncul hanya di
      // poster GAMBAR (mis. "bank BUMN"), jadi filter teks ketat berisiko membuang
      // post yang sebenarnya valid.
      let candidates: any[];
      if (!kw) {
        candidates = [...rawPosts];
      } else {
        const matched = rawPosts.filter(matchesKeyword);
        const rest = rawPosts.filter((p) => !matchesKeyword(p));
        candidates = [...matched, ...rest];
        if (rawPosts.length > 0 && matched.length === 0) {
          warnings.push(
            `Tidak ada postingan yang cocok dengan keyword "${keyword}" pada teksnya; bot tetap memeriksa postingan lain (keyword mungkin ada di gambar poster).`
          );
        }
      }

      const results: Record<string, unknown>[] = [];
      const seenUrls = new Set<string>();
      // Analisis lebih banyak kandidat daripada target supaya post valid yang tidak
      // berada di urutan teratas tetap ter-cover; hasil akhir tetap dibatasi target.
      const analyzeBudget = Math.min(candidates.length, Math.max(target * 2, target + 5));

      for (const post of candidates.slice(0, analyzeBudget)) {
        try {
          const result = await analyzeFacebookPost(page, post, {
            defaultContext: sourceContext,
          });
          if (!result) continue;
          const postUrl = (result.vacancyData as { sourceUrl?: string }).sourceUrl;
          const postKey = normalizePostUrl(postUrl || '');
          if (!postUrl || seenUrls.has(postKey)) continue;
          seenUrls.add(postKey);
          results.push(result);
        } catch (err: any) {
          console.warn(`[fb-scrape] gagal menganalisis ${post.url}: ${err?.message || 'unknown'}`);
        }
      }

      return res.json({ success: true, data: results.slice(0, target), warnings });
    } finally {
      try {
        await browser?.close();
      } catch {
        /* ignore */
      }
      fbScrapeRunning = false;
    }
  } catch (err: any) {
    fbScrapeRunning = false;
    console.error('Error in /api/facebook/scrape-group:', err);
    return res.status(500).json({
      success: false,
      error: err?.message || 'Gagal menjalankan scraper grup Facebook.',
    });
  }
});

// ----------------------------- API: Facebook Whole-FB Auto-Scan (search-based) -----------------------------
// No group link needed: uses Facebook search (/search/posts?q=...) to pull posts from any
// group/page, then keeps only banking loker posts that carry a contact email.
app.post('/api/facebook/auto-scan', async (req, res) => {
  try {
    const { keywords, daysBack, maxPosts, extraGroups } = req.body || {};

    if (fbLoginRunning) {
      return res.status(400).json({
        success: false,
        error: 'Proses login Facebook sedang berjalan. Tunggu sampai selesai.',
      });
    }
    if (fbScrapeRunning) {
      return res.status(400).json({
        success: false,
        error: 'Scrape Facebook sedang berjalan. Tunggu sampai selesai.',
      });
    }
    if (!hasFacebookSession()) {
      return res.status(400).json({
        success: false,
        error: 'Belum terhubung ke Facebook. Klik "Login ke Facebook" terlebih dahulu.',
      });
    }

    const config = loadScanSources();
    const userKeywords = Array.isArray(keywords)
      ? keywords
          .map((k: unknown) => String(k))
          .join('\n')
          .split(/[,;\n]+/)
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    // Keyword user selalu digabung dengan query bawaan (loker-sources.json) agar
    // postingan yang ditemukan tidak bergantung pada keyword yang diketik.
    let queries = [...userKeywords, ...(Array.isArray(config.queries) ? config.queries : [])];
    queries = [...new Set(queries)]
      .map((s) => String(s).trim())
      .filter(Boolean)
      .slice(0, FB_SEARCH_QUERY_LIMIT);
    if (queries.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Tidak ada keyword pencarian. Isi keyword atau sediakan query di loker-sources.json.',
      });
    }

    const daysBackNum = Math.max(1, Math.min(365, Number(daysBack) || 30));
    const target = Math.max(1, Math.min(50, Number(maxPosts) || 10));
    const extraGroupList = Array.isArray(extraGroups)
      ? (extraGroups as unknown[]).map((g) => String(g).trim()).filter(Boolean)
      : [];
    const collectTarget = Math.min(target * 4, 80);
    const warnings: string[] = [];
    let browser: any;

    fbScanAbort = false;
    fbScanStartMs = Date.now();
    updateFbScanProgress({
      running: true,
      phase: 'starting',
      query: '',
      queryIndex: 0,
      queriesDone: 0,
      queriesTotal: queries.length,
      groupsCrawled: 0,
      progress: 0,
      message: 'Memulai pindai semua Facebook…',
      postLog: [],
      results: [],
      postsCollected: 0,
      postsAnalyzed: 0,
      emailsFound: 0,
      fallbackAdded: 0,
      resultCount: 0,
    });
    console.log(
      `[fb-auto-scan] 🚀 dimulai ${JSON.stringify({ queries, target, daysBack: daysBackNum, collectTarget, curatedGroups: extraGroupList.length, extraGroups: extraGroupList })}`
    );

    fbScrapeRunning = true;
    try {
      const session = loadFacebookSession();
      browser = await chromium.launch({
        headless: process.env.FACEBOOK_HEADLESS === '1',
        args: ['--disable-blink-features=AutomationControlled'],
      });
      const context = await browser.newContext({
        locale: 'id-ID',
        timezoneId: 'Asia/Jakarta',
        viewport: { width: 1280, height: 900 },
        storageState: session as any,
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      });
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(window, 'chrome', { get: () => ({ runtime: {} }) });
      });

      updateFbScanProgress({ message: 'Memeriksa sesi Facebook…' });

      // Fail fast jika sesi FB sebenarnya sudah mati (file sesi ada ≠ masih login).
      const homeProbe = await context.newPage();
      await homeProbe
        .goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 45000 })
        .catch(() => {});
      await homeProbe.waitForTimeout(6000).catch(() => {});
      const sessionAlive = !(await isFacebookLoggedOutPage(homeProbe));
      await homeProbe.close().catch(() => {});
      if (!sessionAlive) {
        fbSessionValidCache = { valid: false, at: Date.now() };
        warnings.push(
          'Sesi Facebook kadaluarsa/tidak aktif — silakan klik "Login ke Facebook" lalu jalankan pindai lagi.'
        );
        return res.json({ success: true, data: [], warnings });
      }
      console.log('[fb-auto-scan] ✅ Sesi Facebook aktif, mulai koleksi.');

      const pool: any[] = [];
      const seenPool = new Map<string, number>();
      const visitedGroups = new Set<string>();
      const runStartMs = Date.now();
      let totalFound = 0;

      // --- Analysis infrastructure (runs incrementally as posts are collected) ---
      // Keep one logged-in page open so poster images (signed scontent URLs) can be downloaded.
      let fetcherPage: any = null;
      const ensureFetcherPage = async () => {
        if (fetcherPage) return fetcherPage;
        fetcherPage = await context.newPage();
        await fetcherPage
          .goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 45000 })
          .catch(() => {});
        return fetcherPage;
      };

      const skipCounts: Record<string, number> = {};
      const onSkip = (reason: string) => {
        skipCounts[reason] = (skipCounts[reason] || 0) + 1;
      };
      const withEmail: Record<string, unknown>[] = [];
      const withoutEmail: Record<string, unknown>[] = [];
      const seenUrls = new Set<string>();
      const analyzeBudget = Math.max(target * 2, target + 5);
      let postsAnalyzed = 0;
      let analysisCursor = 0;

      // Analyze the pool from `analysisCursor` onward; stops when target is reached or
      // the analysis budget is exhausted. Posts WITH a contact email are prioritized;
      // if fewer than `target` carry an email, banking posts without email (contact via
      // WA/phone) are appended as fallback and flagged.
      const analyzePoolSlice = async (): Promise<void> => {
        if (fbScanAbort) return;
        if (withEmail.length + withoutEmail.length >= target) return;
        if (postsAnalyzed >= analyzeBudget) return;
        const budgetLeft = Math.max(0, analyzeBudget - postsAnalyzed);
        const slice = pool.slice(analysisCursor, analysisCursor + budgetLeft);
        if (slice.length === 0) return;
        updateFbScanProgress({ phase: 'analyzing', message: 'Menganalisis postingan dengan AI…' });
        for (const post of slice) {
          if (fbScanAbort) break;
          if (withEmail.length + withoutEmail.length >= target) break;
          if (postsAnalyzed >= analyzeBudget) break;
          analysisCursor++;
          // Tanpa pre-filter teks: loker perbankan sebagian besar informasi &
          // email-nya ada di poster GAMBAR, bukan caption. Semua postingan
          // terambil dianalisis AI (OCR poster) sampai batas budget.
          postsAnalyzed++;
          updateFbScanProgress({ postsAnalyzed });
          try {
            const result = await analyzeFacebookPost(
              await ensureFetcherPage(),
              post,
              {
                requireBanking: true,
                requireEmail: false,
                defaultContext: 'Pencarian Facebook',
              },
              onSkip
            );
            if (!result) continue;
            const postUrl = (result.vacancyData as { sourceUrl?: string }).sourceUrl;
            const postKey = normalizePostUrl(postUrl || '');
            if (!postUrl || seenUrls.has(postKey)) continue;
            seenUrls.add(postKey);
            const contact = ((result.vacancyData as { contactInfo?: Record<string, unknown> })
              .contactInfo || {}) as Record<string, unknown>;
            const hasEmail = typeof contact.email === 'string' && contact.email.trim().length > 0;
            if (hasEmail) {
              withEmail.push(result);
            } else {
              (result.vacancyData as { contactEmailMissing?: boolean }).contactEmailMissing = true;
              withoutEmail.push(result);
            }
            // Stream hasil ke progress secara live, TANPA field berat (base64 gambar dsb)
            // agar polling /progress tetap ringan. Item penuh dikirim di response akhir.
            const fullItem = result as Record<string, unknown>;
            const vdFull = ((fullItem.vacancyData as Record<string, unknown> | undefined) ||
              {}) as Record<string, unknown>;
            const vdLight = { ...vdFull };
            delete vdLight.images;
            delete vdLight.rawOcrText;
            delete vdLight.logoDataUrl;
            delete vdLight.logoBox;
            updateFbScanProgress({
              results: [...fbScanProgress.results, { ...fullItem, imageUrl: '', vacancyData: vdLight }],
              emailsFound: withEmail.length,
              fallbackAdded: withoutEmail.length,
              resultCount: withEmail.length + withoutEmail.length,
            });
            console.log(
              `[fb-auto-scan] ✅ hasil ke-${withEmail.length + withoutEmail.length}: "${result.postTitle}" (${hasEmail ? 'dengan email' : 'tanpa email'})`
            );
          } catch (err: any) {
            console.warn(`[fb-auto-scan] gagal menganalisis ${post.url}: ${err?.message || 'unknown'}`);
          }
        }
      };

      // Normalize a group URL entry: accept full URLs or bare numeric IDs.
      const normalizeGroupUrl = (u: string): string => {
        const s = u.trim();
        if (!s) return '';
        const m = s.match(/facebook\.com\/groups\/([0-9]+)/) || s.match(/^([0-9]+)$/);
        return m ? `https://www.facebook.com/groups/${m[1]}` : s;
      };

      const pushPostLog = (snippet: string) => {
        updateFbScanProgress({
          postsCollected: fbScanProgress.postsCollected + 1,
          postLog: [...fbScanProgress.postLog.slice(-40), snippet],
        });
      };

      const mergePosts = (posts: any[]): number => {
        let added = 0;
        for (const p of posts) {
          const key = normalizePostUrl(p.url);
          const existing = seenPool.get(key);
          if (existing !== undefined) {
            if ((p.text || '').length > (pool[existing].text || '').length) {
              pool[existing] = { ...pool[existing], ...p };
            }
            continue;
          }
          seenPool.set(key, pool.length);
          pool.push(p);
          added++;
          console.log(
            `[fb-auto-scan]   + post: ${(p.text || '').replace(/\s+/g, ' ').slice(0, 110)}`
          );
        }
        updateFbScanProgress({ postsCollected: pool.length });
        return added;
      };

      // Extract group cards (link + name) currently visible on the page.
      const extractGroupCards = async (page: any): Promise<{ url: string; name: string }[]> => {
        try {
          return await page.evaluate(() => {
            const out: { url: string; name: string }[] = [];
            const seen = new Set<string>();
            document.querySelectorAll('a[href*="/groups/"]').forEach((a) => {
              let href = a.getAttribute('href') || '';
              if (href.startsWith('/')) href = window.location.origin + href;
              const m = href.match(/https?:\/\/[^/]+\/groups\/[^/?]+/);
              if (!m) return;
              const u = m[0].replace(/\/$/, '');
              if (seen.has(u)) return;
              seen.add(u);
              const name = (a.getAttribute('aria-label') || a.textContent || '')
                .replace(/\s+/g, ' ')
                .replace(/^Foto profil\s*/i, '')
                .replace(/^(Belum dibaca|Belum terbaca|Belum dilihat)\s*/i, '')
                .trim();
              out.push({ url: u, name });
            });
            return out;
          });
        } catch {
          return [];
        }
      };

      // Score a group name for banking relevance. -1 = unrelated (filter out).
      const scoreGroup = (name: string, q: string): number => {
        const n = name.toLowerCase();
        if (!n) return -1;
        if (FB_BANKING_TERM_RE.test(n)) return 2;
        const tokens = q
          .toLowerCase()
          .split(/\s+/)
          .filter((t) => t.length > 3);
        if (tokens.some((t) => n.includes(t))) return 1;
        return -1;
      };

      const crawlGroupFeed = async (page: any, g: string): Promise<number> => {
        if (visitedGroups.has(g)) return 0;
        visitedGroups.add(g);
        try {
          console.log(`[fb-auto-scan] 🏘️ Crawling grup: ${g}`);
          await page.goto(g, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await page.waitForTimeout(4000).catch(() => {});
          await dismissFacebookDialogs(page);
          await tryClickGroupRecentSort(page);
          if (await isFacebookLoggedOutPage(page)) {
            warnings.push(`Grup ${g} membutuhkan login ulang (checkpoint) — dilewati.`);
            return 0;
          }
          const groupCollected = await collectFacebookGroupPosts(
            page,
            Math.min(collectTarget - pool.length, 30),
            daysBackNum,
            (_count, snippet) => pushPostLog(snippet)
          ).catch(() => ({
            posts: [] as any[],
            totalFound: 0,
            oldestDate: null,
            stoppedByDate: false,
          }));
          totalFound += groupCollected.totalFound;
          const addedGroup = mergePosts(groupCollected.posts);
          const oldestTxt = groupCollected.oldestDate
            ? new Date(groupCollected.oldestDate).toLocaleDateString('id-ID')
            : '?';
          console.log(
            `[fb-auto-scan] grup ${g} → ${groupCollected.posts.length} dibaca (${addedGroup} baru, total pool ${pool.length}, tertua ${oldestTxt}${groupCollected.stoppedByDate ? ' ✅ sampai jendela hari' : ''})`
          );
          return addedGroup;
        } catch (err: any) {
          console.warn(`[fb-auto-scan] gagal crawl grup ${g}: ${err?.message || 'unknown'}`);
          return 0;
        }
      };

      // 0) Crawl curated banking/koperasi groups FIRST (guaranteed baseline), then
      //    the extra group links the user pasted in the UI. These feed known banking
      //    loker content instead of relying only on FB search noise.
      const curatedUrls = [
        ...(Array.isArray(config.facebook) ? config.facebook : []),
        ...extraGroupList,
      ]
        .map(normalizeGroupUrl)
        .filter(Boolean);
      const curatedGroups = [...new Set(curatedUrls)];
      console.log(`[fb-auto-scan] 🏛️ ${curatedGroups.length} grup terkurasi: ${curatedGroups.join(', ')}`);
      const curatedPage = await context.newPage();
      try {
        let curatedDone = 0;
        updateFbScanProgress({ curatedTotal: curatedGroups.length });
        for (const g of curatedGroups) {
          if (fbScanAbort) break;
          if (withEmail.length + withoutEmail.length >= target) break;
          if (pool.length >= collectTarget) break;
          if (Date.now() - runStartMs > FB_RUN_BUDGET_MS) break;
          const added = await crawlGroupFeed(curatedPage, g);
          curatedDone++;
          updateFbScanProgress({
            curatedDone,
            message: `Mengumpulkan grup terkurasi ${curatedDone}/${curatedGroups.length}…`,
          });
          if (added > 0) await analyzePoolSlice();
        }
      } finally {
        try {
          await curatedPage.close();
        } catch {
          /* ignore */
        }
      }

      for (const q of queries) {
        if (fbScanAbort) {
          console.log('[fb-auto-scan] ⏹️ Dihentikan pengguna, hentikan koleksi.');
          break;
        }
        if (pool.length >= collectTarget) break;
        if (withEmail.length + withoutEmail.length >= target) break;
        if (Date.now() - runStartMs > FB_RUN_BUDGET_MS) {
          console.log('[fb-auto-scan] ⏱️ Batas waktu global tercapai, hentikan koleksi.');
          break;
        }
        updateFbScanProgress({
          phase: 'collecting',
          query: q,
          message: `Mencari postingan "${q}"…`,
        });
        const page = await context.newPage();
        try {
          // 1) Post search FIRST: directly surfaces relevant posts (content match)
          //    and reveals the groups that host them.
          const postSearchUrl = `https://www.facebook.com/search/posts?q=${encodeURIComponent(q)}`;
          console.log(`[fb-auto-scan] 🔎 Cari postingan "${q}" → ${postSearchUrl}`);
          await page.goto(postSearchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await page.waitForTimeout(5000).catch(() => {});
          await dismissFacebookDialogs(page);

          if (await isFacebookLoggedOutPage(page)) {
            warnings.push(`Facebook memblokir pencarian postingan "${q}" (login wall / checkpoint).`);
          } else {
            // Make sure we are on the Posts tab (some layouts need the tab clicked once).
            try {
              const postsTab = page.getByRole('tab', { name: /posts|postingan/i }).first();
              if (await postsTab.isVisible({ timeout: 2000 }).catch(() => false)) {
                await postsTab.click();
                await page.waitForTimeout(3000);
              }
            } catch {
              /* tab optional */
            }
            await tryClickSearchRecentFilter(page);

            const searchCollected = await collectFacebookGroupPosts(
              page,
              Math.min(collectTarget - pool.length, 40),
              daysBackNum,
              (_count, snippet) => pushPostLog(snippet)
            ).catch(() => ({
              posts: [] as any[],
              totalFound: 0,
              oldestDate: null,
              stoppedByDate: false,
            }));
            totalFound += searchCollected.totalFound;
            const addedSearch = mergePosts(searchCollected.posts);
            const searchOldest = searchCollected.oldestDate
              ? new Date(searchCollected.oldestDate).toLocaleDateString('id-ID')
              : '?';
            console.log(
              `[fb-auto-scan] "${q}" feed pencarian → ${searchCollected.posts.length} dibaca (${addedSearch} baru, total pool ${pool.length}, tertua ${searchOldest}${searchCollected.stoppedByDate ? ' ✅ sampai jendela hari' : ''})`
            );
            if (addedSearch > 0) await analyzePoolSlice();
          }

          // 2) Crawl the groups that HOST the posts surfaced above (contextually relevant).
          //    Only groups whose name is banking-related are crawled; generic regional
          //    loker groups mostly contain non-banking posts and just waste time.
          const groupsFromPosts = (await extractGroupCards(page)).filter(
            (g) => scoreGroup(g.name, q) >= 1
          );
          console.log(
            `[fb-auto-scan] "${q}" → ${groupsFromPosts.length} grup bank dari hasil post`
          );

          const ranked = [...groupsFromPosts].sort(
            (a, b) => scoreGroup(b.name, q) - scoreGroup(a.name, q)
          );
          let crawled = 0;
          for (const g of ranked) {
            if (fbScanAbort) break;
            if (pool.length >= collectTarget) break;
            if (withEmail.length + withoutEmail.length >= target) break;
            if (Date.now() - runStartMs > FB_RUN_BUDGET_MS) break;
            if (crawled >= FB_GROUP_CRAWL_LIMIT) break;
            crawled++;
            updateFbScanProgress({ groupsCrawled: fbScanProgress.groupsCrawled + 1 });
            await crawlGroupFeed(page, g.url);
            await analyzePoolSlice();
          }
          updateFbScanProgress({ queriesDone: fbScanProgress.queriesDone + 1 });
        } catch (err: any) {
          warnings.push(`Pencarian "${q}" gagal: ${err?.message || 'unknown error'}`);
          if (typeof browser?.isConnected === 'function' && !browser.isConnected()) {
            console.warn('[fb-auto-scan] Browser tidak lagi terhubung — hentikan koleksi.');
            break;
          }
        } finally {
          try {
            await page.close();
          } catch {
            /* ignore */
          }
        }
      }

      if (pool.length === 0) {
        warnings.push(
          'Tidak ada postingan yang berhasil diambil dari hasil pencarian Facebook. Mungkin sesi login tidak valid, Facebook memblokir pencarian (checkpoint), atau hasil pencarian kosong.'
        );
      }

      // Drain any remaining posts that were collected but not yet analyzed
      // (analysis is incremental, so this is usually a no-op).
      if (typeof browser?.isConnected === 'function' && !browser.isConnected()) {
        warnings.push('Browser Facebook mati di tengah koleksi — analisis sisa dilewati.');
      } else {
        await analyzePoolSlice();
      }

      const results = [...withEmail, ...withoutEmail].slice(0, target);
      const emailsFound = withEmail.length;
      const fallbackAdded = Math.max(0, results.length - emailsFound);
      const notBanking = skipCounts['bukan sektor perbankan'] || 0;
      const notLoker = skipCounts['bukan loker'] || 0;

      if (results.length === 0) {
        warnings.push(
          `Tidak ditemukan loker perbankan dari ${postsAnalyzed} postingan yang dianalisis${notBanking ? ` (${notBanking} bukan sektor perbankan)` : ''}${notLoker ? ` (${notLoker} bukan loker)` : ''}.`
        );
      } else if (results.length < target) {
        warnings.push(
          `Diminta ${target} data, terkumpul ${results.length} loker perbankan${notBanking ? ` (${notBanking} postingan bukan sektor perbankan)` : ''}.`
        );
      } else {
        warnings.push(
          `Berhasil mengumpulkan ${results.length} loker perbankan${notBanking ? ` (${notBanking} postingan bukan sektor perbankan)` : ''}.`
        );
      }

      const meta = {
        queries: queries.length,
        postsCollected: pool.length,
        postsAnalyzed,
        groupsCrawled: fbScanProgress.groupsCrawled,
        stoppedByUser: fbScanAbort,
        skipBreakdown: skipCounts,
        emailsFound,
        fallbackAdded,
      };

      updateFbScanProgress({
        running: false,
        phase: 'done',
        queriesDone: fbScanProgress.queriesDone,
        postsCollected: pool.length,
        postsAnalyzed,
        emailsFound: withEmail.length,
        fallbackAdded: withoutEmail.length,
        resultCount: withEmail.length + withoutEmail.length,
      });

      return res.json({ success: true, data: results, warnings, meta });
    } finally {
      try {
        await browser?.close();
      } catch {
        /* ignore */
      }
      fbScrapeRunning = false;
      updateFbScanProgress({ running: false, phase: 'done' });
    }
  } catch (err: any) {
    fbScrapeRunning = false;
    console.error('Error in /api/facebook/auto-scan:', err);
    return res.status(500).json({
      success: false,
      error: err?.message || 'Gagal menjalankan auto-scan Facebook.',
    });
  }
});

// Live progress + cancel for the auto-scan.
app.get('/api/facebook/auto-scan/progress', (_req, res) => {
  res.json({ success: true, progress: fbScanProgress });
});

app.post('/api/facebook/auto-scan/stop', (_req, res) => {
  fbScanAbort = true;
  console.log('[fb-auto-scan] ⏹️ Permintaan stop diterima.');
  res.json({ success: true, message: 'Perintah stop diterima.' });
});

// Vite & Static middleware setup
async function startServer() {
  // Muat konfigurasi jadwal IG + bersihkan hasil yang sudah lewat retensi saat server nyala.
  loadIgSchedule();
  pruneScheduledResults();
  // Susun ulang nextRunAt agar tidak pakai jadwal basi setelah restart: kalau jadwal aktif
  // dan waktunya sudah lewat, ia akan dijadwalkan ke kemunculan berikutnya (bukan tersangkut
  // di masa lalu / langsung jalan berulang).
  refreshNextRunAt();
  saveIgSchedule();

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`LokerDetector Server running on http://0.0.0.0:${PORT}`);
    console.log(
      '[startup] IG auto-scan build v5 (live-log-polling, ~83 akun IG, budget jina 200, caption-regex-v2, banking-only-filter, target-exact-count)'
    );
    console.log(
      '[startup] Twitter auto-scan build v1 (real-chrome+stealth login, x.com auto-scroll, banking-only-filter, target-exact-count, excel-export)'
    );
    console.log(
      '[startup] Threads auto-scan build v1 (tanpa login, profil publik auto-scroll, banking-only-filter, target-exact-count, excel-export)'
    );
    console.log(
      `[startup] IG auto-schedule ${igSchedule.enabled ? 'AKTIF' : 'nonaktif'} (tiap ${igSchedule.intervalDays} hari, ${igSchedule.hour}:${String(igSchedule.minute).padStart(2, '0')}, next=${igSchedule.nextRunAt || '-'})`
    );
  });
}

startServer();
