// utils/xlsx.js — penulis .xlsx minimal tanpa dependency (SpreadsheetML di
// dalam kontainer ZIP, Node murni: zlib.deflateRawSync + zlib.crc32).
//
// Sengaja ditulis sendiri: satu-satunya konsumen adalah lampiran laporan
// keuangan (financial-xlsx.js), dan exceljs/sheetjs menyeret ber-MB dependency
// ke daemon trading live untuk kebutuhan sebesar ini. Batas sadar: tanpa
// merge cell, tanpa formula, tanpa sharedStrings (inline string saja), satu
// font + lima gaya — cukup untuk workbook laporan, dan setiap batas itu
// membuat outputnya deterministik (timestamp ZIP konstan) sehingga bisa
// di-assert byte-demi-byte di unit test.
//
// API: buildXlsx(sheets) → Buffer
//   sheets = [{ name, rows, colWidths?, defaultColWidth?, freeze? }]
//   rows   = array baris; sel = null/undefined (KOSONG — dilewati, beda arti
//            dengan 0), number (sel angka sungguhan), string (teks), atau
//            {v, s} dengan s salah satu S.* di bawah.
//   freeze = {x, y} — bekukan x kolom pertama / y baris pertama.

import zlib from "zlib";

// Indeks cellXfs di styles.xml — urutannya kontrak, jangan diubah tanpa
// mengubah STYLES_XML di bawah.
export const S = {
  TEXT: 0, // umum, tanpa format
  BOLD: 1, // header
  SOL4: 2, // angka 0.0000 (SOL 4 desimal — konvensi §09)
  DEC2: 3, // angka 0.00 (USD / persen)
  INT: 4,  // angka bulat
};

function colName(n) {
  let s = "";
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

const escXml = (v) =>
  String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function sheetXml({ rows, colWidths = [], defaultColWidth = 14, freeze }) {
  const parts = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
  ];
  let pane = "";
  if (freeze && (freeze.x || freeze.y)) {
    const active = freeze.x && freeze.y ? "bottomRight" : freeze.x ? "topRight" : "bottomLeft";
    pane =
      `<pane${freeze.x ? ` xSplit="${freeze.x}"` : ""}${freeze.y ? ` ySplit="${freeze.y}"` : ""}` +
      ` topLeftCell="${colName((freeze.x ?? 0) + 1)}${(freeze.y ?? 0) + 1}" activePane="${active}" state="frozen"/>`;
  }
  parts.push(`<sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews>`);
  parts.push(`<sheetFormatPr defaultColWidth="${defaultColWidth}" defaultRowHeight="15"/>`);
  if (colWidths.some((w) => w)) {
    parts.push(
      "<cols>" +
        colWidths.map((w, i) => (w ? `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>` : "")).join("") +
        "</cols>",
    );
  }
  parts.push("<sheetData>");
  rows.forEach((row, ri) => {
    const cells = [];
    row.forEach((cell, ci) => {
      if (cell == null) return; // sel kosong ≠ nol — dilewati, bukan 0
      const { v, s = S.TEXT } = typeof cell === "object" ? cell : { v: cell };
      if (v == null) return;
      const ref = `${colName(ci + 1)}${ri + 1}`;
      if (typeof v === "number") {
        if (!Number.isFinite(v)) return;
        cells.push(`<c r="${ref}" s="${s}"><v>${v}</v></c>`);
      } else {
        cells.push(`<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${escXml(v)}</t></is></c>`);
      }
    });
    parts.push(`<row r="${ri + 1}">${cells.join("")}</row>`);
  });
  parts.push("</sheetData></worksheet>");
  return parts.join("");
}

const STYLES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<numFmts count="2"><numFmt numFmtId="164" formatCode="0.0000"/><numFmt numFmtId="165" formatCode="0.00"/></numFmts>' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  "<borders count=\"1\"><border><left/><right/><top/><bottom/><diagonal/></border></borders>" +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="5">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  "</cellXfs>" +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  "</styleSheet>";

// Nama sheet: Excel menolak []:*?/\ , >31 karakter, dan nama kembar.
function sheetNames(sheets) {
  const seen = new Set();
  return sheets.map((s, i) => {
    let name = String(s.name ?? "").replace(/[\\/*?:[\]]/g, " ").trim().slice(0, 31) || `Sheet${i + 1}`;
    while (seen.has(name)) name = `${name.slice(0, 28)}~${i + 1}`;
    seen.add(name);
    return name;
  });
}

export function buildXlsx(sheets) {
  if (!Array.isArray(sheets) || sheets.length === 0) throw new Error("buildXlsx: minimal satu sheet");
  const names = sheetNames(sheets);
  const NS_DOC = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    sheets
      .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
      .join("") +
    "</Types>";
  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    `<Relationship Id="rId1" Type="${NS_DOC}/officeDocument" Target="xl/workbook.xml"/>` +
    "</Relationships>";
  const workbook =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"' +
    ` xmlns:r="${NS_DOC}"><sheets>` +
    names.map((n, i) => `<sheet name="${escXml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
    "</sheets></workbook>";
  const wbRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NS_DOC}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
    `<Relationship Id="rId${sheets.length + 1}" Type="${NS_DOC}/styles" Target="styles.xml"/>` +
    "</Relationships>";

  const entries = [
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(rootRels, "utf8") },
    { name: "xl/workbook.xml", data: Buffer.from(workbook, "utf8") },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(wbRels, "utf8") },
    { name: "xl/styles.xml", data: Buffer.from(STYLES_XML, "utf8") },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: Buffer.from(sheetXml(s), "utf8") })),
  ];
  return zipSync(entries);
}

// ZIP store/deflate dengan timestamp DOS KONSTAN (1 Jan 2026) — workbook yang
// sama byte-nya harus identik antar-run; waktu kirim sudah hidup di caption
// dan isi laporan, bukan di metadata kontainer.
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

function zipSync(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = zlib.crc32(data) >>> 0;
    const deflated = zlib.deflateRawSync(data, { level: 6 });
    const useDeflate = deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // versi minimal
    local.writeUInt16LE(0, 6); // flags: ukuran ditulis di header, tanpa data descriptor
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // jam DOS 00:00
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, payload);

    const central = Buffer.alloc(46); // field lain 0 by alloc
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += 30 + nameBuf.length + payload.length;
  }
  const centralSize = centrals.reduce((a, b) => a + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, eocd]);
}
