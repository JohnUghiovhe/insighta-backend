export type ParsedCsvRow = {
  cells: string[];
  malformed: boolean;
  brokenEncoding: boolean;
};

export class CsvRowParser {
  private field = "";
  private row: string[] = [];
  private inQuotes = false;
  private rowMalformed = false;
  private rowBrokenEncoding = false;

  private reset(): void {
    this.field = "";
    this.row = [];
    this.inQuotes = false;
    this.rowMalformed = false;
    this.rowBrokenEncoding = false;
  }

  private emitRow(): ParsedCsvRow {
    const emitted: ParsedCsvRow = {
      cells: [...this.row, this.field],
      malformed: this.rowMalformed,
      brokenEncoding: this.rowBrokenEncoding
    };
    this.reset();
    return emitted;
  }

  push(chunk: string): ParsedCsvRow[] {
    const rows: ParsedCsvRow[] = [];

    for (let index = 0; index < chunk.length; index += 1) {
      const char = chunk[index];
      if (char === "\uFFFD") {
        this.rowBrokenEncoding = true;
      }

      if (this.inQuotes) {
        if (char === '"') {
          if (chunk[index + 1] === '"') {
            this.field += '"';
            index += 1;
          } else {
            this.inQuotes = false;
          }
        } else {
          this.field += char;
        }
        continue;
      }

      if (char === ",") {
        this.row.push(this.field);
        this.field = "";
        continue;
      }

      if (char === '"') {
        if (this.field.length === 0) {
          this.inQuotes = true;
        } else {
          this.rowMalformed = true;
          this.field += char;
        }
        continue;
      }

      if (char === "\r") {
        continue;
      }

      if (char === "\n") {
        rows.push(this.emitRow());
        continue;
      }

      this.field += char;
    }

    return rows;
  }

  finish(): ParsedCsvRow | null {
    if (!this.inQuotes && this.row.length === 0 && this.field.length === 0 && !this.rowMalformed && !this.rowBrokenEncoding) {
      return null;
    }

    return this.emitRow();
  }
}

export const normalizeCsvHeader = (header: string): string => {
  return header.trim().toLowerCase().replace(/[\s-]+/g, "_");
};