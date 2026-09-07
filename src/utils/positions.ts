import { JobPosition, JobVacancy } from '../types';

const nonEmpty = (arr?: string[]) => (arr && arr.length > 0 ? arr : []);

interface WithVacancy {
  vacancyData: JobVacancy;
}

/**
 * Canonical list of positions for a vacancy.
 *
 * - If the vacancy carries an explicit `positions` array (multi-posisi hasil AI),
 *   return it as-is (per-position jobdesk/jobspek/keahlian).
 * - Otherwise synthesize a single position from the legacy aggregate fields
 *   (jobTitle + responsibilities/requirements/skills), keeping backward compatibility
 *   with older saved data.
 */
export function expandPositions(v: JobVacancy): JobPosition[] {
  if (v.positions && v.positions.length > 0) {
    return v.positions.map((p) => ({
      title: p.title || v.jobTitle || 'Posisi',
      summary: p.summary || v.summary,
      responsibilities: nonEmpty(p.responsibilities).length > 0 ? p.responsibilities : v.responsibilities,
      requirements: nonEmpty(p.requirements).length > 0 ? p.requirements : v.requirements,
      skills: nonEmpty(p.skills).length > 0 ? p.skills : v.skills,
    }));
  }
  return [
    {
      title: v.jobTitle || 'Posisi',
      summary: v.summary,
      responsibilities: v.responsibilities,
      requirements: v.requirements,
      skills: v.skills,
    },
  ];
}

/** Gabungkan semua nama posisi menjadi satu string dipisah koma, misal untuk tampilan feed/UI. */
export function positionTitles(v: JobVacancy): string {
  const list = expandPositions(v)
    .map((p) => p.title)
    .filter(Boolean);
  return list.length > 0 ? list.join(', ') : (v.jobTitle || '-');
}

/** Jumlah total posisi/jabatan dari daftar hasil (1 postingan dengan 4 posisi dihitung 4). */
export function countTotalPositions(
  items: Array<JobVacancy | WithVacancy | Record<string, unknown>>
): number {
  return items.reduce((sum, item) => {
    if (!item || typeof item !== 'object') return sum;
    const rec = item as Record<string, unknown>;
    const v = 'vacancyData' in rec ? (rec.vacancyData as JobVacancy) : (rec as unknown as JobVacancy);
    if (!v || typeof v !== 'object') return sum;
    return sum + expandPositions(v).length;
  }, 0);
}
