import React from 'react';
import { ScanLine, ArrowLeft, FileDown } from 'lucide-react';
import { ManualScanForm } from './ManualScanForm';
import { ScanRequestPayload } from '../types';

interface ManualOcrPageProps {
  onScan: (payload: ScanRequestPayload) => void;
  isLoading: boolean;
  progress?: string;
  onBack: () => void;
  onExport: () => void;
  exportCount: number;
}

export const ManualOcrPage: React.FC<ManualOcrPageProps> = ({ onScan, isLoading, progress, onBack, onExport, exportCount }) => {
  return (
    <div className="space-y-6 mb-8">
      {/* Back */}
      <button
        onClick={onBack}
        className="flex items-center space-x-2 px-3 py-2 rounded-xl bg-slate-900 border border-slate-800 hover:border-slate-600 text-xs font-bold text-slate-200 transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        <span>Kembali ke Dashboard</span>
      </button>

      {/* Page header */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 sm:p-7 shadow-2xl text-slate-100">
        <div className="flex flex-col sm:flex-row sm:items-center gap-4 justify-between">
          <div className="flex items-center gap-4">
            <div className="h-14 w-14 rounded-2xl bg-gradient-to-tr from-indigo-600 to-violet-500 flex items-center justify-center shadow-lg shadow-indigo-500/25">
              <ScanLine className="h-7 w-7 text-white" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-white">Pindai Gambar / Screenshot (OCR)</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Upload beberapa screenshot poster lowongan sekaligus — setiap foto dianalisis terpisah dan menjadi 1 baris hasil.
              </p>
            </div>
          </div>
          <button
            onClick={onExport}
            disabled={exportCount === 0}
            title={exportCount === 0 ? 'Belum ada hasil yang diproses' : 'Download hasil yang telah diproses dalam format Excel (.XLSX)'}
            className={`flex items-center justify-center space-x-2 px-4 py-2.5 text-xs font-semibold rounded-xl transition-all shadow-md shrink-0 ${
              exportCount === 0
                ? 'bg-slate-800 text-slate-500 cursor-not-allowed border border-slate-800'
                : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-900/30 ring-1 ring-emerald-400/30'
            }`}
          >
            <FileDown className="h-4 w-4" />
            <span>Export ({exportCount}) ke Excel</span>
          </button>
        </div>
      </div>

      {/* Manual form */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 sm:p-7 shadow-lg text-slate-100">
        <ManualScanForm onScan={onScan} isLoading={isLoading} progress={progress} />
      </div>

   
    </div>
  );
};
