import React, { useState } from 'react';
import {
  CheckCircle2,
  XCircle,
  FileDown,
  Copy,
  Check,
  Building2,
  Briefcase,
  MapPin,
  CircleDollarSign,
  Calendar,
  Mail,
  Phone,
  Globe,
  Instagram,
  FileText,
  Sparkles,
  Share2,
  BookmarkPlus,
  BookmarkCheck,
  ExternalLink,
} from 'lucide-react';
import { JobVacancy } from '../types';
import { positionTitles } from '../utils/positions';

interface ResultViewProps {
  vacancy: JobVacancy;
  onSave: (vacancy: JobVacancy) => void;
  isSaved: boolean;
}

export const ResultView: React.FC<ResultViewProps> = ({ vacancy, onSave, isSaved }) => {
  const [activeTab, setActiveTab] = useState<'detail' | 'ocr' | 'images'>('detail');
  const [copied, setCopied] = useState(false);

  const handleExportSingle = async () => {
    const { exportVacanciesToExcel } = await import('../utils/excelExporter');
    await exportVacanciesToExcel([vacancy], `Laporan_Loker_${vacancy.companyName || 'Sosmed'}`);
  };

  const handleCopySummary = () => {
    const summaryText = `📌 *INFORMASI LOKER TERDETEKSI*
🏢 *Perusahaan:* ${vacancy.companyName || '-'}
💼 *Posisi:* ${positionTitles(vacancy)}
📍 *Lokasi:* ${vacancy.workLocation || '-'}
💰 *Gaji:* ${vacancy.salaryInfo || '-'}
⏳ *Batas Akhir:* ${vacancy.deadline || '-'}

📋 *Kualifikasi Utama:*
${vacancy.requirements.map((r) => `• ${r}`).join('\n')}

📩 *Cara Melamar:*
${vacancy.howToApply}
${vacancy.contactInfo.email ? `Email: ${vacancy.contactInfo.email}` : ''}
${vacancy.contactInfo.phoneWhatsapp ? `WA: ${vacancy.contactInfo.phoneWhatsapp}` : ''}
${vacancy.contactInfo.websiteForm ? `Form: ${vacancy.contactInfo.websiteForm}` : ''}

_Di-scan via LokerDetector AI_`;

    navigator.clipboard.writeText(summaryText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const isLoker = vacancy.isVacancy;

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden text-slate-100 mb-8 transition-all">
      {/* Top Banner Status */}
      <div
        className={`p-4 sm:p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 border-b ${
          isLoker
            ? 'bg-emerald-950/60 border-emerald-800/80 text-emerald-200'
            : 'bg-rose-950/60 border-rose-800/80 text-rose-200'
        }`}
      >
        <div className="flex items-center space-x-3">
          <div
            className={`p-2.5 rounded-xl ${
              isLoker ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'
            }`}
          >
            {isLoker ? <CheckCircle2 className="h-6 w-6" /> : <XCircle className="h-6 w-6" />}
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <h3 className="text-base font-bold">
                {isLoker ? 'LOKER TERDETEKSI' : 'BUKAN LOKER / INVALID'}
              </h3>
              <span className="text-xs px-2 py-0.5 rounded-full bg-slate-900/60 border border-current font-semibold">
                Skor Akurasi: {vacancy.confidenceScore}%
              </span>
            </div>
            <p className="text-xs opacity-90 mt-0.5">{vacancy.detectionReason}</p>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center space-x-2 w-full sm:w-auto justify-end">
          <button
            onClick={() => onSave(vacancy)}
            className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all border ${
              isSaved
                ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                : 'bg-slate-800 border-slate-700 hover:bg-slate-700 text-slate-200'
            }`}
          >
            {isSaved ? <BookmarkCheck className="h-4 w-4" /> : <BookmarkPlus className="h-4 w-4" />}
            <span>{isSaved ? 'Tersimpan' : 'Simpan'}</span>
          </button>

          
        </div>
      </div>

      {/* Main Content Body */}
      {isLoker ? (
        <div className="p-5 sm:p-6 space-y-6">
          {/* Quick Metrics Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="bg-slate-950 p-3.5 rounded-xl border border-slate-800 flex items-start space-x-3">
              <Building2 className="h-5 w-5 text-blue-400 mt-0.5 shrink-0" />
              <div>
                <p className="text-[11px] text-slate-400 uppercase font-semibold tracking-wider">Perusahaan</p>
                <p className="text-sm font-bold text-slate-100">{vacancy.companyName || '-'}</p>
              </div>
            </div>

            <div className="bg-slate-950 p-3.5 rounded-xl border border-slate-800 flex items-start space-x-3">
              <Briefcase className="h-5 w-5 text-indigo-400 mt-0.5 shrink-0" />
              <div>
                <p className="text-[11px] text-slate-400 uppercase font-semibold tracking-wider">Posisi / Jabatan</p>
                <p className="text-sm font-bold text-slate-100">{positionTitles(vacancy)}</p>
              </div>
            </div>

            <div className="bg-slate-950 p-3.5 rounded-xl border border-slate-800 flex items-start space-x-3">
              <CircleDollarSign className="h-5 w-5 text-emerald-400 mt-0.5 shrink-0" />
              <div>
                <p className="text-[11px] text-slate-400 uppercase font-semibold tracking-wider">Estimasi Gaji</p>
                <p className="text-sm font-bold text-emerald-400">{vacancy.salaryInfo || '-'}</p>
              </div>
            </div>

            <div className="bg-slate-950 p-3.5 rounded-xl border border-slate-800 flex items-start space-x-3">
              <Calendar className="h-5 w-5 text-rose-400 mt-0.5 shrink-0" />
              <div>
                <p className="text-[11px] text-slate-400 uppercase font-semibold tracking-wider">Batas Akhir</p>
                <p className="text-sm font-bold text-rose-400">{vacancy.deadline || '-'}</p>
              </div>
            </div>
          </div>

          {/* Direct Post Link Banner */}
          {vacancy.sourceUrl && (
            <div className="bg-slate-950 p-3.5 rounded-xl border border-slate-800 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs">
              <div className="flex items-center space-x-2 text-slate-300 truncate max-w-full">
                <Globe className="h-4 w-4 text-blue-400 shrink-0" />
                <span className="font-semibold text-slate-400 shrink-0">Link Postingan Asli:</span>
                <span className="font-mono text-blue-300 truncate underline">{vacancy.sourceUrl}</span>
              </div>
              <a
                href={vacancy.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="px-3.5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-bold flex items-center space-x-1.5 shrink-0 transition-colors shadow-md"
              >
                <span>Buka Postingan {vacancy.platform}</span>
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </div>
          )}

          {/* Navigation Tabs */}
          <div className="border-b border-slate-800 flex space-x-6 text-xs font-semibold">
            <button
              onClick={() => setActiveTab('detail')}
              className={`pb-2.5 border-b-2 transition-all ${
                activeTab === 'detail'
                  ? 'border-blue-500 text-blue-400'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              Detail Lowongan & Kontak
            </button>
            <button
              onClick={() => setActiveTab('ocr')}
              className={`pb-2.5 border-b-2 transition-all ${
                activeTab === 'ocr'
                  ? 'border-blue-500 text-blue-400'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              Transkrip Teks OCR ({vacancy.rawOcrText ? vacancy.rawOcrText.length : 0} Karakter)
            </button>
            {vacancy.images && vacancy.images.length > 0 && (
              <button
                onClick={() => setActiveTab('images')}
                className={`pb-2.5 border-b-2 transition-all ${
                  activeTab === 'images'
                    ? 'border-blue-500 text-blue-400'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                Poster / Gambar ({vacancy.images.length})
              </button>
            )}
          </div>

          {/* Tab 1: Detail & Contact */}
          {activeTab === 'detail' && (
            <div className="space-y-6">
              {/* Executive Summary Callout */}
              <div className="bg-slate-950/80 border-l-4 border-blue-500 p-4 rounded-r-xl">
                <p className="text-xs font-semibold text-blue-400 uppercase tracking-wide">Ringkasan Eksekutif AI:</p>
                <p className="text-xs text-slate-200 mt-1 leading-relaxed">{vacancy.summary}</p>
              </div>

              {/* Requirements & Responsibilities */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Requirements */}
                <div className="bg-slate-950 p-4 rounded-xl border border-slate-800">
                  <h4 className="text-xs font-bold text-slate-200 uppercase tracking-wider mb-3 flex items-center space-x-2">
                    <span className="h-2 w-2 rounded-full bg-blue-500"></span>
                    <span>Persyaratan & Kualifikasi Pelamar</span>
                  </h4>
                  {vacancy.requirements && vacancy.requirements.length > 0 ? (
                    <ul className="space-y-2 text-xs text-slate-300">
                      {vacancy.requirements.map((req, i) => (
                        <li key={i} className="flex items-start space-x-2">
                          <span className="text-blue-400 font-bold">•</span>
                          <span>{req}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-slate-500 italic">Tidak ada rincian kualifikasi khusus.</p>
                  )}
                </div>

                {/* Responsibilities */}
                <div className="bg-slate-950 p-4 rounded-xl border border-slate-800">
                  <h4 className="text-xs font-bold text-slate-200 uppercase tracking-wider mb-3 flex items-center space-x-2">
                    <span className="h-2 w-2 rounded-full bg-indigo-500"></span>
                    <span>Tanggung Jawab Pekerjaan</span>
                  </h4>
                  {vacancy.responsibilities && vacancy.responsibilities.length > 0 ? (
                    <ul className="space-y-2 text-xs text-slate-300">
                      {vacancy.responsibilities.map((resp, i) => (
                        <li key={i} className="flex items-start space-x-2">
                          <span className="text-indigo-400 font-bold">•</span>
                          <span>{resp}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-slate-500 italic">
                      Lihat rincian tugas pada poster atau instruksi HRD.
                    </p>
                  )}
                </div>
              </div>

              {/* Contact & How to Apply Box */}
              <div className="bg-gradient-to-r from-slate-950 via-slate-900 to-slate-950 p-4 rounded-xl border border-emerald-800/50">
                <h4 className="text-xs font-bold text-emerald-400 uppercase tracking-wider mb-2 flex items-center space-x-2">
                  <Mail className="h-4 w-4 text-emerald-400" />
                  <span>Petunjuk Pendaftaran & Kontak HRD</span>
                </h4>
                <p className="text-xs text-slate-300 mb-4">{vacancy.howToApply}</p>

                <div className="flex flex-wrap gap-2.5">
                  {vacancy.contactInfo.email && (
                    <a
                      href={`mailto:${vacancy.contactInfo.email}`}
                      className="inline-flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-emerald-950/80 border border-emerald-800 text-xs font-semibold text-emerald-300 hover:bg-emerald-900/80 transition-colors"
                    >
                      <Mail className="h-3.5 w-3.5" />
                      <span>Email: {vacancy.contactInfo.email}</span>
                    </a>
                  )}

                  {vacancy.contactInfo.phoneWhatsapp && (
                    <a
                      href={`https://wa.me/${vacancy.contactInfo.phoneWhatsapp.replace(/[^0-9]/g, '')}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-emerald-950/80 border border-emerald-800 text-xs font-semibold text-emerald-300 hover:bg-emerald-900/80 transition-colors"
                    >
                      <Phone className="h-3.5 w-3.5" />
                      <span>WA/Telp: {vacancy.contactInfo.phoneWhatsapp}</span>
                      <ExternalLink className="h-3 w-3 opacity-60" />
                    </a>
                  )}

                  {vacancy.contactInfo.websiteForm && (
                    <a
                      href={vacancy.contactInfo.websiteForm}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-blue-950/80 border border-blue-800 text-xs font-semibold text-blue-300 hover:bg-blue-900/80 transition-colors"
                    >
                      <Globe className="h-3.5 w-3.5" />
                      <span>Form Pendaftaran</span>
                      <ExternalLink className="h-3 w-3 opacity-60" />
                    </a>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Tab 2: OCR Text */}
          {activeTab === 'ocr' && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-slate-400 font-semibold">Teks Lengkap Hasil OCR Gemini:</span>
                <button
                  onClick={handleCopySummary}
                  className="flex items-center space-x-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  <span>{copied ? 'Tersalin!' : 'Salin Teks'}</span>
                </button>
              </div>
              <textarea
                readOnly
                rows={10}
                value={vacancy.rawOcrText}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3.5 text-xs font-mono text-slate-300 focus:outline-none"
              />
            </div>
          )}

          {/* Tab 3: Images */}
          {activeTab === 'images' && vacancy.images && (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
              {vacancy.images.map((img, i) => (
                <div key={i} className="rounded-xl overflow-hidden border border-slate-800 bg-slate-950">
                  <img src={img} alt={`Poster ${i + 1}`} className="w-full h-auto object-contain max-h-80" />
                </div>
              ))}
            </div>
          )}

          {/* Footer Bar */}
          <div className="pt-4 border-t border-slate-800 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-slate-400">
            <div>
              Sumber: <span className="font-semibold text-slate-300">{vacancy.platform}</span> ({vacancy.sourceContext})
            </div>
            <button
              onClick={handleCopySummary}
              className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors"
            >
              {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
              <span>{copied ? 'Ringkasan Tersalin!' : 'Salin Ringkasan Text'}</span>
            </button>
          </div>
        </div>
      ) : (
        /* Invalid / Not A Job Vacancy Body */
        <div className="p-6 text-center space-y-4">
          <div className="h-12 w-12 rounded-full bg-rose-500/10 text-rose-400 flex items-center justify-center mx-auto">
            <XCircle className="h-6 w-6" />
          </div>
          <div>
            <h4 className="text-base font-bold text-slate-200">Konten Ini Bukan Lowongan Kerja</h4>
            <p className="text-xs text-slate-400 mt-1 max-w-md mx-auto">
              AI tidak menemukan elemen seperti posisi jabatan, kualifikasi, atau kontak pendaftaran pada unggahan/gambar ini.
            </p>
          </div>

          {vacancy.rawOcrText && (
            <div className="mt-4 text-left max-w-xl mx-auto bg-slate-950 p-3 rounded-xl border border-slate-800">
              <p className="text-[11px] font-semibold text-slate-400 mb-1">Teks Terbaca Dari Gambar:</p>
              <p className="text-xs text-slate-300 font-mono line-clamp-4">{vacancy.rawOcrText}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
