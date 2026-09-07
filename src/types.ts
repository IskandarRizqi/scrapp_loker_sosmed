export interface ContactInfo {
  email?: string;
  phoneWhatsapp?: string;
  websiteForm?: string;
  instagramDm?: string;
  address?: string;
}

// Satu posisi/jabatan dalam satu lowongan. Satu postingan yang membuka banyak posisi
// (misal "Marketing, Credit Analyst, Collection") menghasilkan satu JobPosition per posisi,
// masing-masing dengan jobdesk/jobspek/keahlian hasil pengembangan AI.
export interface JobPosition {
  title: string; // Nama posisi / jabatan, misal "Marketing"
  summary?: string; // ringkasan AI khusus posisi ini
  responsibilities?: string[]; // jobdesk AI (tanggung jawab) khusus posisi ini
  requirements?: string[]; // jobspek (syarat & kualifikasi) khusus posisi ini
  skills?: string[]; // keahlian khusus posisi ini
}

// Top-level navigation pages of the app (hash-based routing in App.tsx)
export type AppPage = 'dashboard' | 'instagram' | 'facebook' | 'twitter' | 'threads' | 'ocr';

export interface JobVacancy {
  id: string;
  isVacancy: boolean;
  confidenceScore: number; // 0 - 100
  detectionReason: string; // why AI thinks it is/isn't a job vacancy
  companyName: string;
  jobTitle: string;
  // Daftar posisi/jabatan (jika satu postingan membuka banyak posisi). Bila tidak ada,
  // cukup gunakan satu posisi turunan dari jobTitle + responsibilities/requirements/skills.
  positions?: JobPosition[];
  jobCategory: string; // e.g. Perbankan & Keuangan, IT & Tech, Admin & HR, BUMN, Retail, etc.
  jobType: string; // Full-Time, Part-Time, Freelance, Internship, Contract, Unknown
  workLocation: string; // e.g., Jakarta Selatan, Surabaya, Remote, Hybrid
  salaryInfo: string; // e.g., Rp 5.000.000 - Rp 8.000.000 / bulan or Negotiable
  requirements: string[];
  responsibilities: string[];
  howToApply: string;
  contactInfo: ContactInfo;
  deadline: string; // e.g., 28 Agustus 2026 or Secepatnya
  rawOcrText: string;
  sourceUrl?: string;
  platform: 'Instagram' | 'Facebook' | 'Twitter' | 'Threads';
  sourceContext: 'Sorotan (Highlights)' | 'Postingan Feed' | 'InstaStory' | 'Grup Facebook' | 'Halaman Profil' | 'Pencarian Facebook' | 'Tweet / Timeline' | 'Profil Threads';
  detectedAt: string;
  postDate?: string; // e.g. "Hari ini", "1 hari lalu", "2 hari lalu", "3 hari lalu"
  daysAgo?: number; // 0, 1, 2, 3, etc.
  isBankingSector?: boolean;
  isExpired?: boolean;
  summary: string;
  description?: string; // full original caption/description of the post
  images?: string[]; // base64 or preview URLs
  logoBox?: { x: number; y: number; w: number; h: number } | null; // normalized logo bounding box from AI
  logoDataUrl?: string; // company logo image (from official website or cropped from screenshot)
  companyWebsite?: string; // official website domain extracted by AI
  logoUrl?: string; // direct logo image URL found by AI
  adminAddress?: {
    province?: string;
    regency?: string;
    district?: string;
    village?: string;
  }; // administrative address summarized by AI
  skills?: string[]; // specific skills/competencies developed by AI (never empty)
  contactEmailMissing?: boolean; // banking loker without email (fallback, contact via WA/phone)
}

export interface ScanRequestPayload {
  url?: string;
  text?: string;
  images?: string[]; // base64 strings
  sourceType?: string;
}

export interface ScanResponsePayload {
  success: boolean;
  data?: JobVacancy;
  error?: string;
  warning?: string;
}

