const MONTHS: Record<string, number> = {
  januari: 1, februari: 2, maret: 3, april: 4, mei: 5, juni: 6,
  juli: 7, agustus: 8, september: 9, oktober: 10, november: 11, desember: 12,
  january: 1, february: 2, march: 3, may: 5, june: 6, july: 7,
  august: 8, october: 10, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7,
  aug: 8, agu: 8, sep: 9, sept: 9, okt: 10, oct: 10, nov: 11, dec: 12, des: 12,
};

const MONTH_RE =
  '(?:januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember|january|february|march|may|june|july|august|october|december|jan|feb|mar|apr|jun|jul|aug|agu|sep|sept|okt|oct|nov|dec|des)';

const SHORT_MONTH_ID = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

function toValidDate(year: number, month: number, day: number): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(year, month - 1, day);
  if (isNaN(date.getTime())) return null;
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

export function parseDeadline(text: string | null | undefined): Date | null {
  if (!text) return null;
  const t = text.toLowerCase().trim();
  if (!t) return null;

  let m: RegExpMatchArray | null;

  m = t.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return toValidDate(+m[1], +m[2], +m[3]);

  m = t.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (m) {
    let day = +m[1];
    let month = +m[2];
    if (month > 12 && day <= 12) {
      const tmp = day;
      day = month;
      month = tmp;
    }
    return toValidDate(+m[3], month, day);
  }

  m = t.match(new RegExp(`(\\d{1,2})\\s+(${MONTH_RE})\\s+(\\d{4})`));
  if (m) return toValidDate(+m[3], MONTHS[m[2]], +m[1]);

  m = t.match(new RegExp(`(\\d{1,2})\\s+(${MONTH_RE})\\b`));
  if (m) return toValidDate(new Date().getFullYear(), MONTHS[m[2]], +m[1]);

  m = t.match(new RegExp(`(${MONTH_RE})\\s+(\\d{4})`));
  if (m) {
    const month = MONTHS[m[1]];
    const year = +m[2];
    return toValidDate(year, month, new Date(year, month, 0).getDate());
  }

  return null;
}

export function isDeadlineExpired(deadline: string | null | undefined, now: Date = new Date()): boolean {
  const parsed = parseDeadline(deadline);
  if (!parsed) return false;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
  return end < today;
}

export function formatDateLabel(value: string | Date | null | undefined): string {
  if (!value) return '';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (isNaN(d.getTime())) return typeof value === 'string' ? value : '';
  return `${d.getDate()} ${SHORT_MONTH_ID[d.getMonth() + 1]} ${d.getFullYear()}`;
}

export function parseRelativeDate(text: string | null | undefined): string | null {
  if (!text) return null;
  const t = text.toLowerCase().trim();
  const now = new Date();
  
  // Match "X hari lalu" / "X days ago" / "X jam lalu" / "X hours ago" / "X menit lalu" / "X minutes ago"
  const relativeMatch = t.match(/(\d+)\s*(hari|days?|jam|hours?|menit|minutes?|detik|seconds?|minggu|weeks?|bulan|months?)\s*(yang\s*lalu|lalu|ago)?/i);
  if (relativeMatch) {
    const amount = parseInt(relativeMatch[1], 10);
    const unit = relativeMatch[2].toLowerCase();
    
    if (/^(hari|days?)$/.test(unit)) {
      now.setDate(now.getDate() - amount);
    } else if (/^(jam|hours?)$/.test(unit)) {
      now.setHours(now.getHours() - amount);
    } else if (/^(menit|minutes?)$/.test(unit)) {
      now.setMinutes(now.getMinutes() - amount);
    } else if (/^(detik|seconds?)$/.test(unit)) {
      now.setSeconds(now.getSeconds() - amount);
    } else if (/^(minggu|weeks?)$/.test(unit)) {
      now.setDate(now.getDate() - (amount * 7));
    } else if (/^(bulan|months?)$/.test(unit)) {
      now.setMonth(now.getMonth() - amount);
    }
    return now.toISOString();
  }
  
  // Match "Hari ini" / "Today"
  if (/^(hari\s*ini|today)$/i.test(t)) {
    return now.toISOString();
  }
  
  // Match "Kemarin" / "Yesterday"
  if (/^(kemarin|yesterday)$/i.test(t)) {
    now.setDate(now.getDate() - 1);
    return now.toISOString();
  }
  
  return null;
}

export function parseDiscoveryDate(text: string | null | undefined): string | null {
  if (!text) return null;

  const monthFirst = text.match(new RegExp(`(${MONTH_RE})\\s+(\\d{1,2}),?\\s+(\\d{4})`));
  if (monthFirst) {
    const d = toValidDate(+monthFirst[3], MONTHS[monthFirst[1]], +monthFirst[2]);
    return d ? d.toISOString() : null;
  }

  const dayFirst = text.match(new RegExp(`(\\d{1,2})\\s+(${MONTH_RE})\\s+(\\d{4})`));
  if (dayFirst) {
    const d = toValidDate(+dayFirst[3], MONTHS[dayFirst[2]], +dayFirst[1]);
    return d ? d.toISOString() : null;
  }

  // Try relative date parsing first (e.g., "1 hari lalu", "2 days ago")
  const relativeResult = parseRelativeDate(text);
  if (relativeResult) return relativeResult;

  const d = new Date(text);
  if (!isNaN(d.getTime()) && d.getFullYear() > 2000) return d.toISOString();
  return null;
}
