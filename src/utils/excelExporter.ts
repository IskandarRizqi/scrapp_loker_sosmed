import * as ExcelJSNS from 'exceljs';
// exceljs adalah modul CommonJS. Saat dijalankan di browser (vite) `import *` memberi
// objek dengan properti langsung; di Node ESM/tsx `import *` memberi namespace dengan
// constructor di `.default`. Fallback ini membuat `ExcelJS.Workbook` berfungsi di BOTH.
const ExcelJS = (ExcelJSNS as any).default ?? ExcelJSNS;
import { JobVacancy } from '../types';

// Layout: Logo di depan nama perusahaan, email tepat di sebelahnya, alamat admin + fisik
// terpisah, dan kolom AI (ringkasan / jobdesk / jobspek / keahlian) di urutan yang diminta user.
const HEADERS = [
  'No',
  'Logo',
  'Perusahaan / Instansi',
  'Email HRD',
  'Alamat',
  'Alamat Fisik',
  'Gaji',
  'Posisi',
  'Ringkasan AI',
  'Jobdesk AI (Tanggung Jawab)',
  'Jobspek',
  'Keahlian',
  'Tipe Pekerjaan',
  'Tanggal Postingan',
  'Batas Pendaftaran',
  'Nomor HP / WA',
  'Website / Form',
  'Instagram DM',
  'Lokasi Penempatan',
  'Cara Melamar',
  'Kategori Bidang',
  'Sumber URL',
  'Platform',
];

const COLUMN_WIDTHS = [5, 12, 26, 26, 30, 30, 18, 26, 46, 42, 42, 40, 13, 16, 18, 18, 26, 18, 22, 40, 18, 42, 12];

const LOGO_EXT = 40; // pixel size of the embedded logo image

const list = (arr: string[] | undefined) => (arr && arr.length > 0 ? arr.join('; ') : '-');

