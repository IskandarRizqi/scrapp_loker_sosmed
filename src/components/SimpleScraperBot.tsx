import React, { useState, useEffect, useRef } from 'react';
import {
  Bot,
  Play,
  Sparkles,
  FileDown,
  ExternalLink,
  ShieldCheck,
  CheckSquare,
  Calendar,
  CalendarClock,
  Clock,
  Loader2,
  RefreshCcw,
  Database,
  Eye,
  Trash2,
  X,
} from 'lucide-react';
import {
  JobVacancy,
  BotFeedItem,
  AutoScanSource,
  IgScheduleConfig,
  ScheduledBatchSummary,
  ScheduledBatchDetail,
} from '../types';

interface SimpleScraperBotProps {
  onAddVacancy: (vacancy: JobVacancy) => void;
  savedVacancies: JobVacancy[];
  onSelectVacancy: (vacancy: JobVacancy) => void;
}

const SCHEDULE_DEFAULT: IgScheduleConfig = {
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

const fmtDateTime = (iso?: string | null) => {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
};

const fmtTime = (h: number, m: number) =>
  `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

const fmtOnlyDate = (iso?: string | null) => {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString('id-ID', { year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch {
    return null;
  }
};

export const SimpleScraperBot: React.FC<SimpleScraperBotProps> = ({
  onAddVacancy,
  savedVacancies,
  onSelectVacancy,
}) => {
  // Config state — satu source of truth untuk manual & jadwal
  const [schedule, setSchedule] = useState<IgScheduleConfig>(SCHEDULE_DEFAULT);
  const [daysBack, setDaysBack] = useState<number>(SCHEDULE_DEFAULT.daysBack);
  const [readTextAndImages, setReadTextAndImages] = useState(true);
  const [maxPosts, setMaxPosts] = useState<number>(SCHEDULE_DEFAULT.maxPosts);

  // Schedule auto-load/sync
  const [scheduleLoading, setScheduleLoading] = useState(true);

  // Execution State
  const [isFetching, setIsFetching] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [scannedResults, setScannedResults] = useState<BotFeedItem[]>([]);
  const [isFinished, setIsFinished] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  // Menandakan run OTOMATIS (dari jadwal) sedang berjalan di server. Digunakan agar
  // polling progress aktif walau user tidak menekan tombol "Mulai Scrap", sehingga
  // run terjadwal tampil LIVE di UI (log & hasil masuk otomatis).
  const [scheduleRunning, setScheduleRunning] = useState(false);

  // Backup modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [batches, setBatches] = useState<ScheduledBatchSummary[]>([]);
  const [modalLoading, setModalLoading] = useState(false);
  const [previewBatch, setPreviewBatch] = useState<ScheduledBatchDetail | null>(null);

  // Refs pelacak kemajuan polling live (hanya menambah entri baru, jangan duplikat).
  const postLogSeenRef = useRef(0);
  const resultsSeenRef = useRef(0);
  const lastProgressLogRef = useRef('');

  // ─── Schedule: load on mount ──────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    fetch('/api/auto-scan/scheduled')
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled && d?.success && d.schedule) {
          setSchedule(d.schedule);
          setDaysBack(d.schedule.daysBack);
          setMaxPosts(d.schedule.maxPosts);
        }
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setScheduleLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // ─── Schedule: auto-save daysBack / maxPosts ───────────────────────────
  const initialLoadDoneRef = useRef(false);
  useEffect(() => {
    if (!initialLoadDoneRef.current) {
      initialLoadDoneRef.current = true;
      return;
    }
    if (scheduleLoading) return;
    setSchedule((prev) => {
      if (prev.daysBack === daysBack && prev.maxPosts === maxPosts) return prev;
      return { ...prev, daysBack, maxPosts };
    });
  }, [daysBack, maxPosts, scheduleLoading]);

  // ─── Schedule: auto-save when schedule config changes ─────────────────
  const initialSaveDoneRef = useRef(false);
  useEffect(() => {
    if (!initialSaveDoneRef.current) {
      initialSaveDoneRef.current = true;
      return;
    }
    if (scheduleLoading) return;
    fetch('/api/auto-scan/scheduled', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(schedule),
    }).catch(() => {});
  }, [schedule.enabled, schedule.intervalDays, schedule.hour, schedule.minute, schedule.daysBack, schedule.maxPosts, scheduleLoading]);

  // ─── Schedule: helpers ────────────────────────────────────────────────
  const updateSchedule = (patch: Partial<IgScheduleConfig>) => {
    setSchedule((prev) => ({ ...prev, ...patch }));
  };

  const loadSchedule = async () => {
    try {
      const r = await fetch('/api/auto-scan/scheduled');
      const d = await r.json();
      if (d?.success && d.schedule) {
        setSchedule(d.schedule);
        setDaysBack(d.schedule.daysBack);
        setMaxPosts(d.schedule.maxPosts);
      }
    } catch {}
  };

  // Gabungan jam : menit jadi satu nilai "HH:MM" untuk satu field waktu.
  const timeValue = fmtTime(schedule.hour, schedule.minute);
  const updateTime = (val: string) => {
    if (!val) return;
    const [h, m] = val.split(':').map((n) => parseInt(n, 10));
    if (!Number.isNaN(h) && !Number.isNaN(m)) {
      updateSchedule({ hour: Math.max(0, Math.min(23, h)), minute: Math.max(0, Math.min(59, m)) });
    }
  };

  // Kalimat deskriptif status jadwal (mengikuti pola tampilan yang diminta).
  const scheduleSummary = () => {
    let f: string;
    if (schedule.intervalDays === 0) f = 'hari ini';
    else if (schedule.intervalDays > 1) f = `setiap ${schedule.intervalDays} hari`;
    else f = 'setiap hari';
    const timeLabel = fmtTime(schedule.hour, schedule.minute);
    if (!schedule.enabled) {
      return 'Nonaktif: aktifkan jadwal di atas agar bot Instagram berjalan otomatis tanpa perlu membuka browser.';
    }
    const lastDate = fmtOnlyDate(schedule.lastRunAt);
    const lastText = lastDate ? `Terakhir jalan: ${lastDate}.` : 'Belum pernah berjalan.';
    return `Aktif: sistem otomatis menjalankan scraping semua link tersimpan ${f} pukul ${timeLabel} (waktu komputer). ${lastText} Pastikan halaman ini tetap terbuka saat jam tersebut.`;
  };

  // ─── Schedule: backup modal handlers ──────────────────────────────────
  const openModal = async () => {
    setModalOpen(true);
    setPreviewBatch(null);
    await refreshBatches();
  };

  const refreshBatches = async () => {
    setModalLoading(true);
    try {
      const r = await fetch('/api/auto-scan/scheduled/results');
      const d = await r.json();
      if (d?.success && Array.isArray(d.data)) setBatches(d.data);
    } catch {}
    finally { setModalLoading(false); }
  };

  const handlePreview = async (id: string) => {
    setPreviewBatch(null);
    try {
      const r = await fetch(`/api/auto-scan/scheduled/results/${id}`);
      const d = await r.json();
      if (d?.success && d.data) setPreviewBatch(d.data);
      else if (d?.error) alert(d.error);
    } catch { alert('Gagal memuat detail batch.'); }
  };

  const handleDownload = async (id: string) => {
    try {
      const r = await fetch(`/api/auto-scan/scheduled/results/${id}/export`, { method: 'POST' });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        alert(d.error || 'Gagal mengunduh.');
        return;
      }
      const disposition = r.headers.get('Content-Disposition') || '';
      const filenameMatch = disposition.match(/filename="?([^"]+)"?/);
      const filename = filenameMatch ? filenameMatch[1] : `Backup_IG_${id}.xlsx`;
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err: any) { alert(err.message || 'Gagal mengunduh.'); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Hapus batch ini secara permanen?')) return;
    try {
      const r = await fetch(`/api/auto-scan/scheduled/results/${id}`, { method: 'DELETE' });
      const d = await r.json();
      if (!r.ok || !d.success) throw new Error(d.error || 'Gagal menghapus.');
      await refreshBatches();
    } catch (err: any) { alert(err.message || 'Gagal menghapus.'); }
  };

  // ─── Poll live progress/log/results dari server ────────────────────────
  // Jalan terus saat run manual (isFetching) ATAU saat jadwal aktif (schedule.enabled),
  // sehingga run otomatis dari scheduler juga tampil live tanpa harus menekan tombol.
  const pollActive = isFetching || schedule.enabled;
  useEffect(() => {
    if (!pollActive) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch('/api/auto-scan/progress');
        const d = await r.json();
        if (cancelled || !d?.progress) return;
        const p = d.progress;
        // Pantau status auto-run: bila jadwal aktif dan server sedang running, tandai.
        if (schedule.enabled) {
          setScheduleRunning(p.running === true);
        }
        if (p.running === true) {
          const activity =
            p.phase === 'analyzing' ? 'Menganalisis dengan AI' : 'Mengumpulkan postingan';
          const line = `[${new Date().toLocaleTimeString('id-ID')}] ⏳ ${activity} · Query ${Math.min(p.queriesDone + 1, p.queriesTotal)}/${p.queriesTotal} · ${p.postsDiscovered} post ditemukan · ${p.postsAnalyzed} dianalisis${p.resultCount ? ` · ${p.resultCount} hasil ✓` : ''}`;
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
  }, [pollActive, schedule.enabled]);

  // Load sources
  const [availableSources, setAvailableSources] = useState<{
    instagram: AutoScanSource[];
    queryCount: number;
  }>({ instagram: [], queryCount: 0 });

  useEffect(() => {
    let cancelled = false;
    fetch('/api/auto-scan/sources')
      .then((r) => r.json())
      .then((res: { success: boolean; data?: typeof availableSources }) => {
        if (!cancelled && res.success && res.data) setAvailableSources(res.data);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const totalConfiguredSources = availableSources.instagram.length + availableSources.queryCount;

  // ─── Start Bot ────────────────────────────────────────────────────────
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
      `[${new Date().toLocaleTimeString('id-ID')}] 🚀 MEMULAI BOT AUTO-SCRAPER...`,
      `[${new Date().toLocaleTimeString('id-ID')}] ⚙️ Parameter: Platform [IG], Rentang: ${daysBack} hari ke belakang, Sumber: query & akun dari loker-sources.json, Ambil ${maxPosts} data.`,
      `[${new Date().toLocaleTimeString('id-ID')}] 📡 Mencari & mengambil postingan loker LANGSUNG dari Instagram (search + embed publik + OCR gambar)...`,
    ]);

    try {
      const response = await fetch('/api/auto-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          useInstagram: true,
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
          queries?: number;
          discovered?: number;
          analyzed?: number;
          bukanLoker?: number;
          errorCount?: number;
          duplicates?: number;
          results?: number;
        };
      } = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Terjadi kesalahan saat mengambil data Instagram.');
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
          `[${new Date().toLocaleTimeString('id-ID')}] ⚠️ ${data.message || 'Tidak ada postingan loker ditemukan.'} Ringkasan: ${diag.discovered ?? '?'} post ditemukan, ${diag.analyzed ?? '?'} dianalisis, ${diag.bukanLoker ?? '?'} bukan loker, ${diag.errorCount ?? '?'} error. Coba tambah akun IG di loker-sources.json atau perbesar jumlah postingan.`,
          ...prev,
        ]);
      } else {
        setLogs((prev) => [
          `[${new Date().toLocaleTimeString('id-ID')}] ✅ SELESAI! Berhasil mengambil ${results.length} postingan loker valid dari Instagram (${diag.discovered ?? '?'} ditemukan, ${diag.analyzed ?? '?'} dianalisis, ${diag.bukanLoker ?? '?'} bukan loker).`,
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

  // ─── Export Excel ─────────────────────────────────────────────────────
  const handleExportAllScannedExcel = async () => {
    if (scannedResults.length === 0) {
      alert('Belum ada hasil pindai bot Instagram. Jalankan bot terlebih dahulu untuk menghasilkan data.');
      return;
    }
    const { exportVacanciesToExcel } = await import('../utils/excelExporter');
    await exportVacanciesToExcel(
      scannedResults.map((s) => s.vacancyData),
      `Laporan_Loker_IG_${daysBack}Hari`
    );
  };

  // ─── Render ───────────────────────────────────────────────────────────
  return (
    <div className="space-y-6 mb-8">
      {/* Primary Control Box */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 sm:p-7 shadow-2xl text-slate-100">
        {/* ── Header ── */}
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-5 border-b border-slate-800">
          <div>
            <div className="flex items-center space-x-2.5">
              <div className="h-11 w-11 rounded-2xl bg-gradient-to-tr from-blue-600 to-indigo-600 flex items-center justify-center shadow-lg shadow-blue-500/25">
                <Bot className="h-6 w-6 text-white animate-pulse" />
              </div>
              <div>
                <h2 className="text-lg font-bold text-white flex items-center space-x-2">
                  <span>Bot Scraper Auto-Run Instagram</span>
                  <span className="text-[10px] px-2.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 font-bold uppercase tracking-wider">
                    Sistem Otomatis
                  </span>
                </h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Tentukan parameter, jalankan scraper otomatis — atau atur jadwal berjalan sendiri
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center space-x-2 self-start lg:self-auto">
            <button
              onClick={handleExportAllScannedExcel}
              className="flex items-center space-x-2 px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold shadow-lg shadow-emerald-900/40 transition-all"
              title="Download seluruh hasil ke Excel (.XLSX)"
            >
              <FileDown className="h-4 w-4" />
              <span>Export Ke Excel</span>
            </button>
            <button
              onClick={() => void openModal()}
              className="flex items-center space-x-2 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold shadow-lg shadow-indigo-900/40 transition-all"
              title="Lihat & unduh data hasil jadwal yang tersimpan"
            >
              <Database className="h-4 w-4" />
              <span>Backup / Lihat Data</span>
            </button>
          </div>
        </div>

        {/* ── Indikator run otomatis sedang berjalan ── */}
        {scheduleRunning && (
          <div className="mt-4 flex items-center space-x-3 p-3 rounded-xl bg-emerald-950/60 border border-emerald-600/40">
            <Loader2 className="h-5 w-5 text-emerald-400 animate-spin shrink-0" />
            <div>
              <p className="text-sm font-bold text-emerald-300">
                Auto-run terjadwal sedang berjalan…
              </p>
              <p className="text-[11px] text-slate-300">
                Scraping berjalan otomatis dari server sesuai jadwal. Log & hasil akan masuk di bawah.
              </p>
            </div>
          </div>
        )}

        {/* ── Pengaturan & Penjadwalan (1 blok) ── */}
        <div className="mt-6">
          {/* Toggle Aktif/Nonaktif — taruh paling atas */}
          <div
            className={`flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 sm:p-5 rounded-xl border transition-colors ${
              schedule.enabled
                ? 'bg-gradient-to-r from-emerald-950/70 to-slate-950 border-emerald-700/50'
                : 'bg-slate-950 border-slate-800'
            }`}
          >
            <div className="flex items-center space-x-3">
              <div
                onClick={() => updateSchedule({ enabled: !schedule.enabled })}
                className={`relative w-12 h-7 rounded-full transition-colors cursor-pointer shrink-0 ${
                  schedule.enabled ? 'bg-emerald-500' : 'bg-slate-700'
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-6 h-6 bg-white rounded-full shadow transition-transform ${
                    schedule.enabled ? 'translate-x-5' : ''
                  }`}
                />
              </div>
              <div>
                <p className="text-sm font-bold text-white flex items-center space-x-2">
                  <CalendarClock className="h-4 w-4 text-emerald-400" />
                  <span>{schedule.enabled ? 'Jadwal AKTIF' : 'Jadwal Nonaktif'}</span>
                </p>
                <p className="text-[11px] text-slate-400">
                  Geser untuk mengaktifkan/menonaktifkan bot otomatis.
                </p>
              </div>
            </div>
            <div className="text-right text-[11px] text-slate-400 shrink-0 sm:pr-2">
              <p>
                Run terakhir:{' '}
                <span className="text-slate-200 font-semibold">
                  {schedule.lastRunAt ? fmtDateTime(schedule.lastRunAt) : '-'}
                </span>
              </p>
              <p className="mt-0.5">
                Berikutnya:{' '}
                <span className="text-emerald-300 font-semibold">
                  {schedule.enabled ? fmtDateTime(schedule.nextRunAt) : '-'}
                </span>
              </p>
            </div>
          </div>

          {/* Kartu status — jam besar + kalimat deskriptif */}
          <div
            className={`mt-4 rounded-2xl border p-5 text-center ${
              schedule.enabled
                ? 'bg-gradient-to-br from-emerald-950/60 to-slate-950 border-emerald-800/50'
                : 'bg-slate-950 border-slate-800'
            }`}
          >
            <div className="text-5xl font-extrabold tracking-tight text-white tabular-nums">
              {timeValue}
            </div>
            <p
              className={`mt-3 text-sm leading-relaxed max-w-2xl mx-auto ${
                schedule.enabled ? 'text-slate-200' : 'text-slate-400'
              }`}
            >
              {scheduleSummary()}
            </p>
            {schedule.lastStatus && schedule.enabled && (
              <p className="mt-3 text-[11px] text-amber-300/90 italic">{schedule.lastStatus}</p>
            )}
          </div>

          {/* Grid pengaturan — jadwal & pencarian jadi satu */}
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
            {/* Setiap Berapa Hari */}
            <div className="bg-slate-950 p-4 rounded-xl border border-slate-800">
              <label className="block text-[11px] font-bold text-slate-300 uppercase tracking-wider mb-2 flex items-center space-x-1.5">
                <CalendarClock className="h-3 w-3 text-emerald-400" />
                <span>Setiap Hari</span>
              </label>
              <input
                type="number"
                min={0}
                max={365}
                value={schedule.intervalDays}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  updateSchedule({ intervalDays: Math.max(0, Math.min(365, e.target.value === '' || Number.isNaN(v) ? 3 : v)) });
                }}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs font-semibold text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
              <p className="text-[11px] text-slate-400 leading-tight mt-1.5">
                0 = hari ini, 1 = setiap hari, 3 = setiap 3 hari.
              </p>
            </div>

            {/* Waktu */}
            <div className="bg-slate-950 p-4 rounded-xl border border-slate-800">
              <label className="block text-[11px] font-bold text-slate-300 uppercase tracking-wider mb-2 flex items-center space-x-1.5">
                <Clock className="h-3 w-3 text-emerald-400" />
                <span>Waktu</span>
              </label>
              <input
                type="time"
                value={timeValue}
                onChange={(e) => updateTime(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm font-semibold text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500 [color-scheme:dark]"
              />
              <p className="text-[11px] text-slate-400 leading-tight mt-1.5">Jam & menit mulai scraping.</p>
            </div>

            {/* Rentang Hari */}
            <div className="bg-slate-950 p-4 rounded-xl border border-slate-800">
              <label className="block text-[11px] font-bold text-slate-300 uppercase tracking-wider mb-2 flex items-center space-x-1">
                <Calendar className="h-3 w-3 text-amber-400" />
                <span>Rentang Hari</span>
              </label>
              <select
                value={daysBack}
                onChange={(e) => setDaysBack(Number(e.target.value))}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs font-semibold text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value={1}>1 Hari</option>
                <option value={3}>3 Hari</option>
                <option value={7}>7 Hari</option>
                <option value={14}>14 Hari</option>
                <option value={30}>30 Hari</option>
              </select>
            </div>

            {/* Jumlah Loker */}
            <div className="bg-slate-950 p-4 rounded-xl border border-slate-800">
              <label className="block text-[11px] font-bold text-slate-300 uppercase tracking-wider mb-2 flex items-center space-x-1">
                <CheckSquare className="h-3 w-3 text-indigo-400" />
                <span>Jumlah Loker</span>
              </label>
              <input
                type="number"
                min={1}
                max={100}
                value={maxPosts}
                onChange={(e) => setMaxPosts(Math.max(1, Math.min(100, Number(e.target.value) || 15)))}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs font-semibold text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <p className="text-[11px] text-slate-400 leading-tight mt-1.5">Maks. 100.</p>
            </div>

            {/* Tipe Bacaan AI */}
            <div className="bg-slate-950 p-4 rounded-xl border border-slate-800">
              <label className="block text-[11px] font-bold text-slate-300 uppercase tracking-wider mb-2 flex items-center space-x-1">
                <Sparkles className="h-3 w-3 text-emerald-400" />
                <span>Tipe Bacaan AI</span>
              </label>
              <div className="space-y-2">
                <label className="flex items-center space-x-2.5 text-xs text-slate-200 cursor-pointer hover:text-white transition-colors">
                  <input
                    type="checkbox"
                    checked={readTextAndImages}
                    onChange={(e) => setReadTextAndImages(e.target.checked)}
                    className="rounded border-slate-700 bg-slate-900 text-blue-600 focus:ring-blue-500 h-4 w-4"
                  />
                  <span className="font-semibold">Baca Caption & Gambar (OCR)</span>
                </label>
              </div>
            </div>
          </div>
        </div>

        {/* ── Start Button & Progress Bar ── */}
        <div className="mt-6 pt-5 border-t border-slate-800 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="text-xs text-slate-400 flex items-center space-x-2">
            <ShieldCheck className="h-4 w-4 text-emerald-400" />
            {isFetching || scheduleRunning ? (
              <span>Mengambil data langsung dari Instagram (bisa butuh beberapa menit)...</span>
            ) : scannedResults.length > 0 ? (
              <span>
                Hasil scan: <strong className="text-slate-200">{scannedResults.length} postingan</strong> loker valid
              </span>
            ) : totalConfiguredSources > 0 ? (
              <span>
                Siap memindai <strong className="text-slate-200">{totalConfiguredSources} sumber</strong> Instagram
                (ambil {maxPosts} data)
              </span>
            ) : (
              <span>Memuat daftar sumber dari server...</span>
            )}
          </div>

          <div className="flex items-center space-x-3 w-full sm:w-auto">
            {isFetching || scheduleRunning ? (
              <button
                disabled
                className="w-full sm:w-auto flex items-center justify-center space-x-2 px-7 py-3 rounded-xl bg-slate-700 text-white font-extrabold text-xs opacity-70 cursor-wait transition-all"
              >
                <div className="h-4 w-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                <span>{scheduleRunning ? 'AUTO-RUN SEDANG BERJALAN...' : 'MENGAMBIL DATA INSTAGRAM...'}</span>
              </button>
            ) : (
              <button
                onClick={handleStartBot}
                className="w-full sm:w-auto flex items-center justify-center space-x-2 px-7 py-3 rounded-xl bg-gradient-to-r from-blue-600 via-indigo-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 text-white font-extrabold text-xs shadow-xl shadow-blue-600/30 transition-all scale-105"
              >
                <Play className="h-4 w-4 fill-current" />
                <span>Mulai Scrap</span>
              </button>
            )}
          </div>
        </div>

        {/* ── Live Console ── */}
        {(isFetching || isFinished || logs.length > 0) && (
          <div className="mt-6 space-y-3">
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

      {/* ── Discovered Vacancies List ── */}
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
              Setiap postingan telah dilengkapi link URL resmi Instagram & teks lengkap yang bisa langsung disalin.
            </p>
          </div>
        </div>

        {scannedResults.length === 0 ? (
          <div className="bg-slate-950 border border-dashed border-slate-800 rounded-xl p-8 text-center">
            <div className="flex flex-col items-center space-y-2 text-slate-500">
              <Bot className="h-8 w-8 text-slate-600" />
              <p className="text-xs font-semibold text-slate-300">Belum ada hasil pindaian.</p>
              <p className="text-[11px] max-w-md">
                Klik "JALANKAN BOT AUTO-SCRAPER" untuk mengambil postingan loker langsung dari Instagram. Setiap
                teks caption & gambar poster dibaca otomatis (OCR AI).
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

      {/* ═══════════════════ Backup / Lihat Data Modal ═══════════════════ */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 p-4 sm:p-8 overflow-y-auto">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-6xl shadow-2xl my-auto animate-fadeIn">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
              <div>
                <h3 className="font-bold text-white">Backup / Lihat Data Hasil Jadwal</h3>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  Data otomatis dihapus setelah 30 hari sejak waktu run. Urut berdasarkan waktu terbaru.
                </p>
              </div>
              <button
                onClick={() => setModalOpen(false)}
                className="p-2 rounded-lg hover:bg-slate-800 text-slate-300"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="p-5">
              {/* Preview panel */}
              {previewBatch && (
                <div className="mb-5 bg-slate-950 rounded-xl border border-slate-800 overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800 bg-slate-900/60">
                    <div className="flex items-center space-x-2">
                      <Eye className="h-4 w-4 text-indigo-400" />
                      <span className="text-xs font-bold text-slate-200">
                        Preview Batch — {fmtDateTime(previewBatch.capturedAt)}
                      </span>
                    </div>
                    <div className="flex items-center space-x-2">
                      <button
                        onClick={() => void handleDownload(previewBatch.id)}
                        className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-bold"
                      >
                        <FileDown className="h-3.5 w-3.5" />
                        <span>Unduh</span>
                      </button>
                      <button
                        onClick={() => setPreviewBatch(null)}
                        className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  </div>

                  {previewBatch.results.length === 0 ? (
                    <div className="p-6 text-center text-xs text-slate-500">Batch ini tidak memiliki hasil lowongan.</div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs text-left border-collapse min-w-[640px]">
                        <thead>
                          <tr className="bg-slate-900 text-slate-300 uppercase text-[10px] tracking-wider border-b border-slate-700">
                            <th className="px-3 py-2.5">No</th>
                            <th className="px-3 py-2.5">Perusahaan</th>
                            <th className="px-3 py-2.5">Posisi</th>
                            <th className="px-3 py-2.5">Wilayah</th>
                            <th className="px-3 py-2.5">Batas</th>
                            <th className="px-3 py-2.5 text-center">Sumber</th>
                          </tr>
                        </thead>
                        <tbody>
                          {previewBatch.results.map((item, index) => {
                            const vd = item.vacancyData;
                            return (
                              <tr key={item.id || index} className="border-b border-slate-800/80 hover:bg-slate-800/40">
                                <td className="px-3 py-2.5 text-slate-500">{index + 1}</td>
                                <td className="px-3 py-2.5 font-semibold text-blue-400 whitespace-nowrap">
                                  {vd.companyName || '-'}
                                </td>
                                <td className="px-3 py-2.5 text-slate-100">{vd.jobTitle || '-'}</td>
                                <td className="px-3 py-2.5 text-slate-300">{vd.workLocation || '-'}</td>
                                <td className="px-3 py-2.5 text-rose-400 whitespace-nowrap">{vd.deadline || '-'}</td>
                                <td className="px-3 py-2.5 text-center">
                                  {vd.sourceUrl && (
                                    <a
                                      href={vd.sourceUrl}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="inline-flex px-2 py-1 rounded-md bg-blue-600 hover:bg-blue-500 text-white text-[10px] font-bold"
                                    >
                                      Buka
                                    </a>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {/* Batches table */}
              {modalLoading ? (
                <div className="py-10 text-center flex items-center justify-center space-x-2 text-xs text-slate-400">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Memuat data...</span>
                </div>
              ) : batches.length === 0 ? (
                <div className="py-10 text-center text-xs text-slate-500">
                  Belum ada data hasil jadwal tersimpan. Aktifkan jadwal lalu jalankan bot otomatis.
                </div>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-slate-800">
                  <table className="w-full text-xs text-left border-collapse min-w-[760px]">
                    <thead>
                      <tr className="bg-slate-950 text-slate-300 uppercase text-[10px] tracking-wider border-b border-slate-700">
                        <th className="px-3 py-3 w-12 text-center">No</th>
                        <th className="px-3 py-3">Waktu Run</th>
                        <th className="px-3 py-3 text-center">Jumlah Loker</th>
                        <th className="px-3 py-3 text-center">Ditemukan</th>
                        <th className="px-3 py-3 text-center">Dianalisis</th>
                        <th className="px-3 py-3 text-center">Bukan Loker</th>
                        <th className="px-3 py-3 text-center w-44">Aksi</th>
                      </tr>
                    </thead>
                    <tbody>
                      {batches.map((b, index) => (
                        <tr key={b.id} className="border-b border-slate-800/80 hover:bg-slate-800/40">
                          <td className="px-3 py-3 text-center text-slate-500">{index + 1}</td>
                          <td className="px-3 py-3 font-semibold text-slate-100 whitespace-nowrap">
                            {fmtDateTime(b.capturedAt)}
                          </td>
                          <td className="px-3 py-3 text-center text-emerald-400 font-bold">{b.vacancyCount}</td>
                          <td className="px-3 py-3 text-center text-slate-300">{b.diagnostics.discovered}</td>
                          <td className="px-3 py-3 text-center text-slate-300">{b.diagnostics.analyzed}</td>
                          <td className="px-3 py-3 text-center text-slate-300">{b.diagnostics.bukanLoker}</td>
                          <td className="px-3 py-3 text-center">
                            <div className="flex items-center justify-center space-x-1.5">
                              <button
                                onClick={() => void handlePreview(b.id)}
                                className="inline-flex items-center space-x-1 px-2.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-[10px] font-bold"
                              >
                                <Eye className="h-3 w-3" />
                                <span>Preview</span>
                              </button>
                              <button
                                onClick={() => void handleDownload(b.id)}
                                className="inline-flex items-center space-x-1 px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-bold"
                              >
                                <FileDown className="h-3 w-3" />
                                <span>Unduh</span>
                              </button>
                              <button
                                onClick={() => void handleDelete(b.id)}
                                className="inline-flex items-center p-1.5 rounded-lg bg-rose-600/20 hover:bg-rose-600 text-rose-300 text-[10px]"
                                title="Hapus"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

<div className="mt-4 flex items-center justify-between">
                <p className="text-[11px] text-slate-500">
                  Retensi otomatis: data berumur lebih dari 30 hari akan dihapus sendiri dari server.
                </p>
                <button
                  onClick={() => void refreshBatches()}
                  className="flex items-center space-x-1.5 px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold"
                >
                  <RefreshCcw className="h-3.5 w-3.5" />
                  <span>Muat Ulang</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
