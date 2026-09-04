import React from 'react';
import {
  Instagram,
  Facebook,
  MessageCircle,
  Twitter,
  ScanLine,
  ArrowRight,
  LayoutDashboard,
  Sparkles,
  HelpCircle,
  Trash2,
} from 'lucide-react';

export type DashboardPage = 'instagram' | 'facebook' | 'twitter' | 'threads' | 'ocr';

interface DashboardProps {
  onNavigate: (page: DashboardPage) => void;
  savedCount: number;
  onOpenGuide: () => void;
  onClearHistory: () => void;
}

interface CardDef {
  id: DashboardPage | 'coming-soon';
  title: string;
  desc: string;
  icon: React.ReactNode;
  iconBg: string;
  border: string;
  active?: boolean;
}

export const Dashboard: React.FC<DashboardProps> = ({ onNavigate, savedCount, onOpenGuide, onClearHistory }) => {
  const cards: CardDef[] = [
    {
      id: 'instagram',
      title: 'Instagram',
      desc: 'Scraper auto-run feed & sorotan IG, lengkap dengan pindai manual.',
      icon: <Instagram className="h-7 w-7" />,
      iconBg: 'bg-gradient-to-tr from-pink-600 to-orange-500',
      border: 'hover:border-pink-500/60',
      active: true,
    },
    {
      id: 'ocr',
      title: 'Gambar OCR',
      desc: 'Upload beberapa screenshot poster sekaligus — setiap foto menjadi 1 baris hasil.',
      icon: <ScanLine className="h-7 w-7" />,
      iconBg: 'bg-gradient-to-tr from-indigo-600 to-violet-500',
      border: 'hover:border-indigo-500/60',
      active: true,
    },
    {
      id: 'facebook',
      title: 'Facebook',
      desc: 'Login sekali, tempel link grup, lalu bot auto-scroll & ambil loker + gambar poster.',
      icon: <Facebook className="h-7 w-7" />,
      iconBg: 'bg-gradient-to-tr from-blue-600 to-sky-500',
      border: 'hover:border-blue-500/60',
      active: true,
    },
    {
      id: 'twitter',
      title: 'Twitter / X',
      desc: 'Login X sekali, tempel link profil/pencarian, lalu bot auto-scroll & ambil loker.',
      icon: <Twitter className="h-7 w-7" />,
      iconBg: 'bg-gradient-to-tr from-slate-800 to-slate-600',
      border: 'hover:border-slate-400/60',
      active: true,
    },
    {
      id: 'threads',
      title: 'Threads',
      desc: 'Scraper auto-run profil Threads BPR/bank/koperasi — ambil loker perbankan tanpa login.',
      icon: <MessageCircle className="h-7 w-7" />,
      iconBg: 'bg-gradient-to-tr from-sky-600 to-indigo-500',
      border: 'hover:border-sky-500/60',
      active: true,
    },
  ];

  return (
    <div className="space-y-6 mb-8">
      {/* Hero */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 sm:p-8 shadow-2xl text-slate-100 relative overflow-hidden">
        <div className="absolute -top-16 -right-16 w-64 h-64 bg-gradient-to-br from-blue-600/30 to-indigo-600/20 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute top-4 right-4 flex items-center space-x-2 z-10">
          <button
            onClick={onOpenGuide}
            className="flex items-center space-x-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors border border-slate-700"
            title="Cara Kerja & Panduan"
          >
            <HelpCircle className="h-4 w-4 text-amber-400" />
            <span className="hidden sm:inline">Panduan</span>
          </button>
          {savedCount > 0 && (
            <button
              onClick={onClearHistory}
              className="p-1.5 text-slate-400 hover:text-red-400 rounded-lg hover:bg-slate-800 transition-colors border border-slate-800"
              title="Hapus riwayat simpanan"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="relative flex flex-col sm:flex-row sm:items-center gap-5">
          <div className="h-16 w-16 rounded-2xl bg-gradient-to-tr from-blue-600 via-indigo-600 to-purple-600 flex items-center justify-center shadow-lg shadow-blue-500/30 ring-1 ring-white/20">
            <LayoutDashboard className="h-8 w-8 text-white" />
          </div>
          <div>
            <h2 className="text-xl sm:text-2xl font-bold text-white flex items-center space-x-2">
              <span>Dashboard Scrap Sosmed Loker </span>
              <Sparkles className="h-5 w-5 text-amber-400" />
            </h2>
            <p className="text-sm text-slate-300 mt-1">
              Pilih platform atau fitur yang ingin digunakan untuk memantau dan mendeteksi lowongan kerja dari media sosial.
            </p>
          </div>
        </div>
      </div>

      {/* Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {cards.map((card) => (
          <div
            key={card.title}
            onClick={() => (card.active ? onNavigate(card.id as DashboardPage) : undefined)}
            className={`relative bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-lg text-slate-100 transition-all ${card.border} ${
              card.active ? 'cursor-pointer hover:bg-slate-800/70 hover:-translate-y-0.5' : 'opacity-70'
            }`}
          >
            {!card.active && (
              <span className="absolute top-4 right-4 px-2 py-0.5 rounded-full bg-slate-800 border border-slate-700 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                Segera hadir
              </span>
            )}
            <div className={`h-14 w-14 rounded-2xl ${card.iconBg} flex items-center justify-center text-white shadow-lg mb-4`}>
              {card.icon}
            </div>
            <h3 className="font-bold text-white text-base">{card.title}</h3>
            <p className="text-xs text-slate-400 mt-1.5 leading-relaxed min-h-[3rem]">{card.desc}</p>
            <div className="mt-3">
              {card.active ? (
                <span className="inline-flex items-center space-x-1.5 text-xs font-bold text-blue-400">
                  <span>Buka</span>
                  <ArrowRight className="h-3.5 w-3.5" />
                </span>
              ) : (
                <span className="inline-flex items-center space-x-1.5 text-xs font-semibold text-slate-500">
                  <span>Nonaktif</span>
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
