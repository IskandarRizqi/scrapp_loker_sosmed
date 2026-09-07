import React, { useState, useEffect, useRef } from 'react';
import {
  Bot,
  Play,
  Pause,
  Twitter,
  Sparkles,
  FileDown,
  ExternalLink,
  ShieldCheck,
  Calendar,
  LogOut,
  Link2,
  Loader2,
} from 'lucide-react';
import { JobVacancy, BotFeedItem, TwitterStatusPayload } from '../types';
import { expandPositions, countTotalPositions } from '../utils/positions';

interface TwitterScraperBotProps {
  onAddVacancy: (vacancy: JobVacancy) => void;
  savedVacancies: JobVacancy[];
  onSelectVacancy: (vacancy: JobVacancy) => void;
}

export const TwitterScraperBot: React.FC<TwitterScraperBotProps> = ({
  onAddVacancy,
  savedVacancies,
  onSelectVacancy,
}) => {
  // Twitter / X connection status (Playwright session on the server)
  const [twStatus, setTwStatus] = useState<TwitterStatusPayload>({
    success: true,
    connected: false,
    loggingIn: false,
  });
  const [loginBusy, setLoginBusy] = useState(false);

  // Config state
  const [link, setLink] = useState('');
  const [daysBack, setDaysBack] = useState<number>(3); // 1, 3, 7, 14, 30
  const [maxPosts, setMaxPosts] = useState<number>(10);

  // Execution state
  const [isFetching, setIsFetching] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [scannedResults, setScannedResults] = useState<BotFeedItem[]>([]);
  const [pendingResults, setPendingResults] = useState<BotFeedItem[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [isFinished, setIsFinished] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  const scanIndexRef = useRef(0);
  const lastProgressLogRef = useRef('');
  const postLogSeenRef = useRef(0);
  const resultsSeenRef = useRef(0);

  const [scanStageMessage, setScanStageMessage] = useState('');

  const timeNow = () => new Date().toLocaleTimeString('id-ID');

  const loadStatus = async () => {
    try {
      const r = await fetch('/api/twitter/status');
      const d: TwitterStatusPayload = await r.json();
      setTwStatus(d);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    loadStatus();
  }, []);

  // Poll status while a login window is open
  useEffect(() => {
    if (!twStatus.loggingIn) return;
    const timer = setInterval(() => loadStatus(), 2500);
    return () => clearInterval(timer);
  }, [twStatus.loggingIn]);

  const handleLogin = async () => {
    if (loginBusy) return;
    setLoginBusy(true);
    try {
      const r = await fetch('/api/twitter/login', { method: 'POST' });
      const d = await r.json();
      if (!r.ok || !d.success) {
        alert(d.error || 'Gagal memulai login X.');
        return;
      }
      setTwStatus((s) => ({ ...s, loggingIn: true, message: d.message || 'Menunggu login...' }));
      setLogs((prev) => [
        `[${timeNow()}] 🔐 Jendela login X dibuka (Chrome asli). Selesaikan login di jendela TERPISAH itu — email → nama pengguna (username) → password.`,
        ...prev,
      ]);
    } catch (err: any) {
      alert(err.message || 'Gagal memulai login X.');
    } finally {
      setLoginBusy(false);
    }
  };

  const handleLogout = async () => {
    try {
      await fetch('/api/twitter/logout', { method: 'POST' });
      setLogs((prev) => [`[${timeNow()}] 🚪 Sesi X dihapus.`, ...prev]);
    } catch {
      /* ignore */
    }
    loadStatus();
  };

  // Poll real auto-scan progress from the server while a scan request is in-flight.
  useEffect(() => {
    if (!isFetching) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch('/api/twitter/auto-scan/progress');
        const d = await r.json();
        if (cancelled || !d?.progress) return;
        const p = d.progress;
        if (p.running === true) {
          if (typeof p.message === 'string' && p.message) setScanStageMessage(p.message);
          const activity =
            p.phase === 'analyzing'
              ? 'Menganalisis dengan AI'
              : p.phase === 'collecting'
                ? 'Mengumpulkan tweet'
                : 'Menyiapkan';
          const line = `[${timeNow()}] ⏳ ${activity} · ${p.tweetsCollected} tweet terkumpul · ${p.tweetsAnalyzed} dianalisis${p.resultCount ? ` · ${p.resultCount} hasil ✓` : ''}`;
          if (line !== lastProgressLogRef.current) {
            lastProgressLogRef.current = line;
            setLogs((prev) => [line, ...prev.slice(0, 14)]);
          }
          if (Array.isArray(p.postLog) && p.postLog.length > postLogSeenRef.current) {
            const fresh = p.postLog.slice(postLogSeenRef.current);
            postLogSeenRef.current = p.postLog.length;
            if (fresh.length > 0) {
              const lines = fresh.map((s) => `[${timeNow()}] 📥 Tweet terkumpul: ${s}`);
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
          `[${timeNow()}] 🔍 Merekam X (${item.sourceContext}) • "${item.postTitle}" (${item.postDate}) 🔗 ${item.vacancyData.sourceUrl}`,
          ...prev.slice(0, 20),
        ]);
        onAddVacancy(item.vacancyData);
        setScannedResults((prev) =>
          prev.some((p) => p.id === item.id) ? prev : [item, ...prev]
        );
      }
      const next = scanIndexRef.current + 1;
      scanIndexRef.current = next;

      if (next >= pendingResults.length) {
        setIsRunning(false);
        setIsFinished(true);
        setLogs((prev) => [
          `[${timeNow()}] ✅ SELESAI! Berhasil memindai ${countTotalPositions(pendingResults)} posisi loker perbankan valid dari Twitter / X.`,
          ...prev,
        ]);
      }
    }, 1200);
    return () => clearInterval(timer);
  }, [isRunning, pendingResults, onAddVacancy]);

  const handleStartBot = async () => {
    if (!link.trim()) {
      alert('Masukkan link X / Twitter terlebih dahulu!');
      return;
    }
    if (!twStatus.connected) {
      alert('Login ke X dulu sebelum menjalankan bot!');
      return;
    }
    if (isFetching) return;

    setIsFetching(true);
    setIsRunning(false);
    setIsFinished(false);
    setScanError(null);
    scanIndexRef.current = 0;
    postLogSeenRef.current = 0;
    resultsSeenRef.current = 0;
    lastProgressLogRef.current = '';
    setScannedResults([]);
    setPendingResults([]);
    setScanStageMessage('');

    setLogs([
      `[${timeNow()}] 🚀 MEMULAI BOT SCRAPER TWITTER / X...`,
      `[${timeNow()}] ⚙️ Link: ${link.trim()}, Rentang: ${daysBack} hari ke belakang, Ambil ${maxPosts} loker perbankan.`,
      `[${timeNow()}] 📡 Membuka link & menggulir feed untuk mengumpulkan tweet + gambar poster...`,
    ]);

    try {
      const response = await fetch('/api/twitter/auto-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          link: link.trim(),
          daysBack,
          maxPosts,
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
        throw new Error(data.error || 'Terjadi kesalahan saat auto-scan Twitter / X.');
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
          `[${timeNow()}] ⚠️ Tidak ada loker perbankan yang ditemukan. Periksa peringatan di atas, coba rentang hari lebih besar, atau coba link profil BPR/bank/koperasi lain.`,
          ...prev,
        ]);
        setIsFinished(true);
        return;
      }

      setLogs((prev) => [
        `[${timeNow()}] ✅ Berhasil mengambil ${countTotalPositions(results)} posisi loker perbankan dari Twitter / X. Memproses hasil...`,
        ...prev,
      ]);
      setPendingResults(results);
      setIsRunning(true);
    } catch (err: any) {
      const msg = err.message || 'Gagal mengambil data Twitter / X. Pastikan sudah login.';
      setScanError(msg);
      setLogs((prev) => [`[${timeNow()}] ❌ ${msg}`, ...prev]);
      setIsFinished(true);
    } finally {
      setIsFetching(false);
    }
  };

  const handleStopBot = () => {
    setIsRunning(false);
    setLogs((prev) => [`[${timeNow()}] ⏸️ Bot dihentikan oleh pengguna.`, ...prev]);
  };

  const handleStopAutoScan = async () => {
    try {
      await fetch('/api/twitter/auto-scan/stop', { method: 'POST' });
      setLogs((prev) => [
        `[${timeNow()}] ⏹️ Menghentikan pindaian (mungkin perlu beberapa detik)...`,
        ...prev,
      ]);
    } catch {
      /* ignore */
    }
  };

  const handleExportAllScannedExcel = async () => {
    if (scannedResults.length === 0) {
      alert('Belum ada hasil pindai bot Twitter / X. Jalankan bot terlebih dahulu untuk menghasilkan data.');
      return;
    }
    const { exportVacanciesToExcel } = await import('../utils/excelExporter');
    await exportVacanciesToExcel(
      scannedResults.map((s) => s.vacancyData),
      `Laporan_Loker_Twitter_${daysBack}Hari`
    );
  };

  return (
    <div className="space-y-6 mb-8">
      {/* Primary Control Box */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 sm:p-7 shadow-2xl text-slate-100">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-5 border-b border-slate-800">
          <div>
            <div className="flex items-center space-x-2.5">
              <div className="h-11 w-11 rounded-2xl bg-gradient-to-tr from-slate-700 to-slate-500 flex items-center justify-center shadow-lg shadow-slate-500/25">
                <Bot className="h-6 w-6 text-white animate-pulse" />
              </div>
              <div>
                <h2 className="text-lg font-bold text-white flex items-center space-x-2">
                  <span>Bot Scraper Auto-Run Twitter / X</span>
                  <span className="text-[10px] px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 font-bold uppercase tracking-wider">
                    Sistem Otomatis
                  </span>
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Login X sekali, tempel link profil / pencarian, bot auto-scroll & ambil loker perbankan
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

        {/* Twitter Connection Panel */}
        <div className="mt-5 bg-slate-950 p-4 rounded-xl border border-slate-700/60 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center space-x-3 text-xs">
            <div className="h-10 w-10 rounded-xl bg-slate-700/40 text-slate-300 flex items-center justify-center shrink-0">
              <Twitter className="h-5 w-5" />
            </div>
            <div>
              <p className="font-bold text-slate-200">
                Koneksi Twitter / X
                {twStatus.connected && !twStatus.loggingIn && (
                  <span className="ml-2 px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 font-bold uppercase tracking-wider text-[9px]">
                    Terhubung
                  </span>
                )}
                {twStatus.loggingIn && (
                  <span className="ml-2 px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/30 font-bold uppercase tracking-wider text-[9px]">
                    Menunggu Login
                  </span>
                )}
                {!twStatus.connected && !twStatus.loggingIn && (
                  <span className="ml-2 px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700 font-bold uppercase tracking-wider text-[9px]">
                    Belum Terhubung
                  </span>
                )}
              </p>
              <p className="text-slate-400 mt-0.5">
                {twStatus.loggingIn
                  ? 'Jendela login X sedang terbuka — selesaikan login di jendela browser TERPISAH yang muncul (jika diminta "Nama pengguna", isi username akun kamu).'
                  : twStatus.connected
                    ? 'Sesi tersimpan & aktif. Anda siap menempelkan link dan menjalankan bot.'
                    : twStatus.message || 'Klik "Login ke X" untuk memulai (dilakukan sekali). Jendela browser TERPISAH akan terbuka — login di jendela itu, lalu kembali ke sini.'}
              </p>
            </div>
          </div>
          <div className="flex items-center space-x-2 shrink-0">
            {twStatus.loggingIn ? (
              <button
                disabled
                className="flex items-center space-x-1.5 px-3.5 py-2 rounded-lg bg-slate-800 text-slate-400 text-xs font-bold border border-slate-700 cursor-not-allowed"
              >
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>Menunggu Login...</span>
              </button>
            ) : twStatus.connected ? (
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
                disabled={loginBusy || twStatus.loggingIn}
                className="flex items-center space-x-1.5 px-3.5 py-2 rounded-lg bg-slate-600 hover:bg-slate-500 disabled:opacity-50 text-white text-xs font-bold shadow-lg shadow-slate-900/40 transition-all"
              >
                <Twitter className="h-3.5 w-3.5" />
                <span>{loginBusy || twStatus.loggingIn ? 'Membuka Jendela...' : 'Login ke X'}</span>
              </button>
            )}
          </div>
        </div>

        {/* Configuration Panel */}
        <div className="mt-5 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {/* 1. Link X / Twitter */}
          <div className="bg-slate-950 p-4 rounded-xl border border-slate-700/60">
            <label className="block text-xs font-bold text-slate-300 uppercase tracking-wider mb-2.5 flex items-center space-x-1.5">
              <Link2 className="h-3.5 w-3.5 text-blue-400" />
              <span>1. Link X / Twitter</span>
            </label>
            <input
              type="text"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="https://x.com/nama_profil atau x.com/search?q=..."
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs font-semibold text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="text-[11px] text-slate-400 leading-tight mt-2">
              Buka halaman profil atau hasil pencarian X di browser (sudah login), salin (copy) tautannya,
              lalu tempel di sini. Bot membuka halaman & menggulir feed otomatis.
            </p>
          </div>

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
              Rentang waktu tweet yang diambil (berdasarkan tanggal posting di X).
            </p>
          </div>

          {/* 3. Ambil Data */}
          <div className="bg-slate-950 p-4 rounded-xl border border-slate-800">
            <label className="block text-xs font-bold text-slate-300 uppercase tracking-wider mb-2.5 flex items-center space-x-1.5">
              <Sparkles className="h-3.5 w-3.5 text-indigo-400" />
              <span>3. Ambil Data (Jumlah Loker)</span>
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
              Jumlah loker perbankan yang diminta per run (maks. 50). Bot menggulir sampai terkumpul atau
              feed habis.
            </p>
          </div>
        </div>

        {/* Start Button & Progress Bar */}
        <div className="mt-6 pt-5 border-t border-slate-800 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="text-xs text-slate-400 flex items-center space-x-2">
            <ShieldCheck className="h-4 w-4 text-emerald-400" />
            {isFetching ? (
              <span>Mengumpulkan tweet & menganalisis dengan AI (bisa butuh beberapa menit)...</span>
            ) : scannedResults.length > 0 ? (
              <span>
                Hasil scan: <strong className="text-slate-200">{countTotalPositions(scannedResults)} posisi</strong>{' '}
                valid dari Twitter / X
              </span>
            ) : twStatus.loggingIn ? (
              <span>Tunggu login X selesai, lalu coba lagi menjalankan bot.</span>
            ) : twStatus.connected ? (
              <span>
                Siap memindai <strong className="text-slate-200">{link.trim() || '(belum diisi)'}</strong>{' '}
                (ambil {maxPosts} data)
              </span>
            ) : (
              <span>Login ke X terlebih dahulu sebelum menjalankan bot.</span>
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
                  <span>SEDANG MEMINDAI TWITTER / X...</span>
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
            ) : (
              <button
                onClick={handleStartBot}
                disabled={!twStatus.connected || twStatus.loggingIn}
                className="w-full sm:w-auto flex items-center justify-center space-x-2 px-7 py-3 rounded-xl bg-gradient-to-r from-slate-700 via-slate-600 to-slate-500 hover:from-slate-600 hover:to-slate-400 disabled:opacity-40 disabled:cursor-not-allowed text-white font-extrabold text-xs shadow-xl shadow-slate-700/30 transition-all scale-105"
              >
                <Play className="h-4 w-4 fill-current" />
                <span>{twStatus.loggingIn ? 'TUNGGU LOGIN SELESAI...' : 'JALANKAN BOT SCRAPER X (PERBANKAN)'}</span>
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
              <span>Hasil Postingan Terdeteksi ({countTotalPositions(scannedResults)} Posisi Loker Valid)</span>
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Setiap tweet dilengkapi link URL resmi X & teks/gambar yang dianalisis AI.
            </p>
          </div>
        </div>

        {scannedResults.length === 0 ? (
          <div className="bg-slate-950 border border-dashed border-slate-800 rounded-xl p-8 text-center">
            <div className="flex flex-col items-center space-y-2 text-slate-500">
              <Bot className="h-8 w-8 text-slate-600" />
              <p className="text-xs font-semibold text-slate-300">Belum ada hasil pindaian.</p>
              <p className="text-[11px] max-w-md">
                Login X, tempel link profil/pencarian, lalu klik "JALANKAN BOT SCRAPER X (PERBANKAN)".
                Teks tweet & gambar poster dibaca otomatis (OCR AI) dan hasil bisa di-export ke Excel.
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
                {scannedResults
                  .flatMap((item) =>
                    expandPositions(item.vacancyData).map((pos) => ({ item, vd: item.vacancyData, pos }))
                  )
                  .map(({ item, vd, pos }, i) => (
                  <tr
                    key={`${item.id}-${i}`}
                    onClick={() => onSelectVacancy(vd)}
                    className="border-b border-slate-800/80 hover:bg-slate-800/40 cursor-pointer transition-colors"
                  >
                    <td className="px-3 py-3 text-center text-slate-500">{i + 1}</td>
                    <td className="px-3 py-3 font-semibold text-blue-400 whitespace-nowrap">
                      {vd.companyName || '-'}
                      {vd.contactEmailMissing && (
                        <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/40 font-bold text-[9px] uppercase tracking-wide align-middle">
                          Tanpa Email
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3 font-semibold text-slate-100">
                      {pos.title || '-'}
                    </td>
                    <td className="px-3 py-3 text-slate-300">{vd.workLocation || '-'}</td>
                    <td className="px-3 py-3 text-slate-300 whitespace-nowrap">
                      {vd.postDate || '-'}
                    </td>
                    <td className="px-3 py-3 text-rose-400 font-medium whitespace-nowrap">
                      {vd.deadline || '-'}
                    </td>
                    <td className="px-3 py-3 text-center">
                      {vd.sourceUrl && (
                        <a
                          href={vd.sourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center space-x-1 px-2.5 py-1.5 rounded-lg bg-slate-600 hover:bg-slate-500 text-white font-bold text-[10px]"
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