const formatDate = (isoStr: string) => {
  try {
    return new Date(isoStr).toLocaleString('id-ID', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return isoStr || '-';
  }
};

const val = (v: string | undefined | null) => (v && v.trim().length > 0 ? v : '-');

// Alamat administratif (dari AI): Provinsi / Kota-Kab / Kecamatan / Kelurahan, 1 baris per bagian
const adminAddressLabel = (a?: JobVacancy['adminAddress']) => {
  const parts: string[] = [];
  if (a?.province) parts.push(`Provinsi: ${a.province}`);
  if (a?.regency) parts.push(`Kota/Kab: ${a.regency}`);
  if (a?.district) parts.push(`Kecamatan: ${a.district}`);
  if (a?.village) parts.push(`Kelurahan: ${a.village}`);
  return parts.join('\n') || '-';
};

/**
 * Embed the company logo image into the "Logo" cell of a row (placed right before the
 * company name column). Uses exceljs image anchoring at the cell top-left corner.
 */
function addLogoImage(workbook: ExcelJSNS.Workbook, sheet: ExcelJSNS.Worksheet, row: ExcelJSNS.Row, dataUrl?: string) {
  if (!dataUrl) return;
  const mimeMatch = dataUrl.match(/^data:image\/(png|jpe?g);base64,/);
  if (!mimeMatch) return;
  const extension = mimeMatch[1] === 'png' ? 'png' : 'jpeg';
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const imageId = workbook.addImage({ base64, extension });
  sheet.addImage(imageId, {
    tl: { col: 1, row: row.number - 1 },
    ext: { width: LOGO_EXT, height: LOGO_EXT },
  });
  row.height = 42;
}

/**
 * Export one or multiple scanned job vacancies into a clean Excel (.xlsx) workbook.
 * One row per company/vacancy, styled header + frozen top row + autofilter.
 * The company logo (from its official website, or cropped from the screenshot) is
 * embedded right in front of the company name, and the email sits right next to it.
 * Only posts detected as loker (isVacancy) go into the main sheet; rejected ones are
 * listed on a secondary "Tidak Valid" sheet for transparency.
 */
export async function exportVacanciesToExcel(
  vacancies: JobVacancy[],
  documentTitle = 'Laporan_Hasil_Scan_Loker'
) {
  if (!vacancies || vacancies.length === 0) return;

  const valid = vacancies.filter((v) => v.isVacancy);
  const invalid = vacancies.filter((v) => !v.isVacancy);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'LokerDetector AI';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Data Loker');
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  const headerRow = sheet.addRow(HEADERS);
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D4ED8' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
  });
  headerRow.height = 32;

  valid.forEach((item, index) => {
    const row = sheet.addRow([
      index + 1,
      '',
      val(item.companyName),
      val(item.contactInfo?.email),
      adminAddressLabel(item.adminAddress),
      val(item.contactInfo?.address),
      val(item.salaryInfo),
      val(item.jobTitle),
      val(item.summary),
      list(item.responsibilities),
      list(item.requirements),
      list(item.skills),
      val(item.jobType),
      val(item.postDate || formatDate(item.detectedAt)),
      val(item.deadline),
      val(item.contactInfo?.phoneWhatsapp),
      val(item.contactInfo?.websiteForm),
      val(item.contactInfo?.instagramDm),
      val(item.workLocation),
      val(item.howToApply),
      val(item.jobCategory),
      val(item.sourceUrl),
      val(item.platform),
    ]);
    row.eachCell((cell) => {
      cell.alignment = { vertical: 'top', wrapText: true };
      cell.border = { top: { style: 'hair' }, bottom: { style: 'hair' }, left: { style: 'hair' }, right: { style: 'hair' } };
    });
    row.getCell(1).alignment = { vertical: 'top', horizontal: 'center' };
    row.getCell(2).alignment = { vertical: 'middle', horizontal: 'center' };
    row.getCell(3).font = { bold: true };
    row.getCell(23).alignment = { vertical: 'top', horizontal: 'center' };
    addLogoImage(workbook, sheet, row, item.logoDataUrl);
  });

  sheet.columns.forEach((column, i) => {
    if (COLUMN_WIDTHS[i]) column.width = COLUMN_WIDTHS[i];
  });
  sheet.autoFilter = { from: 'A1', to: `${sheet.getCell(1, HEADERS.length).address}` };

  if (invalid.length > 0) {
    const invalidSheet = workbook.addWorksheet('Tidak Valid');
    invalidSheet.views = [{ state: 'frozen', ySplit: 1 }];
    invalidSheet.addRow(['No', 'Konten', 'Platform', 'Sumber', 'Alasan AI']);
    invalidSheet.getRow(1).eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFB91C1C' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    });
    invalid.forEach((item, index) => {
      const row = invalidSheet.addRow([
        index + 1,
        val(item.jobTitle),
        val(item.platform),
        val(item.sourceUrl),
        val(item.detectionReason),
      ]);
      row.eachCell((cell) => {
        cell.alignment = { vertical: 'top', wrapText: true };
      });
    });
    invalidSheet.getColumn(2).width = 30;
    invalidSheet.getColumn(3).width = 12;
    invalidSheet.getColumn(4).width = 42;
    invalidSheet.getColumn(5).width = 80;
  }

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const timeStamp = new Date().toISOString().slice(0, 10);
  a.download = `${documentTitle}_${timeStamp}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Server-side variant: builds the same Excel workbook and returns the raw buffer
 * (instead of triggering a browser download). Used for auto-saving / exporting
 * scheduled IG results directly from the backend.
 */
export async function exportVacanciesToExcelBuffer(vacancies: JobVacancy[]): Promise<Buffer> {
  if (!vacancies || vacancies.length === 0) {
    throw new Error('Tidak ada data lowongan untuk diekspor.');
  }

  const valid = vacancies.filter((v) => v.isVacancy);
  const invalid = vacancies.filter((v) => !v.isVacancy);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'LokerDetector AI';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Data Loker');
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  const headerRow = sheet.addRow(HEADERS);
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D4ED8' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = { top: { style: 'thin' }, bottom: { style: 'thin' }, left: { style: 'thin' }, right: { style: 'thin' } };
  });
  headerRow.height = 32;

  valid.forEach((item, index) => {
    const row = sheet.addRow([
      index + 1,
      '',
      val(item.companyName),
      val(item.contactInfo?.email),
      adminAddressLabel(item.adminAddress),
      val(item.contactInfo?.address),
      val(item.salaryInfo),
      val(item.jobTitle),
      val(item.summary),
      list(item.responsibilities),
      list(item.requirements),
      list(item.skills),
      val(item.jobType),
      val(item.postDate || formatDate(item.detectedAt)),
      val(item.deadline),
      val(item.contactInfo?.phoneWhatsapp),
      val(item.contactInfo?.websiteForm),
      val(item.contactInfo?.instagramDm),
      val(item.workLocation),
      val(item.howToApply),
      val(item.jobCategory),
      val(item.sourceUrl),
      val(item.platform),
    ]);
    row.eachCell((cell) => {
      cell.alignment = { vertical: 'top', wrapText: true };
      cell.border = { top: { style: 'hair' }, bottom: { style: 'hair' }, left: { style: 'hair' }, right: { style: 'hair' } };
    });
    row.getCell(1).alignment = { vertical: 'top', horizontal: 'center' };
    row.getCell(2).alignment = { vertical: 'middle', horizontal: 'center' };
    row.getCell(3).font = { bold: true };
    row.getCell(23).alignment = { vertical: 'top', horizontal: 'center' };
    addLogoImage(workbook, sheet, row, item.logoDataUrl);
  });

  sheet.columns.forEach((column, i) => {
    if (COLUMN_WIDTHS[i]) column.width = COLUMN_WIDTHS[i];
  });
  sheet.autoFilter = { from: 'A1', to: `${sheet.getCell(1, HEADERS.length).address}` };

  if (invalid.length > 0) {
    const invalidSheet = workbook.addWorksheet('Tidak Valid');
    invalidSheet.views = [{ state: 'frozen', ySplit: 1 }];
    invalidSheet.addRow(['No', 'Konten', 'Platform', 'Sumber', 'Alasan AI']);
    invalidSheet.getRow(1).eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFB91C1C' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    });
    invalid.forEach((item, index) => {
      const row = invalidSheet.addRow([
        index + 1,
        val(item.jobTitle),
        val(item.platform),
        val(item.sourceUrl),
        val(item.detectionReason),
      ]);
      row.eachCell((cell) => {
        cell.alignment = { vertical: 'top', wrapText: true };
      });
    });
    invalidSheet.getColumn(2).width = 30;
    invalidSheet.getColumn(3).width = 12;
    invalidSheet.getColumn(4).width = 42;
    invalidSheet.getColumn(5).width = 80;
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer as ArrayBuffer);
}