export interface BotFeedItem {
  id: string;
  platform: 'Instagram' | 'Facebook' | 'Twitter' | 'Threads';
  sourceContext: 'Sorotan (Highlights)' | 'Postingan Feed' | 'InstaStory' | 'Grup Facebook' | 'Halaman Profil' | 'Pencarian Facebook' | 'Tweet / Timeline' | 'Profil Threads';
  accountName: string;
  accountHandle: string;
  avatarUrl?: string;
  postTitle: string;
  postSnippet: string;
  postDate: string; // "Hari ini", "1 hari lalu", "2 hari lalu", "3 hari lalu"
  daysAgo: number;
  imageUrl?: string;
  isBanking: boolean;
  vacancyData: JobVacancy;
}

export interface AutoScanSource {
  url: string;
  accountName: string;
  accountHandle: string;
  sourceContext: BotFeedItem['sourceContext'];
  isBanking: boolean;
  avatarUrl?: string;
}

export interface AutoScanSourcesResponse {
  success: boolean;
  data?: {
    instagram: AutoScanSource[];
    facebook: AutoScanSource[];
    queryCount: number;
    facebookEnabled: boolean;
  };
  error?: string;
}

export interface AutoScanRequestPayload {
  useInstagram: boolean;
  useFacebook?: boolean;
  daysBack: number;
  maxPosts: number;
}

export interface AutoScanResponsePayload {
  success: boolean;
  data?: BotFeedItem[];
  warnings?: string[];
  error?: string;
}

// ----------------------------- Facebook Group Scraper -----------------------------

export interface FacebookStatusPayload {
  success: boolean;
  connected: boolean;
  loggingIn: boolean;
  message?: string;
  error?: string;
}

export interface FacebookScrapeRequestPayload {
  groupUrl: string;
  daysBack: number;
  maxPosts: number;
  keyword?: string;
}

export interface FacebookScrapeResponsePayload {
  success: boolean;
  data?: BotFeedItem[];
  warnings?: string[];
  error?: string;
  message?: string;
}

// ----------------------------- Twitter / X Scraper -----------------------------

export interface TwitterStatusPayload {
  success: boolean;
  connected: boolean;
  loggingIn: boolean;
  message?: string;
  error?: string;
}

export interface TwitterAutoScanRequestPayload {
  link: string;
  daysBack: number;
  maxPosts: number;
}

export interface TwitterProgressPayload {
  success: boolean;
  progress: {
    running: boolean;
    phase: 'starting' | 'collecting' | 'analyzing' | 'done';
    link: string;
    tweetsCollected: number;
    tweetsAnalyzed: number;
    resultCount: number;
    message: string;
    postLog: string[];
    results: BotFeedItem[];
    elapsedMs: number;
  };
}

// ----------------------------- Threads Scraper -----------------------------

export interface ThreadsStatusPayload {
  success: boolean;
  enabled: boolean;
  accountsCount: number;
  accounts?: string[];
  message?: string;
  error?: string;
}

export interface ThreadsProgressPayload {
  success: boolean;
  progress: {
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
    results: BotFeedItem[];
    elapsedMs: number;
  };
}

// ----------------------------- IG Auto-Schedule -----------------------------

export interface IgScheduleConfig {
  enabled: boolean;
  intervalDays: number;
  hour: number;
  minute: number;
  daysBack: number;
  maxPosts: number;
  lastRunAt?: string | null;
  nextRunAt?: string | null;
  lastStatus?: string;
}

export interface ScheduledBatchSummary {
  id: string;
  capturedAt: string;
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
  vacancyCount: number;
}

export interface ScheduledBatchDetail {
  id: string;
  capturedAt: string;
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
  results: BotFeedItem[];
}

export interface ScheduledResultsResponse {
  success: boolean;
  data?: ScheduledBatchSummary[];
  error?: string;
}

export interface ScheduledBatchDetailResponse {
  success: boolean;
  data?: ScheduledBatchDetail;
  error?: string;
}

export interface ScheduleConfigResponse {
  success: boolean;
  schedule?: IgScheduleConfig;
  error?: string;
}
