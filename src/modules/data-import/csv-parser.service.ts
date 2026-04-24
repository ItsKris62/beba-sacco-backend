import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { parse } from 'csv-parse';
import { Readable } from 'stream';
import { normalizePhone } from './utils/phone-normalizer';
import { parseFullName } from './utils/name-parser';
import type { ParsedCsvRow } from './dto/import.dto';

/** Expected CSV column headers (case-insensitive match) */
const REQUIRED_HEADERS = ['NAME', 'PHONE NO.'];
const OPTIONAL_HEADERS = ['NO', 'ID NO.', 'STAGE NAME', 'POSITION', 'NEXT OF KIN CONTACT', 'SUB COUNTY', 'WARD CHAIRMAN'];

/** Map of normalized header → field key */
const HEADER_MAP: Record<string, keyof RawCsvRecord> = {
  'NO': 'no',
  'NAME': 'name',
  'ID NO.': 'idNo',
  'PHONE NO.': 'phoneNo',
  'STAGE NAME': 'stageName',
  'POSITION': 'position',
  'NEXT OF KIN CONTACT': 'nextOfKin',
  'SUB COUNTY': 'subCounty',
  'WARD CHAIRMAN': 'wardChairman',
};

interface RawCsvRecord {
  no: string;
  name: string;
  idNo: string;
  phoneNo: string;
  stageName: string;
  position: string;
  nextOfKin: string;
  subCounty: string;
  wardChairman: string;
}

@Injectable()
export class CsvParserService {
  private readonly logger = new Logger(CsvParserService.name);

  /**
   * Parse a CSV buffer into structured rows.
   * Handles the Kolwa Central Boda CSV format with header rows before the data.
   */
  async parseBuffer(buffer: Buffer): Promise<ParsedCsvRow[]> {
    const raw = await this.extractRawRecords(buffer);
    return raw.map((record, index) => this.transformRecord(record, index + 1));
  }

  /**
   * Extract raw records from CSV buffer.
   * Skips metadata rows before the actual header row.
   */
  private extractRawRecords(buffer: Buffer): Promise<RawCsvRecord[]> {
    return new Promise((resolve, reject) => {
      const records: RawCsvRecord[] = [];
      let headerRowIndex = -1;
      let columnMap: Record<number, keyof RawCsvRecord> = {};
      let rowIndex = 0;

      const parser = parse({
        relaxColumnCount: true,
        skipEmptyLines: false,
        trim: true,
        bom: true,
      });

      parser.on('readable', () => {
        let row: string[];
        while ((row = parser.read()) !== null) {
          rowIndex++;

          // Detect header row by looking for "NAME" and "PHONE NO." columns
          if (headerRowIndex === -1) {
            const upperRow = row.map(c => c.toUpperCase().trim());
            if (upperRow.includes('NAME') && upperRow.some(c => c.includes('PHONE'))) {
              headerRowIndex = rowIndex;
              // Build column map
              upperRow.forEach((header, colIdx) => {
                const mapped = HEADER_MAP[header];
                if (mapped) {
                  columnMap[colIdx] = mapped;
                }
              });
              this.logger.debug(`Found header row at line ${rowIndex}`);
            }
            continue;
          }

          // Skip rows after a long blank section (end of data)
          const nonEmpty = row.filter(c => c.trim() !== '');
          if (nonEmpty.length === 0) continue;

          // Build record from column map
          const record: Partial<RawCsvRecord> = {
            no: '', name: '', idNo: '', phoneNo: '',
            stageName: '', position: 'MEMBER', nextOfKin: '',
            subCounty: '', wardChairman: '',
          };

          Object.entries(columnMap).forEach(([colIdx, field]) => {
            const val = row[Number(colIdx)]?.trim() ?? '';
            (record as Record<string, string>)[field] = val;
          });

          // Skip rows with no name and no phone (truly empty data rows)
          if (!record.name && !record.phoneNo) continue;

          records.push(record as RawCsvRecord);
        }
      });

      parser.on('error', (err) => {
        this.logger.error('CSV parse error', err);
        reject(new BadRequestException(`CSV parse error: ${err.message}`));
      });

      parser.on('end', () => {
        if (headerRowIndex === -1) {
          reject(new BadRequestException('Could not find header row in CSV. Expected columns: NAME, PHONE NO.'));
          return;
        }
        this.logger.log(`Parsed ${records.length} data rows from CSV`);
        resolve(records);
      });

      // Feed buffer into parser
      const stream = Readable.from(buffer);
      stream.pipe(parser);
    });
  }

  /**
   * Transform a raw CSV record into a structured ParsedCsvRow.
   */
  private transformRecord(raw: RawCsvRecord, rowNumber: number): ParsedCsvRow {
    const { firstName, lastName } = parseFullName(raw.name);
    const phoneResult = normalizePhone(raw.phoneNo);
    const idNumber = this.normalizeIdNumber(raw.idNo);

    return {
      rowNumber,
      legacyNo: raw.no?.trim() || null,
      firstName,
      lastName,
      rawIdNumber: raw.idNo?.trim() || null,
      idNumber,
      rawPhone: raw.phoneNo?.trim() || null,
      phoneNumber: phoneResult.normalized,
      stageName: raw.stageName?.trim() || null,
      position: this.normalizePosition(raw.position),
      nextOfKinPhone: raw.nextOfKin?.trim() || null,
      subCounty: raw.subCounty?.trim() || null,
      wardChairman: raw.wardChairman?.trim() || null,
    };
  }

  /**
   * Normalize a Kenyan National ID number.
   * Valid: 7-8 digits. Returns null if invalid.
   */
  private normalizeIdNumber(raw: string | null | undefined): string | null {
    if (!raw?.trim()) return null;
    const digits = raw.trim().replace(/\D/g, '');
    if (/^\d{7,8}$/.test(digits)) return digits;
    return null; // Invalid (e.g., 9-digit IDs like 293007493 are data errors)
  }

  /**
   * Normalize position string to valid enum value.
   */
  private normalizePosition(raw: string | null | undefined): string {
    const upper = raw?.toUpperCase().trim() ?? '';
    const map: Record<string, string> = {
      CHAIRMAN: 'CHAIRMAN',
      SECRETARY: 'SECRETARY',
      TREASURER: 'TREASURER',
      MEMBER: 'MEMBER',
    };
    return map[upper] ?? 'MEMBER';
  }
}
