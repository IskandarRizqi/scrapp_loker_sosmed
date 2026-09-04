import React from 'react';
import { X, Instagram, Facebook, FileDown, Sparkles, AlertCircle, CheckCircle2 } from 'lucide-react';

interface HowToUseModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const HowToUseModal: React.FC<HowToUseModalProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-fadeIn">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-2xl w-full p-6 text-slate-100 shadow-2xl relative max-h-[90vh] overflow-y-auto">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="flex items-center space-x-2 mb-4">
          <div className="p-2 rounded-xl bg-blue-500/20 text-blue-400">
            <Sparkles className="h-5 w-5" />
          </div>
          <h3 className="text-lg font-bold text-white">Panduan Penggunaan LokerDetector AI</h3>
        </div>

        <div className="space-y-5 text-xs text-slate-300 leading-relaxed">
          {/* Section 1: Instagram Sorotan (Highlights) */}
          <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-2">
            <h4 className="font-bold text-pink-400 flex items-center space-x-1.5 text-sm">
              <Instagram className="h-4 w-4" />
              <span>1. Cara Mendeteksi Loker di Sorotan (Highlights) Instagram</span>
            </h4>
            <p>
              Sorotan (Highlights) profil Instagram orang lain/perusahaan sering berisi poster lowongan kerja.
            </p>
            <ol className="list-decimal pl-5 space-y-1 text-slate-300">
              <li>
                <b>Langkah Terbaik:</b> Buka sorotan Instagram target, screenshot (tangkap layar) poster loker tersebut.
              </li>
              <li>
                Unggah file screenshot ke kolom <b>"Unggah Tangkapan Layar (Screenshot)"</b> pada LokerDetector. Anda bisa mengunggah beberapa screenshot sekaligus!
              </li>
              <li>
                Atau salin teks bio / caption sorotan dan masukkan ke kolom <b>URL & Teks</b>.
              </li>
            </ol>
          </div>

          {/* Section 2: Facebook Groups & Posts */}
          <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-2">
            <h4 className="font-bold text-blue-400 flex items-center space-x-1.5 text-sm">
              <Facebook className="h-4 w-4" />
              <span>2. Cara Mendeteksi Loker di Grup Facebook</span>
            </h4>
            <p>
              Di Facebook, informasi loker biasanya disebar dalam bentuk poster flyer atau teks panjang di grup info loker. Kartu Facebook memakai otomasi browser:
            </p>
            <ol className="list-decimal pl-5 space-y-1 text-slate-300">
              <li>
                Klik <b>"Login ke Facebook"</b> sekali — jendela browser terbuka untuk login akun Anda (termasuk 2FA/CAPTCHA). Sesi disimpan otomatis.
              </li>
              <li>
                Salin (copy) <b>link grup</b> dari Facebook, lalu tempel di kolom "Link Grup Facebook".
              </li>
              <li>
                Pilih <b>rentang hari ke belakang</b>, lalu jalankan bot. Sistem menggulir feed grup otomatis, membaca teks & gambar poster (OCR AI), lalu menampilkan hasil yang bisa di-export ke Excel.
              </li>
              <li>
                Alternatif: tempel tautan postingan / upload screenshot flyer pada bagian "Pindai Manual".
              </li>
            </ol>
          </div>

          {/* Section 3: Excel Export */}
          <div className="bg-slate-950 p-4 rounded-xl border border-slate-800 space-y-2">
            <h4 className="font-bold text-emerald-400 flex items-center space-x-1.5 text-sm">
              <FileDown className="h-4 w-4" />
              <span>3. Mengunduh Laporan dalam Format Excel (.XLSX)</span>
            </h4>
            <p>
              Setiap kali loker terdeteksi, Anda dapat menekan tombol <b>"Export Excel"</b> untuk mengunduh laporan berformat Excel (.xlsx) dengan 1 baris per perusahaan — lengkap dengan posisi, lokasi, gaji, deadline, dan tautan kontak pendaftaran yang rapi dan siap diolah.
            </p>
          </div>

          <div className="bg-blue-950/40 border border-blue-800/60 p-3.5 rounded-xl flex items-start space-x-3 text-blue-200">
            <AlertCircle className="h-5 w-5 text-blue-400 shrink-0 mt-0.5" />
            <p className="text-[11px]">
              <b>Tips:</b> Karena Instagram & Facebook membatasi akses pengikisan otomatis di balik login wall, pengunggahan screenshot poster/sorotan menghasilkan akurasi OCR hingga 99%!
            </p>
          </div>
        </div>

        <div className="mt-6 pt-4 border-t border-slate-800 text-right">
          <button
            onClick={onClose}
            className="px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs transition-colors"
          >
            Mengerti & Mulai Gunakan
          </button>
        </div>
      </div>
    </div>
  );
};
