import React, { useState, useEffect, useRef } from 'react';
import {
  Bot,
  Play,
  Sparkles,
  FileDown,
  ExternalLink,
  ShieldCheck,
  Calendar,
  MessageCircle,
  Pause,
} from 'lucide-react';
import { JobVacancy, BotFeedItem, ThreadsStatusPayload } from '../types';

interface ThreadsScraperBotProps {
  onAddVacancy: (vacancy: JobVacancy) => void;
  savedVacancies: JobVacancy[];
  onSelectVacancy: (vacancy: JobVacancy) => void;
}

export const ThreadsScraperBot: React.FC<ThreadsScraperBotProps> = ({
  onAddVacancy,
  savedVacancies,
  onSelectVacancy,
}) => {
  // Config state
  const [daysBack, setDaysBack] = useState<number>(3); // 1, 3, 7, 14, 30
  const [maxPosts, setMaxPosts] = useState<number>(15); // custom max posts per run

  // Execution State
  const [isFetching, setIsFetching] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [scannedResults, setScannedResults] = useState<BotFeedItem[]>([]);
  const [isFinished, setIsFinished] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  // Refs pelacak kemajuan polling live (hanya menambah entri baru, jangan duplikat).
  const postLogSeenRef = useRef(0);
  const resultsSeenRef = useRef(0);
  const lastProgressLogRef = useRef('');

  const [threadsStatus, setThreadsStatus] = useState<ThreadsStatusPayload>({
    success: true,
    enabled: true,
    accountsCount: 0,
  });

  // Load the configured Threads source list from the server
  useEffect(() => {
    let cancelled = false;
    fetch('/api/threads/status')
      .then((r) => r.json())
      .then((res: ThreadsStatusPayload) => {
        if (!cancelled && res.success) {
          setThreadsStatus(res);
        }
      })
      .catch(() => {
        /* server status endpoint unavailable; ignore */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Poll live progress/log/results dari server selama run berlangsung — pola sama
  // seperti bot IG/Facebook, jadi log & hasil tampil LIVE.
  useEffect(() => {
    if (!isFetching) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch('/api/threads/auto-scan/progress');
        const d = await r.json();
        if (cancelled || !d?.progress) return;
        const p = d.progress;
        if (p.running === true) {
          const activity =
            p.phase === 'analyzing'
              ? 'Menganalisis dengan AI'
              : p.phase === 'collecting'
                ? 'Mengumpulkan post'
                : 'Menyiapkan';
          const line = `[${new Date().toLocaleTimeString('id-ID')}] ⏳ ${activity} · Akun ${Math.min(p.accountsDone + 1, p.accountsTotal)}/${p.accountsTotal}${p.currentAccount ? ` (@${p.currentAccount})` : ''} · ${p.postsCollected} post terkumpul · ${p.postsAnalyzed} dianalisis${p.resultCount ? ` · ${p.resultCount} hasil ✓` : ''}`;
          if (line !== lastProgressLogRef.current) {
            lastProgressLogRef.current = line;
            setLogs((prev) => [line, ...prev.slice(0, 14)]);
          }
          if (Array.isArray(p.postLog) && p.postLog.length > postLogSeenRef.current) {
            const fresh = p.postLog.slice(postLogSeenRef.current) as string[];
            postLogSeenRef.current = p.postLog.length;
            if (fresh.length > 0) {
              const lines = fresh.map(
                (s) => `[${new Date().toLocaleTimeString('id-ID')}] 📥 Post ditemukan: ${s}`
              );
              setLogs((prev) => [...lines, ...prev.slice(0, 14)]);
            }
          }
          if (Array.isArray(p.results) && p.results.length > resultsSeenRef.current) {
            const fresh = p.results.slice(resultsSeenRef.current) as BotFeedItem[];
            resultsSeenRef.current = p.results.length;
            for (const item of fresh) {
              const vd = item.vacancyData;
              const company = vd.companyName || '-';
              const title = vd.jobTitle || '-';
              const url = vd.sourceUrl || '';
              setScannedResults((prev) => {
                if (prev.some((x) => x.id === item.id)) return prev;
                onAddVacancy(vd);
                return [item, ...prev];
              });
              setLogs((prev) => [
                `[${new Date().toLocaleTimeString('id-ID')}] ✅ Loker masuk #${resultsSeenRef.current - fresh.length + fresh.indexOf(item) + 1}: ${company} — ${title} ${url ? `| ${url}` : ''}`,
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
  }, [isFetching, onAddVacancy]);

  const handleStartBot = async () => {
    if (isFetching) return;

    setIsFetching(true);
    setIsFinished(false);
    setScanError(null);
    postLogSeenRef.current = 0;
    resultsSeenRef.current = 0;
    lastProgressLogRef.current = '';
    setScannedResults([]);

    setLogs([
      `[${new Date().toLocaleTimeString('id-ID')}] 🚀 MEMULAI BOT SCRAPER THREADS...`,
      `[${new Date().toLocaleTimeString('id-ID')}] ⚙️ Parameter: Rentang: ${daysBack} hari ke belakang, Sumber: ${threadsStatus.accountsCount || 0} akun dari loker-sources.json, Ambil ${maxPosts} data.`,
      `[${new Date().toLocaleTimeString('id-ID')}] 📡 Membuka profil Threads & menggulir feed untuk mengumpulkan post + gambar poster...`,
    ]);

    try {
      const response = await fetch('/api/threads/auto-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
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
        diagnostics?: {
          accounts?: number;
          collected?: number;
          analyzed?: number;
          bukanLoker?: number;
          errorCount?: number;
          duplicates?: number;
          results?: number;
        };
      } = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Terjadi kesalahan saat mengambil data Threads.');
      }

      const results = data.data || [];
      const diag = data.diagnostics || {};

      if (data.warnings && data.warnings.length > 0) {
        setLogs((prev) => [
          ...data.warnings!.map(
            (w) => `[${new Date().toLocaleTimeString('id-ID')}] ⚠️ ${w}`
          ),
          ...prev,
        ]);
      }

      // Merge hasil akhir yang mungkin belum sempat tampil lewat polling (dedup by id)
      setScannedResults((prev) => {
        const merged = [...prev];
        for (const item of results) {
          if (merged.some((x) => x.id === item.id)) continue;
          merged.push(item);
          onAddVacancy(item.vacancyData);
        }
        return merged;
      });

      if (results.length === 0) {
        setLogs((prev) => [
          `[${new Date().toLocaleTimeString('id-ID')}] ⚠️ Tidak ada loker perbankan ditemukan dari Threads. Ringkasan: ${diag.collected ?? '?'} post terkumpul, ${diag.analyzed ?? '?'} dianalisis, ${diag.bukanLoker ?? '?'} bukan loker, ${diag.errorCount ?? '?'} error. Coba tambah akun Threads BPR/bank/koperasi di loker-sources.json.`,
          ...prev,
        ]);
      } else {
        setLogs((prev) => [
          `[${new Date().toLocaleTimeString('id-ID')}] ✅ SELESAI! Berhasil mengambil ${results.length} loker perbankan valid dari Threads (${diag.collected ?? '?'} post terkumpul, ${diag.analyzed ?? '?'} dianalisis, ${diag.bukanLoker ?? '?'} bukan loker).`,
          ...prev,
        ]);
      }
    } catch (err: any) {
      const msg = err.message || 'Gagal mengambil data. Periksa koneksi & GEMINI_API_KEY.';
      setScanError(msg);
      setLogs((prev) => [
        `[${new Date().toLocaleTimeString('id-ID')}] ❌ ${msg}`,
        ...prev,
      ]);
    } finally {
      setIsFetching(false);
      setIsFinished(true);
    }
  };

  const handleStopAutoScan = async () => {
    try {
      await fetch('/api/threads/auto-scan/stop', { method: 'POST' });
      setLogs((prev) => [
        `[${new Date().toLocaleTimeString('id-ID')}] ⏹️ Menghentikan pindaian (mungkin perlu beberapa detik)...`,
        ...prev,
      ]);
    } catch {
      /* ignore */
    }
  };

  const handleExportAllScannedExcel = async () => {
    if (scannedResults.length === 0) {
      alert('Belum ada hasil pindai bot Threads. Jalankan bot terlebih dahulu untuk menghasilkan data.');
      return;
    }
    const { exportVacanciesToExcel } = await import('../utils/excelExporter');
    await exportVacanciesToExcel(
      scannedResults.map((s) => s.vacancyData),
      `Laporan_Loker_Threads_${daysBack}Hari`
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
                  <span>Bot Scraper Auto-Run Threads</span>
                  <span className="text-[10px] px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 font-bold uppercase tracking-wider">
                    Sistem Otomatis
                  </span>
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Bot auto-scroll profil Threads BPR/bank/koperasi & ambil loker perbankan
                </p>
              </div>
            </div>
          </div>

          {/* Quick Excel Export */}
          <button
            onClick={handleExportAllScannedExcel}
            className="flex items-center space-x-2 px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold shadow-lg shadow-emerald-900/40 transition-all self-start lg:self-auto"
            title="Download seluruh hasil ke Excel (.XLSX) — 1 baris per perusahaan"
          >
            <FileDown className="h-4 w-4" />
            <span>Export Ke Excel (.XLSX)</span>
          </button>
        </div>

        {/* Configuration Panel */}
        <div className="mt-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {/* 1. Days Back Filter */}
          <div className="bg-slate-950 p-4 rounded-xl border border-slate-800">
            <label className="block text-xs font-bold text-slate-300 uppercase tracking-wider mb-2.5 flex items-center space-x-1.5">
              <Calendar className="h-3.5 w-3.5 text-amber-400" />
              <span>1. Rentang Hari Ke Belakang</span>
            </label>
            <select
              value={daysBack}
              onChange={(e) => setDaysBack(Number(e.target.value))}
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs font-semibold text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value={1}>1 Hari Terakhir (Postingan Kemarin & Hari Ini)</option>
              <option value={3}>3 Hari Terakhir (Rekomendasi Utama)</option>
              <option value={7}>7 Hari Terakhir (1 Minggu Kebelakang)</option>
              <option value={14}>14 Hari Terakhir (2 Minggu Kebelakang)</option>
              <option value={30}>30 Hari Terakhir (1 Bulan Kebelakang)</option>
            </select>
            <p className="text-[11px] text-slate-500 leading-tight mt-2">
              Rentang waktu post yang diambil (berdasarkan tanggal posting di Threads).
            </p>
          </div>

          {/* 2. Custom Max Posts */}
          <div className="bg-slate-950 p-4 rounded-xl border border-slate-800">
            <label className="block text-xs font-bold text-slate-300 uppercase tracking-wider mb-2.5 flex items-center space-x-1.5">
              <Sparkles className="h-3.5 w-3.5 text-indigo-400" />
              <span>2. Ambil Data (Jumlah Loker)</span>
            </label>
            <input
              type="number"
              min={1}
              max={100}
              value={maxPosts}
              onChange={(e) => setMaxPosts(Math.max(1, Math.min(100, Number(e.target.value) || 15)))}
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs font-semibold text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="text-[11px] text-slate-400 leading-tight mt-1.5">
              Jumlah loker perbankan yang diminta per run (maks. 100). Bot menggulir sampai
              terkumpul atau feed habis.
            </p>
          </div>

          {/* 3. Configured Accounts Summary */}
          <div className="bg-slate-950 p-4 rounded-xl border border-slate-800">
            <label className="block text-xs font-bold text-slate-300 uppercase tracking-wider mb-2.5 flex items-center space-x-1.5">
              <MessageCircle className="h-3.5 w-3.5 text-sky-400" />
              <span>3. Sumber Akun Terkonfigurasi</span>
            </label>
            <p className="text-sm font-bold text-slate-100">
              {threadsStatus.accountsCount > 0 ? (
                <>
                  {threadsStatus.accountsCount} akun Threads{' '}
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 font-bold uppercase tracking-wider align-middle">
                    Aktif
                  </span>
                </>
              ) : (
                <span className="text-slate-400">Memuat...</span>
              )}
            </p>
            <p className="text-[11px] text-slate-500 leading-tight mt-2">
              Daftar akun BPR/bank/koperasi/loker diambil dari key "threadsAccounts" di
              loker-sources.json. Bot membuka setiap akun secara otomatis.
            </p>
          </div>
        </div>

        {/* Start Button & Progress Bar */}
        <div className="mt-6 pt-5 border-t border-slate-800 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="text-xs text-slate-400 flex items-center space-x-2">
            <ShieldCheck className="h-4 w-4 text-emerald-400" />
            {isFetching ? (
              <span>Mengumpulkan post & menganalisis dengan AI (bisa butuh beberapa menit)...</span>
            ) : scannedResults.length > 0 ? (
              <span>
                Hasil scan: <strong className="text-slate-200">{scannedResults.length} loker</strong>{' '}
                valid dari Threads
              </span>
            ) : threadsStatus.accountsCount > 0 ? (
              <span>
                Siap memindai <strong className="text-slate-200">{threadsStatus.accountsCount} akun</strong>{' '}
                Threads (ambil {maxPosts} data)
              </span>
            ) : (
              <span>Memuat daftar akun dari server...</span>
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
                  <span>SEDANG MEMINDAI THREADS...</span>
                </button>
                <button
                  onClick={handleStopAutoScan}
                  className="w-full sm:w-auto flex items-center justify-center space-x-2 px-6 py-3 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-bold text-xs shadow-lg transition-all"
                >
                  <Pause className="h-4 w-4 fill-current" />
                  <span>STOP</span>
                </button>
              </div>
            ) : (
              <button
                onClick={handleStartBot}
                className="w-full sm:w-auto flex items-center justify-center space-x-2 px-7 py-3 rounded-xl bg-gradient-to-r from-slate-700 via-slate-600 to-slate-500 hover:from-slate-600 hover:to-slate-400 text-white font-extrabold text-xs shadow-xl shadow-slate-700/30 transition-all scale-105"
              >
                <Play className="h-4 w-4 fill-current" />
                <span>JALANKAN BOT SCRAPER THREADS (PERBANKAN)</span>
              </button>
            )}
          </div>
        </div>

        {/* Live Console */}
        {(isFetching || isFinished || logs.length > 0) && (
          <div className="mt-6 space-y-3">
            {scanError && (
              <p className="text-[11px] text-rose-400 font-mono truncate">{scanError}</p>
            )}
            {/* Console Log */}
            <div className="bg-slate-950 p-3.5 rounded-xl border border-slate-800 font-mono text-[11px] text-slate-300 max-h-36 overflow-y-auto space-y-1">
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
              <span>Hasil Postingan Terdeteksi ({scannedResults.length} Loker Valid)</span>
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Setiap post dilengkapi link URL resmi Threads & teks/gambar yang dianalisis AI.
            </p>
          </div>
        </div>

        {scannedResults.length === 0 ? (
          <div className="bg-slate-950 border border-dashed border-slate-800 rounded-xl p-8 text-center">
            <div className="flex flex-col items-center space-y-2 text-slate-500">
              <Bot className="h-8 w-8 text-slate-600" />
              <p className="text-xs font-semibold text-slate-300">Belum ada hasil pindaian.</p>
              <p className="text-[11px] max-w-md">
                Klik "JALANKAN BOT SCRAPER THREADS (PERBANKAN)" untuk mengambil loker perbankan
                dari profil Threads BPR/bank/koperasi. Teks post & gambar poster dibaca otomatis
                (OCR AI) dan hasil bisa di-export ke Excel.
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
