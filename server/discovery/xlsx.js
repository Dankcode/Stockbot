/**
 * Minimal, dependency-free reader for the first worksheet of an .xlsx file.
 * Enough for published holdings files (shared strings + numeric cells); it is
 * not a general spreadsheet parser and never evaluates formulas.
 */
import { inflateRawSync } from "node:zlib";

const MAX_ENTRY_BYTES = 32 * 1024 * 1024;

function zipEntries(buffer) {
  let eocd = -1;
  for (let index = buffer.length - 22; index >= Math.max(0, buffer.length - 65_557); index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) { eocd = index; break; }
  }
  if (eocd < 0) throw new Error("Not a zip archive (no end-of-central-directory record).");
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("Corrupt zip central directory.");
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    entries.set(name, { method, compressedSize, size, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return {
    read(name) {
      const entry = entries.get(name);
      if (!entry) return null;
      if (entry.size > MAX_ENTRY_BYTES) throw new Error(`${name} is too large.`);
      const local = entry.localOffset;
      const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      const data = buffer.subarray(start, start + entry.compressedSize);
      if (entry.method === 0) return data.toString("utf8");
      if (entry.method === 8) return inflateRawSync(data).toString("utf8");
      throw new Error(`Unsupported zip compression method ${entry.method}.`);
    }
  };
}

const decode = (text) => text
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code))).replace(/&amp;/g, "&");

function columnIndex(reference) {
  const letters = /^([A-Z]+)/.exec(reference)?.[1] ?? "A";
  return [...letters].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

/** Returns the first worksheet as an array of rows (arrays of strings). */
export function readFirstSheet(buffer) {
  const zip = zipEntries(buffer);
  const shared = [];
  const sharedXml = zip.read("xl/sharedStrings.xml");
  if (sharedXml) {
    for (const item of sharedXml.match(/<si>[\s\S]*?<\/si>/g) ?? []) {
      shared.push(decode((item.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? []).map((part) => part.replace(/<[^>]+>/g, "")).join("")));
    }
  }
  const sheet = zip.read("xl/worksheets/sheet1.xml");
  if (!sheet) throw new Error("Workbook has no first worksheet.");
  const rows = [];
  for (const row of sheet.match(/<row[^>]*>[\s\S]*?<\/row>/g) ?? []) {
    const cells = [];
    for (const cell of row.match(/<c [^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) ?? []) {
      const reference = /r="([A-Z]+\d+)"/.exec(cell)?.[1];
      const type = /t="([a-z]+)"/.exec(cell)?.[1];
      const raw = /<v>([\s\S]*?)<\/v>/.exec(cell)?.[1] ?? /<t[^>]*>([\s\S]*?)<\/t>/.exec(cell)?.[1] ?? "";
      const value = type === "s" ? shared[Number(raw)] ?? "" : decode(raw);
      cells[reference ? columnIndex(reference) : cells.length] = value;
    }
    rows.push(Array.from(cells, (value) => value ?? ""));
  }
  return rows;
}
