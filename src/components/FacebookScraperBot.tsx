import React, { useState, useEffect, useRef } from 'react';
import {
  Bot,
  Play,
  Pause,
  Facebook,
  Sparkles,
  FileDown,
  ExternalLink,
  ShieldCheck,
  Calendar,
  Search,
  CheckSquare,
  LogOut,
  Link2,
  Loader2,
} from 'lucide-react';
import { JobVacancy, BotFeedItem, FacebookStatusPayload } from '../types';

interface FacebookScraperBotProps {
  onAddVacancy: (vacancy: JobVacancy) => void;
  savedVacancies: JobVacancy[];
  onSelectVacancy: (vacancy: JobVacancy) => void;
}

export const FacebookScraperBot: React.FC<FacebookScraperBotProps> = ({
  onAddVacancy,
  savedVacancies,
  onSelectVacancy,
}) => {
  // Facebook connection status (Playwright session on the server)
  const [fbStatus, setFbStatus] = useState<FacebookStatusPayload>({
    success: true,
    connected: false,
    loggingIn: false,
  });
  const [loginBusy, setLoginBusy] = useState(false);

  // Config state
  const [mode, setMode] = useState<'group' | 'all'>('all');
  const [groupUrl, setGroupUrl] = useState('');
  const [daysBack, setDaysBack] = useState<number>(3); // 1, 3, 7, 14, 30
  const [maxPosts, setMaxPosts] = useState<number>(10);
  const [keyword, setKeyword] = useState('');
  const [extraGroups, setExtraGroups] = useState('');

  // Execution state
  const [isRunning, setIsRunning] = useState(false);
  const [isFetching, setIsFetching] = useState(false);
  const [currentScanningIndex, setCurrentScanningIndex] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const [scannedResults, setScannedResults] = useState<BotFeedItem[]>([]);
  const [pendingResults, setPendingResults] = useState<BotFeedItem[]>([]);
  const [isFinished, setIsFinished] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  const scanIndexRef = useRef(0);
  const lastProgressLogRef = useRef('');
  const postLogSeenRef = useRef(0);
  const resultsSeenRef = useRef(0);

  const [activeAction, setActiveAction] = useState<'group' | 'all' | null>(null);
  const [scanStageMessage, setScanStageMessage] = useState('');

  const timeNow = () => new Date().toLocaleTimeString('id-ID');

  const loadStatus = async () => {
    try {
      const r = await fetch('/api/facebook/status');
      const d: FacebookStatusPayload = await r.json();
      setFbStatus(d);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    loadStatus();
  }, []);

  // Poll status while a login window is open
  useEffect(() => {
    if (!fbStatus.loggingIn) return;
    const timer = setInterval(() => loadStatus(), 2500);
    return () => clearInterval(timer);
  }, [fbStatus.loggingIn]);

  const handleLogin = async () => {
    if (loginBusy) return;
    setLoginBusy(true);
    try {
      const r = await fetch('/api/facebook/login', { method: 'POST' });
      const d = await r.json();
      if (!r.ok || !d.success) {
        alert(d.error || 'Gagal memulai login Facebook.');
        return;
      }
      setFbStatus((s) => ({ ...s, loggingIn: true, message: d.message || 'Menunggu login...' }));
      setLogs((prev) => [
        `[${timeNow()}] 🔐 Jendela login Facebook dibuka. Selesaikan login di jendela browser yang muncul.`,
        ...prev,
      ]);
    } catch (err: any) {
      alert(err.message || 'Gagal memulai login Facebook.');
    } finally {
      setLoginBusy(false);
    }
  };

  const handleLogout = async () => {
    try {
      await fetch('/api/facebook/logout', { method: 'POST' });
      setLogs((prev) => [
        `[${timeNow()}] 🚪 Sesi Facebook dihapus.`,
        ...prev,
      ]);
    } catch {
      /* ignore */
    }
    loadStatus();
  };

  // Poll real auto-scan progress from the server while a scan request is in-flight
  // (replaces the old fake progress bar that made long scans look stuck).
  useEffect(() => {
    if (!isFetching) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch('/api/facebook/auto-scan/progress');
        const d = await r.json();
        if (cancelled || !d?.progress) return;
        const p = d.progress;
        if (p.running === true) {
          if (typeof p.message === 'string' && p.message) setScanStageMessage(p.message);
          const activity = p.phase === 'analyzing' ? 'Menganalisis dengan AI' : 'Mengumpulkan postingan';
          const line = `[${timeNow()}] ⏳ ${activity} · Query ${Math.min(p.queriesDone + 1, p.queriesTotal)}/${p.queriesTotal} · ${p.postsCollected} post terkumpul · ${p.postsAnalyzed} dianalisis${p.resultCount ? ` · ${p.resultCount} hasil ✓` : ''}`;
          if (line !== lastProgressLogRef.current) {
            lastProgressLogRef.current = line;
            setLogs((prev) => [line, ...prev.slice(0, 14)]);
          }
          if (Array.isArray(p.postLog) && p.postLog.length > postLogSeenRef.current) {
            const fresh = p.postLog.slice(postLogSeenRef.current);
            postLogSeenRef.current = p.postLog.length;
            if (fresh.length > 0) {
              const lines = fresh.map((s) => `[${timeNow()}] 📥 Post terkumpul: ${s}`);
              setLogs((prev) => [...lines, ...prev.slice(0, 14)]);
            }
          }
          if (Array.isArray(p.results) && p.results.length > resultsSeenRef.current) {
            const fresh = p.results.slice(resultsSeenRef.current) as BotFeedItem[];
            resultsSeenRef.current = p.results.length;
            for (const item of fresh) {
              setScannedResults((prev) =>
                prev.some((x) => x.id === item.id) ? prev : [item, ...prev]
              );
              setLogs((prev) => [
                `[${timeNow()}] ✅ Loker masuk #${resultsSeenRef.current - fresh.length + fresh.indexOf(item) + 1}: "${item.postTitle}" · ${item.postDate} (${item.sourceContext})`,
                ...prev.slice(0, 14),
              ]);
            }
          }
        }
      } catch {
        /* transient fetch errors are fine */
      }
    };
    void tick();
    const timer = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [isFetching]);

  // Animated replay of the scraped results through the console
  useEffect(() => {
    if (!isRunning) return;
    if (pendingResults.length === 0) {
      setIsRunning(false);
      setIsFinished(true);
      return;
    }
    const timer = setInterval(() => {
      const item = pendingResults[scanIndexRef.current];
      if (item) {
        setLogs((prev) => [
          `[${timeNow()}] 🔍 Merekam Facebook (${item.sourceContext}) • "${item.postTitle}" (${item.postDate}) 🔗 ${item.vacancyData.sourceUrl}`,
          ...prev.slice(0, 20),
        ]);
        onAddVacancy(item.vacancyData);
        setScannedResults((prev) =>
          prev.some((p) => p.id === item.id) ? prev : [item, ...prev]
        );
      }
      const next = scanIndexRef.current + 1;
      setCurrentScanningIndex(next);
      scanIndexRef.current = next;

      if (next >= pendingResults.length) {
        setIsRunning(false);
        setIsFinished(true);
        setLogs((prev) => [
          `[${timeNow()}] ✅ SELESAI! Berhasil memindai ${pendingResults.length} postingan loker valid dari Facebook.`,
          ...prev,
        ]);
      }
    }, 1200);
    return () => clearInterval(timer);
  }, [isRunning, pendingResults, onAddVacancy]);

  const handleStartBot = async () => {
    if (!groupUrl.trim()) {
      alert('Masukkan link grup Facebook terlebih dahulu!');
      return;
    }
    if (!fbStatus.connected) {
      alert('Login ke Facebook dulu sebelum menjalankan bot!');
      return;
    }
    if (isFetching) return;

    setIsFetching(true);
    setActiveAction('group');
    setIsRunning(false);
    setIsFinished(false);
    setScanError(null);
    setCurrentScanningIndex(0);
    scanIndexRef.current = 0;
    postLogSeenRef.current = 0;
    resultsSeenRef.current = 0;
    setScannedResults([]);
    setPendingResults([]);
    setScanStageMessage('');

    setLogs([
      `[${timeNow()}] 🚀 MEMULAI BOT SCRAPER FACEBOOK...`,
      `[${timeNow()}] ⚙️ Grup: ${groupUrl.trim()}, Rentang: ${daysBack} hari ke belakang, Keyword: ${keyword.trim() ? `"${keyword.trim()}"` : 'semua'}, Ambil ${maxPosts} data.`,
      `[${timeNow()}] 📡 Membuka grup & menggulir feed untuk mengumpulkan postingan loker + gambar poster...`,
    ]);

    try {
      const response = await fetch('/api/facebook/scrape-group', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          groupUrl: groupUrl.trim(),
          daysBack,
          maxPosts,
          keyword: keyword.trim(),
        }),
      });

      const data: {
        success: boolean;
        data?: BotFeedItem[];
        warnings?: string[];
        error?: string;
        message?: string;
      } = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Terjadi kesalahan saat scraping grup Facebook.');
      }

      const results = data.data || [];

      if (data.warnings && data.warnings.length > 0) {
        setLogs((prev) => [
          ...data.warnings!.map((w) => `[${timeNow()}] ⚠️ ${w}`),
          ...prev,
        ]);
      }

      if (results.length === 0) {
        setLogs((prev) => [
          `[${timeNow()}] ⚠️ Tidak ada loker valid ditemukan. Periksa peringatan di atas, coba rentang hari lebih besar, atau pastikan grup berisi postingan lowongan.`,
          ...prev,
        ]);
        setIsFinished(true);
        return;
      }

      setLogs((prev) => [
        `[${timeNow()}] ✅ Berhasil mengambil ${results.length} postingan loker dari Facebook. Memproses hasil...`,
        ...prev,
      ]);
      setPendingResults(results);
      setIsRunning(true);
    } catch (err: any) {
      const msg = err.message || 'Gagal mengambil data Facebook. Pastikan sudah login.';
      setScanError(msg);
      setLogs((prev) => [`[${timeNow()}] ❌ ${msg}`, ...prev]);
      setIsFinished(true);
    } finally {
      setIsFetching(false);
      setActiveAction(null);
    }
  };

  const handleStopBot = () => {
    setIsRunning(false);
    setLogs((prev) => [
      `[${timeNow()}] ⏸️ Bot dihentikan oleh pengguna.`,
      ...prev,
    ]);
  };

  const handleStopAutoScan = async () => {
    try {
      await fetch('/api/facebook/auto-scan/stop', { method: 'POST' });
      setLogs((prev) => [`[${timeNow()}] ⏹️ Menghentikan pindaian (mungkin perlu beberapa detik)...`, ...prev]);
    } catch {
      /* ignore */
    }
  };

  const handleAutoScanAll = async () => {
    if (!fbStatus.connected) {
      alert('Login ke Facebook dulu sebelum menjalankan bot!');
      return;
    }
    if (isFetching) return;

    setIsFetching(true);
    setActiveAction('all');
    setIsRunning(false);
    setIsFinished(false);
    setScanError(null);
    setCurrentScanningIndex(0);
    scanIndexRef.current = 0;
    postLogSeenRef.current = 0;
    resultsSeenRef.current = 0;
    setScanStageMessage('');
    setScannedResults([]);
    setPendingResults([]);

    setLogs([
      `[${timeNow()}] 🚀 MEMULAI PINDAI SEMUA FACEBOOK...`,
      `[${timeNow()}] ⚙️ Mode: Seluruh Facebook (tanpa link grup). Rentang: ${daysBack} hari ke belakang, Ambil ${maxPosts} loker perbankan.`,
      `[${timeNow()}] 🔎 Mencari postingan loker di semua grup/halaman via pencarian Facebook...`,
    ]);

    const splitKeywords = (kw: string) =>
      kw
        .split(/[,;\n]+/)
        .map((s) => s.trim())
        .filter(Boolean);

    try {
      const kws = keyword.trim() ? splitKeywords(keyword) : undefined;
      const extra = splitKeywords(extraGroups);
      lastProgressLogRef.current = '';
      const response = await fetch('/api/facebook/auto-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          keywords: kws,
          daysBack,
          maxPosts,
          extraGroups: extra,
        }),
      });

      const data: {
        success: boolean;
        data?: BotFeedItem[];
        warnings?: string[];
        meta?: {
          queries?: number;
          postsCollected?: number;
          postsAnalyzed?: number;
          skipBreakdown?: Record<string, number>;
          emailsFound?: number;
          fallbackAdded?: number;
        };
        error?: string;
        message?: string;
      } = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Terjadi kesalahan saat auto-scan Facebook.');
      }

      const results = data.data || [];

      if (data.warnings && data.warnings.length > 0) {
        setLogs((prev) => [
          ...data.warnings!.map((w) => `[${timeNow()}] ⚠️ ${w}`),
          ...prev,
        ]);
      }

      if (data.meta) {
        const m = data.meta;
        const parts = [
          `${m.queries ?? 0} query`,
          `${m.postsCollected ?? 0} postingan terkumpul`,
          `${m.postsAnalyzed ?? 0} dianalisis`,
        ];
        setLogs((prev) => [`[${timeNow()}] 📊 ${parts.join(' · ')}`, ...prev]);
      }

      if (results.length === 0) {
        setLogs((prev) => [
          `[${timeNow()}] ⚠️ Tidak ada loker perbankan yang ditemukan. Periksa peringatan di atas, coba rentang hari lebih besar, atau perbarui sesi Facebook.`,
          ...prev,
        ]);
        setIsFinished(true);
        return;
      }

      setLogs((prev) => [
        `[${timeNow()}] ✅ Berhasil mengambil ${results.length} loker perbankan. Memproses hasil...`,
        ...prev,
      ]);
      setScannedResults(results);
      results.forEach((r) => onAddVacancy(r.vacancyData));
      setLogs((prev) => [
        `[${timeNow()}] ✅ SELESAI! Berhasil memindai ${results.length} loker perbankan valid dari Facebook.`,
        ...prev,
      ]);
      setIsFinished(true);
    } catch (err: any) {
      const msg = err.message || 'Gagal mengambil data Facebook. Pastikan sudah login.';
      setScanError(msg);
      setLogs((prev) => [`[${timeNow()}] ❌ ${msg}`, ...prev]);
      setIsFinished(true);
    } finally {
      setIsFetching(false);
      setActiveAction(null);
    }
  };

  const handleExportAllScannedExcel = async () => {
    if (scannedResults.length === 0) {
      alert('Belum ada hasil pindai bot Facebook. Jalankan bot terlebih dahulu untuk menghasilkan data.');
      return;
    }
    const { exportVacanciesToExcel } = await import('../utils/excelExporter');
    await exportVacanciesToExcel(
      scannedResults.map((s) => s.vacancyData),
      `Laporan_Loker_FB_${daysBack}Hari`
    );
  };

  return (
    <div className="space-y-6 mb-8">
      {/* Primary Control Box */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 sm:p-7 shadow-2xl text-slate-100">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-5 border-b border-slate-800">
          <div>
            <div className="flex items-center space-x-2.5">
              <div className="h-11 w-11 rounded-2xl bg-gradient-to-tr from-blue-600 to-sky-500 flex items-center justify-center shadow-lg shadow-blue-500/25">
                <Bot className="h-6 w-6 text-white animate-pulse" />
              </div>
              <div>
                <h2 className="text-lg font-bold text-white flex items-center space-x-2">
                  <span>Bot Scraper Auto-Run Facebook (Grup)</span>
                  <span className="text-[10px] px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 font-bold uppercase tracking-wider">
                    Sistem Otomatis
                  </span>
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Tempel link grup, atau pakai tombol &quot;Pindai Semua Facebook&quot; untuk mencari loker
                  perbankan di seluruh Facebook tanpa link
                </p>
              </div>
            </div>
          </div>

          {/* Quick Excel Export */}
          <button
            onClick={handleExportAllScannedExcel}
            className="flex items-center space-x-2 px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold shadow-lg shadow-emerald-900/40 transition-all self-start lg:self-auto"
            title="Download seluruh hasil ke Excel (.XLSX) — format sama seperti card OCR"
          >
            <FileDown className="h-4 w-4" />
            <span>Export Ke Excel (.XLSX)</span>
          </button>
        </div>

        {/* Facebook Connection Panel */}
        <div className="mt-5 bg-slate-950 p-4 rounded-xl border border-blue-800/60 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center space-x-3 text-xs">
            <div className="h-10 w-10 rounded-xl bg-blue-600/20 text-blue-400 flex items-center justify-center shrink-0">
              <Facebook className="h-5 w-5" />
            </div>
            <div>
              <p className="font-bold text-slate-200">
                Koneksi Facebook
                {fbStatus.connected && !fbStatus.loggingIn && (
                  <span className="ml-2 px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 font-bold uppercase tracking-wider text-[9px]">
                    Terhubung
                  </span>
                )}
                {fbStatus.loggingIn && (
                  <span className="ml-2 px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/30 font-bold uppercase tracking-wider text-[9px]">
                    Menunggu Login
                  </span>
                )}
                {!fbStatus.connected && !fbStatus.loggingIn && (
                  <span className="ml-2 px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700 font-bold uppercase tracking-wider text-[9px]">
                    Belum Terhubung
                  </span>
                )}
              </p>
              <p className="text-slate-400 mt-0.5">
                {fbStatus.loggingIn
                  ? 'Jendela login Facebook sedang terbuka — selesaikan login di jendela browser yang muncul.'
                  : fbStatus.connected
                    ? 'Sesi tersimpan. Anda siap menempelkan link grup dan menjalankan bot.'
                    : fbStatus.message || 'Klik "Login ke Facebook" untuk memulai (dilakukan sekali).'}
              </p>
            </div>
          </div>
          <div className="flex items-center space-x-2 shrink-0">
            {fbStatus.loggingIn ? (
              <button
                disabled
                className="flex items-center space-x-1.5 px-3.5 py-2 rounded-lg bg-slate-800 text-slate-400 text-xs font-bold border border-slate-700 cursor-not-allowed"
              >
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>Menunggu Login...</span>
              </button>
            ) : fbStatus.connected ? (
              <button
                onClick={handleLogout}
                className="flex items-center space-x-1.5 px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold border border-slate-700 transition-colors"
              >
                <LogOut className="h-3.5 w-3.5" />
                <span>Putuskan Sesi</span>
              </button>
            ) : (
              <button
                onClick={handleLogin}
                disabled={loginBusy || fbStatus.loggingIn}
                className="flex items-center space-x-1.5 px-3.5 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs font-bold shadow-lg shadow-blue-900/40 transition-all"
              >
                <Facebook className="h-3.5 w-3.5" />
                <span>{loginBusy || fbStatus.loggingIn ? 'Membuka Jendela...' : 'Login ke Facebook'}</span>
              </button>
            )}
          </div>
        </div>

        {/* Mode Selector: Grup vs Pindai Semua */}
        <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-2 p-1.5 bg-slate-950 rounded-xl border border-slate-800">
          <button
            onClick={() => setMode('all')}
            disabled={isFetching || isRunning || fbStatus.loggingIn}
            className={`flex items-center justify-center space-x-2 px-4 py-3 rounded-lg text-xs font-extrabold transition-all disabled:opacity-60 ${
              mode === 'all'
                ? 'bg-gradient-to-r from-emerald-600 via-teal-600 to-cyan-600 text-white shadow-lg shadow-emerald-900/40'
                : 'text-slate-400 hover:bg-slate-800/70 hover:text-white'
            }`}
          >
            <Sparkles className="h-4 w-4" />
            <span>Pindai Semua Facebook</span>
          </button>
          <button
            onClick={() => setMode('group')}
            disabled={isFetching || isRunning || fbStatus.loggingIn}
            className={`flex items-center justify-center space-x-2 px-4 py-3 rounded-lg text-xs font-extrabold transition-all disabled:opacity-60 ${
              mode === 'group'
                ? 'bg-gradient-to-r from-blue-600 via-sky-600 to-cyan-600 text-white shadow-lg shadow-blue-900/40'
                : 'text-slate-400 hover:bg-slate-800/70 hover:text-white'
            }`}
          >
            <Link2 className="h-4 w-4" />
            <span>Pindai Grup Tertentu</span>
          </button>
        </div>
        <p className="mt-2 text-[11px] text-slate-400 leading-tight">
          {mode === 'all'
            ? 'Cari loker perbankan di seluruh Facebook via pencarian (tanpa link grup). Keyword & grup tambahan di bawah ikut dipakai.'
            : 'Tempel link grup Facebook (facebook.com/groups/...) atau link hasil pencarian (facebook.com/search/... yang berisi postingan loker), lalu bot membuka & menggulir feed-nya.'}
        </p>

        {/* Configuration Panel */}
        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
          {/* 1. Link Grup Facebook (hanya mode Grup) */}
          {mode === 'group' && (
            <div className="bg-slate-950 p-4 rounded-xl border border-blue-800/60">
              <label className="block text-xs font-bold text-blue-400 uppercase tracking-wider mb-2.5 flex items-center space-x-1.5">
                <Link2 className="h-3.5 w-3.5 text-blue-400" />
                <span>1. Link Grup Facebook</span>
              </label>
              <input
                type="text"
                value={groupUrl}
                onChange={(e) => setGroupUrl(e.target.value)}
                placeholder="https://www.facebook.com/groups/... atau .../search/posts?q=loker bank"
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs font-semibold text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <p className="text-[11px] text-slate-400 leading-tight mt-2">
                Buka grup atau hasil pencarian di browser, salin (copy) tautannya, lalu tempel di sini. Bot
                membuka halaman & menggulir feed otomatis.
              </p>
            </div>
          )}

          {/* 2. Rentang Hari Ke Belakang */}
          <div className="bg-slate-950 p-4 rounded-xl border border-slate-800">
            <label className="block text-xs font-bold text-slate-300 uppercase tracking-wider mb-2.5 flex items-center space-x-1.5">
              <Calendar className="h-3.5 w-3.5 text-amber-400" />
              <span>2. Rentang Hari Ke Belakang</span>
            </label>
            <select
              value={daysBack}
              onChange={(e) => setDaysBack(Number(e.target.value))}
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs font-semibold text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value={1}>1 Hari Terakhir</option>
              <option value={3}>3 Hari Terakhir</option>
              <option value={7}>7 Hari Terakhir (Rekomendasi)</option>
              <option value={14}>14 Hari Terakhir (2 Minggu)</option>
              <option value={30}>30 Hari Terakhir (1 Bulan)</option>
            </select>
            <p className="text-[11px] text-slate-500 leading-tight mt-2">
              Rentang waktu postingan yang diambil. Penentuan tanggal bersifat estimasi dari teks relatif
              Facebook.
            </p>
          </div>

          {/* 3. Keyword Pencarian Loker (mode Pindai Semua & Grup) */}
          <div className="bg-slate-950 p-4 rounded-xl border border-slate-800">
            <label className="block text-xs font-bold text-slate-300 uppercase tracking-wider mb-2.5 flex items-center space-x-1.5">
              <Search className="h-3.5 w-3.5 text-blue-400" />
              <span>3. Keyword Pencarian Loker</span>
            </label>
            <input
              type="text"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="contoh: BPR, koperasi, bank, marketing, teller (opsional)"
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs font-semibold text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="text-[11px] text-slate-400 leading-tight mt-2">
              {mode === 'all'
                ? 'Keyword ini DITAMBAHKAN ke query bawaan (loker BPR, rekrutmen koperasi, dll) — bukan menggantikannya. Jika kosong, query bawaan tetap dipakai.'
                : 'Menyaring loker yang diambil dari grup (dicocokkan pada teks caption/poster). Kosong = ambil semua loker.'}
            </p>
          </div>

          {/* 3b. Link Grup Tambahan (hanya mode Pindai Semua) */}
          {mode === 'all' && (
            <div className="bg-slate-950 p-4 rounded-xl border border-slate-800">
              <label className="block text-xs font-bold text-slate-300 uppercase tracking-wider mb-2.5 flex items-center space-x-1.5">
                <Link2 className="h-3.5 w-3.5 text-cyan-400" />
                <span>3b. Link Grup Tambahan (opsional)</span>
              </label>
              <textarea
                value={extraGroups}
                onChange={(e) => setExtraGroups(e.target.value)}
                rows={2}
                placeholder={'satu link grup tiap baris, mis.\nhttps://www.facebook.com/groups/123456789\nhttps://www.facebook.com/groups/987654321'}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs font-semibold text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500 resize-y"
              />
              <p className="text-[11px] text-slate-400 leading-tight mt-2">
                Grup di sini ikut di-crawl saat &quot;Pindai Semua Facebook&quot; berjalan (selain grup terkurasi
                bawaan). Berguna untuk menambah grup BPR/koperasi/bank yang Anda tahu berisi loker.
              </p>
            </div>
          )}

          {/* 4. Ambil Data */}
          <div className="bg-slate-950 p-4 rounded-xl border border-slate-800">
            <label className="block text-xs font-bold text-slate-300 uppercase tracking-wider mb-2.5 flex items-center space-x-1.5">
              <CheckSquare className="h-3.5 w-3.5 text-indigo-400" />
              <span>4. Ambil Data (Jumlah Loker)</span>
            </label>
            <input
              type="number"
              min={1}
              max={50}
              value={maxPosts}
              onChange={(e) => setMaxPosts(Math.max(1, Math.min(50, Number(e.target.value) || 15)))}
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs font-semibold text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="text-[11px] text-slate-400 leading-tight mt-1.5">
              Jumlah loker yang diminta per run (maks. 50). Bot menggulir sampai terkumpul atau feed habis.
            </p>
          </div>
        </div>

        {/* Start Button & Progress Bar */}
        <div className="mt-6 pt-5 border-t border-slate-800 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="text-xs text-slate-400 flex items-center space-x-2">
            <ShieldCheck className="h-4 w-4 text-emerald-400" />
            {isFetching ? (
              <span>Mencari & menganalisis poster dengan AI (bisa butuh beberapa menit)...</span>
            ) : scannedResults.length > 0 ? (
              <span>
                Hasil scan: <strong className="text-slate-200">{scannedResults.length} loker</strong> valid
                dari Facebook
              </span>
            ) : fbStatus.loggingIn ? (
              <span>Tunggu login Facebook selesai, lalu coba lagi menjalankan bot.</span>
            ) : fbStatus.connected ? (
              <span>
                {mode === 'all' ? (
                  <>
                    Siap memindai <strong className="text-slate-200">seluruh Facebook</strong> (ambil{' '}
                    {maxPosts} data)
                  </>
                ) : (
                  <>
                    Siap memindai grup{' '}
                    <strong className="text-slate-200">{groupUrl.trim() || '(belum diisi)'}</strong> (ambil{' '}
                    {maxPosts} data)
                  </>
                )}
              </span>
            ) : (
              <span>Login ke Facebook terlebih dahulu sebelum menjalankan bot.</span>
            )}
          </div>

          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 w-full sm:w-auto">
            {isFetching ? (
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 w-full sm:w-auto">
                <button
                  disabled
                  className="w-full sm:w-auto flex items-center justify-center space-x-2 px-7 py-3 rounded-xl bg-slate-700 text-white font-extrabold text-xs opacity-70 cursor-wait transition-all"
                >
                  <div className="h-4 w-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  <span>
                    {activeAction === 'all'
                      ? 'SEDANG MEMINDAI SEMUA FACEBOOK...'
                      : 'MENGAMBIL DATA FACEBOOK...'}
                  </span>
                </button>
                <button
                  onClick={handleStopAutoScan}
                  className="w-full sm:w-auto flex items-center justify-center space-x-2 px-6 py-3 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs shadow-lg transition-all"
                >
                  <Pause className="h-4 w-4 fill-current" />
                  <span>STOP</span>
                </button>
              </div>
            ) : isRunning ? (
              <button
                onClick={handleStopBot}
                className="w-full sm:w-auto flex items-center justify-center space-x-2 px-6 py-3 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-bold text-xs shadow-lg transition-all"
              >
                <Pause className="h-4 w-4 fill-current" />
                <span>HENTIKAN SEMENTARA</span>
              </button>
            ) : mode === 'all' ? (
              <button
                onClick={handleAutoScanAll}
                disabled={!fbStatus.connected || fbStatus.loggingIn}
                className="w-full sm:w-auto flex items-center justify-center space-x-2 px-7 py-3 rounded-xl bg-gradient-to-r from-emerald-600 via-teal-600 to-cyan-600 hover:from-emerald-500 hover:to-cyan-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-extrabold text-xs shadow-xl shadow-emerald-600/30 transition-all scale-105"
                title="Tanpa link grup: cari loker perbankan di seluruh Facebook via pencarian sesuai keyword"
              >
                <Sparkles className="h-4 w-4" />
                <span>{fbStatus.loggingIn ? 'TUNGGU LOGIN SELESAI...' : 'PINDAI SEMUA FACEBOOK (PERBANKAN)'}</span>
              </button>
            ) : (
              <button
                onClick={handleStartBot}
                disabled={!fbStatus.connected || fbStatus.loggingIn}
                className="w-full sm:w-auto flex items-center justify-center space-x-2 px-7 py-3 rounded-xl bg-gradient-to-r from-blue-600 via-sky-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-extrabold text-xs shadow-xl shadow-blue-600/30 transition-all scale-105"
              >
                <Play className="h-4 w-4 fill-current" />
                <span>{fbStatus.loggingIn ? 'TUNGGU LOGIN SELESAI...' : 'JALANKAN BOT SCRAPER GRUP FB'}</span>
              </button>
            )}
          </div>
        </div>

        {/* Live Running Progress & Console */}
        {(isRunning || isFinished || logs.length > 0) && (
          <div className="mt-6 space-y-3">
            {scanStageMessage && (
              <p className="text-[11px] text-blue-300 font-mono truncate">{scanStageMessage}</p>
            )}

            {/* Console Log */}
            <div className="bg-slate-950 p-3.5 rounded-xl border border-slate-800 font-mono text-[11px] text-slate-300 max-h-40 overflow-y-auto space-y-1">
              {logs.map((log, index) => (
                <div key={index} className="flex items-start space-x-2">
                  <span className="text-blue-400 shrink-0">›</span>
                  <span className="break-all">{log}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Discovered Vacancies List */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 sm:p-6 shadow-xl text-slate-100">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5 pb-4 border-b border-slate-800">
          <div>
            <h3 className="text-base font-bold flex items-center space-x-2 text-white">
              <Sparkles className="h-5 w-5 text-amber-400" />
              <span>
                Hasil Postingan Terdeteksi ({scannedResults.length} Loker Valid)
              </span>
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Setiap postingan dilengkapi link URL resmi Facebook & teks/gambar poster yang dianalisis AI.
            </p>
          </div>
        </div>

        {scannedResults.length === 0 ? (
          <div className="bg-slate-950 border border-dashed border-slate-800 rounded-xl p-8 text-center">
            <div className="flex flex-col items-center space-y-2 text-slate-500">
              <Bot className="h-8 w-8 text-slate-600" />
              <p className="text-xs font-semibold text-slate-300">Belum ada hasil pindaian.</p>
              <p className="text-[11px] max-w-md">
                Login Facebook, tempel link grup, lalu klik "JALANKAN BOT SCRAPER GRUP FB". Teks caption &
                gambar poster dibaca otomatis (OCR AI) dan hasil bisa di-export ke Excel.
              </p>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-slate-800">
            <table className="w-full text-xs text-left border-collapse min-w-[760px]">
              <thead>
                <tr className="bg-slate-950 text-slate-300 uppercase text-[10px] tracking-wider border-b border-slate-700">
                  <th className="px-3 py-3 text-center w-10">No</th>
                  <th className="px-3 py-3">Perusahaan</th>
                  <th className="px-3 py-3">Position</th>
                  <th className="px-3 py-3">Wilayah</th>
                  <th className="px-3 py-3">Tanggal Posting</th>
                  <th className="px-3 py-3">Tanggal Berakhir</th>
                  <th className="px-3 py-3 text-center w-24">Buka Link</th>
                </tr>
              </thead>
              <tbody>
                {scannedResults.map((item, index) => (
                  <tr
                    key={item.id}
                    onClick={() => onSelectVacancy(item.vacancyData)}
                    className="border-b border-slate-800/80 hover:bg-slate-800/40 cursor-pointer transition-colors"
                  >
                    <td className="px-3 py-3 text-center text-slate-500">{index + 1}</td>
                    <td className="px-3 py-3 font-semibold text-blue-400 whitespace-nowrap">
                      {item.vacancyData.companyName || '-'}
                      {item.vacancyData.contactEmailMissing && (
                        <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/40 font-bold text-[9px] uppercase tracking-wide align-middle">
                          Tanpa Email
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3 font-semibold text-slate-100">
                      {item.vacancyData.jobTitle || '-'}
                    </td>
                    <td className="px-3 py-3 text-slate-300">{item.vacancyData.workLocation || '-'}</td>
                    <td className="px-3 py-3 text-slate-300 whitespace-nowrap">
                      {item.vacancyData.postDate || '-'}
                    </td>
                    <td className="px-3 py-3 text-rose-400 font-medium whitespace-nowrap">
                      {item.vacancyData.deadline || '-'}
                    </td>
                    <td className="px-3 py-3 text-center">
                      {item.vacancyData.sourceUrl && (
                        <a
                          href={item.vacancyData.sourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center space-x-1 px-2.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-bold text-[10px]"
                        >
                          <ExternalLink className="h-3 w-3" />
                          <span>Buka</span>
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
