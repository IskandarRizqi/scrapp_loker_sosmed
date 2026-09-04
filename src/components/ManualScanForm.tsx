import React, { useState } from 'react';
import { ScanRequestPayload } from '../types';

interface ManualScanFormProps {
  onScan: (payload: ScanRequestPayload) => void;
  isLoading: boolean;
  progress?: string;
  sourceType?: string;
}

/**
 * Reusable manual-scan form (URL / multiple screenshot upload / text caption).
 * Used both in the Instagram bot accordion and the dedicated "Gambar OCR" page.
 */
export const ManualScanForm: React.FC<ManualScanFormProps> = ({ onScan, isLoading, progress, sourceType }) => {
  const [manualUrl, setManualUrl] = useState('');
  const [manualText, setManualText] = useState('');
  const [manualImages, setManualImages] = useState<string[]>([]);

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    Array.from(files).forEach((file: File) => {
      const reader = new FileReader();
      reader.onload = (evt) => {
        if (evt.target?.result) {
          setManualImages((prev) => [...prev, evt.target!.result as string]);
        }
      };
      reader.readAsDataURL(file);
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualUrl.trim() && !manualText.trim() && manualImages.length === 0) {
      alert('Masukkan link postingan, teks caption, atau screenshot gambar poster!');
      return;
    }
    onScan({
      url: manualUrl.trim() || undefined,
      text: manualText.trim() || undefined,
      images: manualImages.length > 0 ? manualImages : undefined,
      sourceType: sourceType || undefined,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-xs font-semibold text-slate-300 mb-1">Link URL Postingan IG / FB</label>
        <input
          type="url"
          value={manualUrl}
          onChange={(e) => setManualUrl(e.target.value)}
          placeholder="https://instagram.com/p/... atau https://facebook.com/..."
          className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3.5 py-2 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <div>
        <label className="block text-xs font-semibold text-slate-300 mb-1">
          Upload Screenshot Poster / Sorotan IG FB
        </label>
        <input
          type="file"
          accept="image/*"
          multiple
          onChange={handleImageUpload}
          className="block w-full text-xs text-slate-400 file:mr-4 file:py-2 file:px-4 file:rounded-xl file:border-0 file:text-xs file:font-semibold file:bg-blue-600 file:text-white hover:file:bg-blue-500"
        />
        {manualImages.length > 0 && (
          <p className="text-[11px] text-emerald-400 mt-1">
            {manualImages.length} gambar screenshot diunggah — setiap foto dianalisis terpisah menjadi 1 baris hasil.
          </p>
        )}
      </div>

      <div>
        <label className="block text-xs font-semibold text-slate-300 mb-1">Teks Caption / Salinan Postingan</label>
        <textarea
          rows={3}
          value={manualText}
          onChange={(e) => setManualText(e.target.value)}
          placeholder="Tempel teks caption postingan di sini..."
          className="w-full bg-slate-950 border border-slate-700 rounded-xl p-3 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <button
        type="submit"
        disabled={isLoading}
        className="w-full sm:w-auto px-6 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs shadow transition-all disabled:opacity-50"
      >
        {isLoading ? `${progress || 'Menganalisis Teks & Gambar'}...` : 'Pindai Sekarang'}
      </button>
    </form>
  );
};
