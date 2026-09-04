import React, { useState, useEffect } from 'react';
import { SimpleScraperBot } from './components/SimpleScraperBot';
import { FacebookScraperBot } from './components/FacebookScraperBot';
import { TwitterScraperBot } from './components/TwitterScraperBot';
import { ThreadsScraperBot } from './components/ThreadsScraperBot';
import { ResultView } from './components/ResultView';
import { HowToUseModal } from './components/HowToUseModal';
import { Dashboard } from './components/Dashboard';
import { ManualOcrPage } from './components/ManualOcrPage';
import { JobVacancy, ScanRequestPayload, ScanResponsePayload, AppPage } from './types';
import { isDeadlineExpired } from './utils/deadline';
import { parseLogoBox, cropImageToLogo, normalizeLogoImage } from './utils/cropLogo';
import { AlertCircle, Instagram, Facebook, ShieldCheck, ArrowLeft, FileDown } from 'lucide-react';

const LOCAL_STORAGE_KEY = 'lokerdetector_saved_vacancies_v3';

export default function App() {
  const [isLoading, setIsLoading] = useState(false);
  const [currentResult, setCurrentResult] = useState<JobVacancy | null>(null);
  const [savedVacancies, setSavedVacancies] = useState<JobVacancy[]>([]);
  const [ocrResults, setOcrResults] = useState<JobVacancy[]>([]);
  const [isGuideOpen, setIsGuideOpen] = useState(false);
  const [warningMessage, setWarningMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [manualProgress, setManualProgress] = useState<string | null>(null);
  const [page, setPage] = useState<AppPage>(() => {
    const h = window.location.hash.replace(/^#\/?/, '');
    return h === 'instagram'
      ? 'instagram'
      : h === 'facebook'
        ? 'facebook'
        : h === 'twitter'
          ? 'twitter'
          : h === 'threads'
            ? 'threads'
            : h === 'ocr'
              ? 'ocr'
              : 'dashboard';
  });

  const handleNavigate = (target: AppPage) => {
    window.location.hash = target === 'dashboard' ? '/' : `/${target}`;
    setPage(target);
    window.scrollTo({ top: 0 });
  };

  // Hash-based routing (no router dependency) so pages can be deep-linked/shared.
  useEffect(() => {
    const onHashChange = () => {
      const h = window.location.hash.replace(/^#\/?/, '');
      setPage(h === 'instagram' ? 'instagram' : h === 'facebook' ? 'facebook' : h === 'twitter' ? 'twitter' : h === 'threads' ? 'threads' : h === 'ocr' ? 'ocr' : 'dashboard');
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // A vacancy is considered a duplicate when it shares the same id OR the same source URL.
  // ids are randomized per scan, so sourceUrl is the stable identity used to prevent
  // the same loker being saved twice when the bot runs repeatedly.
  const isDuplicate = (list: JobVacancy[], v: JobVacancy) =>
    list.some(
      (x) => x.id === v.id || (!!x.sourceUrl && !!v.sourceUrl && x.sourceUrl === v.sourceUrl)
    );

  // Initial load: populate with saved vacancies from local storage
  useEffect(() => {
    try {
      // Remove legacy demo-data storage (v2) so hardcoded samples never reappear
      localStorage.removeItem('lokerdetector_saved_vacancies_v2');
      localStorage.removeItem('lokerdetector_saved_vacancies_v1');

      const stored = localStorage.getItem(LOCAL_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as JobVacancy[];
        // Drop any duplicate entries (by id or sourceUrl) left from older runs
        const unique: JobVacancy[] = [];
        const seen = new Set<string>();
        for (const v of parsed) {
          const key = v.sourceUrl || v.id;
          if (seen.has(key)) continue;
          seen.add(key);
          unique.push(v);
        }
        // Remove vacancies whose deadline has already passed (expired)
        const active = unique.filter((v) => !isDeadlineExpired(v.deadline));
        setSavedVacancies(active);
        if (active.length !== unique.length) {
          localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(active));
        }
      }
    } catch (e) {
      console.warn('Failed to load local storage:', e);
    }
  }, []);

  // Save state updates to localStorage
  const saveToStorage = (updated: JobVacancy[]) => {
    setSavedVacancies(updated);
    try {
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(updated));
    } catch (e) {
      console.warn('Failed to save to local storage:', e);
    }
  };

  const handleScan = async (payload: ScanRequestPayload) => {
    setIsLoading(true);
    setWarningMessage(null);
    setErrorMessage(null);

    try {
      const response = await fetch('/api/analyze-loker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data: ScanResponsePayload = await response.json();

      if (!response.ok || !data.success || !data.data) {
        throw new Error(data.error || 'Terjadi kesalahan saat memproses data loker.');
      }

      const vacancy = data.data;
      setCurrentResult(vacancy);

      // Prefer the official logo resolved server-side (from the company website);
      // otherwise crop the detected logo area out of the uploaded screenshot.
      if (vacancy.logoDataUrl) {
        vacancy.logoDataUrl = (await normalizeLogoImage(vacancy.logoDataUrl)) || vacancy.logoDataUrl;
      } else if (payload.images && payload.images.length > 0) {
        const logoBox = parseLogoBox(vacancy.logoBox);
        if (logoBox) {
          const logoUrl = await cropImageToLogo(payload.images[0], logoBox);
          if (logoUrl) vacancy.logoDataUrl = logoUrl;
        }
      }

      if (data.warning) {
        setWarningMessage(data.warning);
      }

      // Accumulate every processed result for the OCR-page Excel export (valid ones go
      // to the "Data Loker" sheet, rejected ones to the "Tidak Valid" sheet).
      setOcrResults((prev) => [vacancy, ...prev]);

      // Auto save if valid vacancy (skip expired ones)
      if (vacancy.isVacancy) {
        if (vacancy.isExpired) {
          setWarningMessage(
            'Lowongan ini sudah melewati batas akhir pendaftaran (expired) sehingga tidak disimpan ke riwayat.'
          );
        } else if (!isDuplicate(savedVacancies, vacancy)) {
          saveToStorage([vacancy, ...savedVacancies]);
        }
      }

      // Scroll smoothly to result view
      window.scrollTo({ top: 400, behavior: 'smooth' });
    } catch (err: any) {
      console.error('Scan Error:', err);
      setErrorMessage(
        err.message || 'Gagal menganalisis. Silakan coba unggah gambar screenshot poster/sorotan Instagram atau Facebook.'
      );
    } finally {
      setIsLoading(false);
    }
  };

  // Manual scan: when multiple screenshots are uploaded, analyze EACH photo separately so
  // every photo becomes its own vacancy row (one perusahaan per baris). A single photo /
  // text / url falls back to the normal single-analysis path.
  const handleManualScan = async (payload: ScanRequestPayload) => {
    const images = payload.images || [];
    if (images.length <= 1) return handleScan(payload);

    setIsLoading(true);
    setWarningMessage(null);
    setErrorMessage(null);
    const total = images.length;
    const batchWarnings: string[] = [];
    let updated = savedVacancies;
    let addedCount = 0;

    try {
      for (let i = 0; i < total; i++) {
        setManualProgress(`Menganalisis foto ${i + 1}/${total}`);
        try {
          const response = await fetch('/api/analyze-loker', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ images: [images[i]] }),
          });
          const data: ScanResponsePayload = await response.json();
          if (!response.ok || !data.success || !data.data) {
            batchWarnings.push(`Foto ${i + 1}: ${data.error || 'gagal diproses'}`);
            continue;
          }
          const vacancy = data.data;
          if (vacancy.logoDataUrl) {
            vacancy.logoDataUrl = (await normalizeLogoImage(vacancy.logoDataUrl)) || vacancy.logoDataUrl;
          } else if (vacancy.logoBox && images[i]) {
            const logoBox = parseLogoBox(vacancy.logoBox);
            if (logoBox) {
              const logoUrl = await cropImageToLogo(images[i], logoBox);
              if (logoUrl) vacancy.logoDataUrl = logoUrl;
            }
          }
          setCurrentResult(vacancy);
          // Accumulate every processed photo (valid -> "Data Loker", rejected -> "Tidak Valid")
          setOcrResults((prev) => [vacancy, ...prev]);
          if (vacancy.isVacancy) {
            if (vacancy.isExpired) {
              batchWarnings.push(
                `Foto ${i + 1}: lowongan sudah expired sehingga tidak disimpan.`
              );
            } else if (!isDuplicate(updated, vacancy)) {
              updated = [vacancy, ...updated];
              addedCount++;
            }
          } else {
            batchWarnings.push(`Foto ${i + 1}: tidak terdeteksi sebagai lowongan kerja.`);
          }
        } catch (err: any) {
          batchWarnings.push(`Foto ${i + 1}: ${err.message || 'gagal diproses'}`);
        }
      }

      saveToStorage(updated);
      if (batchWarnings.length > 0) {
        setWarningMessage(
          `Selesai: ${addedCount} lowongan disimpan dari ${total} foto.${batchWarnings.length > 0 ? `\n${batchWarnings.join('\n')}` : ''}`
        );
      }
      if (addedCount > 0) window.scrollTo({ top: 400, behavior: 'smooth' });
    } finally {
      setManualProgress(null);
      setIsLoading(false);
    }
  };

  const handleAddVacancy = (vacancy: JobVacancy) => {
    if (vacancy.isExpired) return;
    if (!isDuplicate(savedVacancies, vacancy)) {
      saveToStorage([vacancy, ...savedVacancies]);
    }
  };

  const handleSaveToggle = (vacancy: JobVacancy) => {
    const isSaved = isDuplicate(savedVacancies, vacancy);
    if (isSaved) {
      saveToStorage(
        savedVacancies.filter(
          (v) =>
            v.id !== vacancy.id &&
            !(v.sourceUrl && vacancy.sourceUrl && v.sourceUrl === vacancy.sourceUrl)
        )
      );
    } else {
      saveToStorage([vacancy, ...savedVacancies]);
    }
  };

  const handleClearAll = () => {
    if (confirm('Apakah Anda yakin ingin menghapus semua simpanan riwayat loker?')) {
      saveToStorage([]);
    }
  };

  const handleExportOcr = async () => {
    const { exportVacanciesToExcel } = await import('./utils/excelExporter');
    await exportVacanciesToExcel(ocrResults, 'Hasil_Pindai_Gambar_OCR');
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 font-sans selection:bg-blue-500 selection:text-white flex flex-col">
      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {page === 'dashboard' && (
          <Dashboard
            onNavigate={(p) => handleNavigate(p)}
            savedCount={savedVacancies.length}
            onOpenGuide={() => setIsGuideOpen(true)}
            onClearHistory={handleClearAll}
          />
        )}

        {page === 'ocr' && (
          <>
            {/* Warning Toast */}
            {warningMessage && (
              <div className="mb-6 bg-amber-950/80 border border-amber-800 text-amber-200 p-4 rounded-xl flex items-start space-x-3 text-xs shadow-lg animate-fadeIn">
                <AlertCircle className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
                <div className="flex-1">
                  <span className="font-bold">Info Tautan / Link:</span> {warningMessage}
                </div>
                <button
                  onClick={() => setWarningMessage(null)}
                  className="text-amber-400 hover:text-white font-bold"
                >
                  ✕
                </button>
              </div>
            )}

            {/* Error Toast */}
            {errorMessage && (
              <div className="mb-6 bg-rose-950/80 border border-rose-800 text-rose-200 p-4 rounded-xl flex items-start space-x-3 text-xs shadow-lg animate-fadeIn">
                <AlertCircle className="h-5 w-5 text-rose-400 shrink-0 mt-0.5" />
                <div className="flex-1">
                  <span className="font-bold">Gagal Memproses:</span> {errorMessage}
                </div>
                <button
                  onClick={() => setErrorMessage(null)}
                  className="text-rose-400 hover:text-white font-bold"
                >
                  ✕
                </button>
              </div>
            )}

            <ManualOcrPage
              onScan={handleManualScan}
              isLoading={isLoading}
              progress={manualProgress ?? undefined}
              onBack={() => handleNavigate('dashboard')}
              onExport={handleExportOcr}
              exportCount={ocrResults.length}
            />

            {currentResult && (
              <div className="animate-fadeIn">
                <ResultView
                  vacancy={currentResult}
                  onSave={handleSaveToggle}
                  isSaved={savedVacancies.some((v) => v.id === currentResult.id)}
                />
              </div>
            )}
          </>
        )}

        {page === 'instagram' && (
          <>
            <button
              onClick={() => handleNavigate('dashboard')}
              className="flex items-center space-x-2 px-3 py-2 rounded-xl bg-slate-900 border border-slate-800 hover:border-slate-600 text-xs font-bold text-slate-200 transition-colors mb-6"
            >
              <ArrowLeft className="h-4 w-4" />
              <span>Kembali ke Dashboard</span>
            </button>



        {/* Warning Toast */}
        {warningMessage && (
          <div className="mb-6 bg-amber-950/80 border border-amber-800 text-amber-200 p-4 rounded-xl flex items-start space-x-3 text-xs shadow-lg animate-fadeIn">
            <AlertCircle className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
            <div className="flex-1">
              <span className="font-bold">Info Tautan / Link:</span> {warningMessage}
            </div>
            <button
              onClick={() => setWarningMessage(null)}
              className="text-amber-400 hover:text-white font-bold"
            >
              ✕
            </button>
          </div>
        )}

        {/* Error Toast */}
        {errorMessage && (
          <div className="mb-6 bg-rose-950/80 border border-rose-800 text-rose-200 p-4 rounded-xl flex items-start space-x-3 text-xs shadow-lg animate-fadeIn">
            <AlertCircle className="h-5 w-5 text-rose-400 shrink-0 mt-0.5" />
            <div className="flex-1">
              <span className="font-bold">Gagal Memproses:</span> {errorMessage}
            </div>
            <button
              onClick={() => setErrorMessage(null)}
              className="text-rose-400 hover:text-white font-bold"
            >
              ✕
            </button>
          </div>
        )}

        {/* 1. Main Auto-Run Scraper Bot */}
        <SimpleScraperBot
          onAddVacancy={handleAddVacancy}
          savedVacancies={savedVacancies}
          onSelectVacancy={(v) => {
            setCurrentResult(v);
            window.scrollTo({ top: 400, behavior: 'smooth' });
          }}
        />

        {/* 2. Detailed View for Selected Vacancy */}
        {currentResult && (
          <div className="animate-fadeIn">
            <ResultView
              vacancy={currentResult}
              onSave={handleSaveToggle}
              isSaved={savedVacancies.some((v) => v.id === currentResult.id)}
            />
          </div>
        )}
          </>
        )}

        {page === 'facebook' && (
          <>
            <button
              onClick={() => handleNavigate('dashboard')}
              className="flex items-center space-x-2 px-3 py-2 rounded-xl bg-slate-900 border border-slate-800 hover:border-slate-600 text-xs font-bold text-slate-200 transition-colors mb-6"
            >
              <ArrowLeft className="h-4 w-4" />
              <span>Kembali ke Dashboard</span>
            </button>

           

            {/* Warning Toast */}
            {warningMessage && (
              <div className="mb-6 bg-amber-950/80 border border-amber-800 text-amber-200 p-4 rounded-xl flex items-start space-x-3 text-xs shadow-lg animate-fadeIn">
                <AlertCircle className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
                <div className="flex-1">
                  <span className="font-bold">Info Tautan / Link:</span> {warningMessage}
                </div>
                <button
                  onClick={() => setWarningMessage(null)}
                  className="text-amber-400 hover:text-white font-bold"
                >
                  ✕
                </button>
              </div>
            )}

            {/* Error Toast */}
            {errorMessage && (
              <div className="mb-6 bg-rose-950/80 border border-rose-800 text-rose-200 p-4 rounded-xl flex items-start space-x-3 text-xs shadow-lg animate-fadeIn">
                <AlertCircle className="h-5 w-5 text-rose-400 shrink-0 mt-0.5" />
                <div className="flex-1">
                  <span className="font-bold">Gagal Memproses:</span> {errorMessage}
                </div>
                <button
                  onClick={() => setErrorMessage(null)}
                  className="text-rose-400 hover:text-white font-bold"
                >
                  ✕
                </button>
              </div>
            )}

            {/* 1. Main Auto-Run Scraper Bot */}
            <FacebookScraperBot
              onAddVacancy={handleAddVacancy}
              savedVacancies={savedVacancies}
              onSelectVacancy={(v) => {
                setCurrentResult(v);
                window.scrollTo({ top: 400, behavior: 'smooth' });
              }}
            />

            {/* 2. Detailed View for Selected Vacancy */}
            {currentResult && (
              <div className="animate-fadeIn">
                <ResultView
                  vacancy={currentResult}
                  onSave={handleSaveToggle}
                  isSaved={savedVacancies.some((v) => v.id === currentResult.id)}
                />
              </div>
            )}
          </>
        )}

        {page === 'twitter' && (
          <>
            <button
              onClick={() => handleNavigate('dashboard')}
              className="flex items-center space-x-2 px-3 py-2 rounded-xl bg-slate-900 border border-slate-800 hover:border-slate-600 text-xs font-bold text-slate-200 transition-colors mb-6"
            >
              <ArrowLeft className="h-4 w-4" />
              <span>Kembali ke Dashboard</span>
            </button>

            {/* Warning Toast */}
            {warningMessage && (
              <div className="mb-6 bg-amber-950/80 border border-amber-800 text-amber-200 p-4 rounded-xl flex items-start space-x-3 text-xs shadow-lg animate-fadeIn">
                <AlertCircle className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
                <div className="flex-1">
                  <span className="font-bold">Info Tautan / Link:</span> {warningMessage}
                </div>
                <button
                  onClick={() => setWarningMessage(null)}
                  className="text-amber-400 hover:text-white font-bold"
                >
                  ✕
                </button>
              </div>
            )}

            {/* Error Toast */}
            {errorMessage && (
              <div className="mb-6 bg-rose-950/80 border border-rose-800 text-rose-200 p-4 rounded-xl flex items-start space-x-3 text-xs shadow-lg animate-fadeIn">
                <AlertCircle className="h-5 w-5 text-rose-400 shrink-0 mt-0.5" />
                <div className="flex-1">
                  <span className="font-bold">Gagal Memproses:</span> {errorMessage}
                </div>
                <button
                  onClick={() => setErrorMessage(null)}
                  className="text-rose-400 hover:text-white font-bold"
                >
                  ✕
                </button>
              </div>
            )}

            {/* 1. Main Auto-Run Scraper Bot (Twitter/X) */}
            <TwitterScraperBot
              onAddVacancy={handleAddVacancy}
              savedVacancies={savedVacancies}
              onSelectVacancy={(v) => {
                setCurrentResult(v);
                window.scrollTo({ top: 400, behavior: 'smooth' });
              }}
            />

            {/* 2. Detailed View for Selected Vacancy */}
            {currentResult && (
              <div className="animate-fadeIn">
                <ResultView
                  vacancy={currentResult}
                  onSave={handleSaveToggle}
                  isSaved={savedVacancies.some((v) => v.id === currentResult.id)}
                />
              </div>
            )}
          </>
        )}

        {page === 'threads' && (
          <>
            <button
              onClick={() => handleNavigate('dashboard')}
              className="flex items-center space-x-2 px-3 py-2 rounded-xl bg-slate-900 border border-slate-800 hover:border-slate-600 text-xs font-bold text-slate-200 transition-colors mb-6"
            >
              <ArrowLeft className="h-4 w-4" />
              <span>Kembali ke Dashboard</span>
            </button>

            {/* Warning Toast */}
            {warningMessage && (
              <div className="mb-6 bg-amber-950/80 border border-amber-800 text-amber-200 p-4 rounded-xl flex items-start space-x-3 text-xs shadow-lg animate-fadeIn">
                <AlertCircle className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
                <div className="flex-1">
                  <span className="font-bold">Info Tautan / Link:</span> {warningMessage}
                </div>
                <button
                  onClick={() => setWarningMessage(null)}
                  className="text-amber-400 hover:text-white font-bold"
                >
                  ✕
                </button>
              </div>
            )}

            {/* Error Toast */}
            {errorMessage && (
              <div className="mb-6 bg-rose-950/80 border border-rose-800 text-rose-200 p-4 rounded-xl flex items-start space-x-3 text-xs shadow-lg animate-fadeIn">
                <AlertCircle className="h-5 w-5 text-rose-400 shrink-0 mt-0.5" />
                <div className="flex-1">
                  <span className="font-bold">Gagal Memproses:</span> {errorMessage}
                </div>
                <button
                  onClick={() => setErrorMessage(null)}
                  className="text-rose-400 hover:text-white font-bold"
                >
                  ✕
                </button>
              </div>
            )}

            {/* 1. Main Auto-Run Scraper Bot (Threads) */}
            <ThreadsScraperBot
              onAddVacancy={handleAddVacancy}
              savedVacancies={savedVacancies}
              onSelectVacancy={(v) => {
                setCurrentResult(v);
                window.scrollTo({ top: 400, behavior: 'smooth' });
              }}
            />

            {/* 2. Detailed View for Selected Vacancy */}
            {currentResult && (
              <div className="animate-fadeIn">
                <ResultView
                  vacancy={currentResult}
                  onSave={handleSaveToggle}
                  isSaved={savedVacancies.some((v) => v.id === currentResult.id)}
                />
              </div>
            )}
          </>
        )}
      </main>

      {/* How to Use Modal */}
      <HowToUseModal isOpen={isGuideOpen} onClose={() => setIsGuideOpen(false)} />

      {/* Footer */}
      <footer className="border-t border-slate-800 bg-slate-900/50 py-6 text-center text-xs text-slate-500 mt-auto">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-3">
          <p>
            © {new Date().getFullYear()} By Akarindo.
          </p>
         
        </div>
      </footer>
    </div>
  );
}
