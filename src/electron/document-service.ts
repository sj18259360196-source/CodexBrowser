import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { DocumentSummary } from "../shared/contracts";

interface DocumentRecord extends DocumentSummary {
  filePath: string;
  sha256: string;
  sourceUrl?: string;
  pageTexts: string[];
}

type UnknownRecord = Record<string, unknown>;

export interface DocumentReadResult {
  document: DocumentSummary;
  pages: Array<{ page: number; text: string }>;
}

export interface DocumentSearchHit {
  documentId: string;
  title: string;
  page: number;
  snippet: string;
}

function toSummary(record: DocumentRecord): DocumentSummary {
  const { id, title, fileName, pages, characters, createdAt } = record;
  return { id, title, fileName, pages, characters, createdAt };
}

function safeFileName(value: string): string {
  const cleaned = value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, 160) || "document.pdf";
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isObject(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeSourceUrl(sourceUrl?: string): string | undefined {
  if (!sourceUrl?.trim()) {
    return undefined;
  }

  const value = sourceUrl.trim();
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    // Keep a useful citation target while dropping credentials, signed query
    // parameters, fragments, and other transient authorization material.
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return undefined;
  }
}

export class DocumentService {
  private readonly documentsDir: string;
  private readonly indexPath: string;
  private records: DocumentRecord[] = [];
  private initialized = false;
  private initializationPromise: Promise<void> | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly libraryDir: string) {
    this.libraryDir = path.resolve(libraryDir);
    this.documentsDir = path.join(this.libraryDir, "documents");
    this.indexPath = path.join(this.libraryDir, "index.json");
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    this.initializationPromise = this.initializeInternal();
    try {
      await this.initializationPromise;
    } finally {
      this.initializationPromise = null;
    }
  }

  private async initializeInternal(): Promise<void> {
    await fs.mkdir(this.documentsDir, { recursive: true });
    let shouldRewrite = false;

    try {
      const raw = await fs.readFile(this.indexPath, "utf8");
      const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
      if (!Array.isArray(parsed)) {
        throw new Error("Document index must contain an array.");
      }

      const validRecords: DocumentRecord[] = [];
      for (const value of parsed) {
        try {
          const sourceUrlBeforeNormalization = isObject(value) && typeof value.sourceUrl === "string"
            ? value.sourceUrl
            : undefined;
          const record = this.validateRecord(value);
          const normalizedSourceUrl = normalizeSourceUrl(record.sourceUrl);
          const storedPath = isObject(value) && typeof value.filePath === "string" ? value.filePath : undefined;
          const storedHash = isObject(value) && typeof value.sha256 === "string" ? value.sha256 : undefined;
          if (
            normalizedSourceUrl !== sourceUrlBeforeNormalization
            || record.filePath !== storedPath
            || record.sha256 !== storedHash
          ) {
            shouldRewrite = true;
          }
          record.sourceUrl = normalizedSourceUrl;
          if (validRecords.some((candidate) => candidate.id === record.id || candidate.sha256 === record.sha256)) {
            shouldRewrite = true;
            continue;
          }
          validRecords.push(record);
        } catch {
          shouldRewrite = true;
        }
      }
      if (validRecords.length !== parsed.length) {
        await this.backupCorruptIndex();
      }
      this.records = validRecords;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        await this.backupCorruptIndex().catch(() => undefined);
        this.records = [];
        shouldRewrite = true;
      } else {
        this.records = [];
      }
    }

    this.initialized = true;
    if (shouldRewrite) {
      await this.persist();
    }
  }

  list(): DocumentSummary[] {
    return this.records
      .map(toSummary)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getRecord(documentId: string): DocumentRecord | undefined {
    return this.records.find((record) => record.id === documentId);
  }

  getFilePath(documentId: string): string {
    const filePath = path.resolve(this.getRequiredRecord(documentId).filePath);
    if (!isInside(this.documentsDir, filePath)) {
      throw new Error(`Document ${documentId} points outside the document library.`);
    }
    return filePath;
  }

  async importPdf(filePath: string, sourceUrl?: string): Promise<DocumentSummary> {
    await this.initialize();

    return this.enqueueMutation(async () => {
      const resolvedPath = await fs.realpath(path.resolve(filePath));
      const stat = await fs.stat(resolvedPath);
      if (!stat.isFile()) {
        throw new Error("The selected PDF path is not a file.");
      }

      const buffer = await fs.readFile(resolvedPath);
      if (buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
        throw new Error("The selected file is not a valid PDF document.");
      }

      const sha256 = createHash("sha256").update(buffer).digest("hex");
      const duplicate = this.records.find((record) => record.sha256 === sha256);
      if (duplicate) {
        return toSummary(duplicate);
      }

      const id = randomUUID();
      const originalName = safeFileName(path.basename(resolvedPath));
      const storedName = `${id}-${originalName.toLowerCase().endsWith(".pdf") ? originalName : `${originalName}.pdf`}`;
      const storedPath = path.resolve(path.join(this.documentsDir, storedName));
      const sourceIsInLibrary = isInside(this.documentsDir, resolvedPath);
      let copied = false;

      try {
        if (!sourceIsInLibrary) {
          await fs.copyFile(resolvedPath, storedPath);
          copied = true;
        }

        const finalPath = sourceIsInLibrary ? resolvedPath : storedPath;
        const { pageTexts, title: metadataTitle } = await this.extractPdf(buffer);
        const title = metadataTitle?.trim() || path.basename(originalName, path.extname(originalName));
        const createdAt = new Date().toISOString();
        const record: DocumentRecord = {
          id,
          title,
          fileName: originalName,
          pages: pageTexts.length,
          characters: pageTexts.reduce((sum, text) => sum + text.length, 0),
          createdAt,
          filePath: finalPath,
          sha256,
          sourceUrl: normalizeSourceUrl(sourceUrl),
          pageTexts,
        };

        this.records.push(record);
        try {
          await this.persist();
        } catch (error) {
          this.records = this.records.filter((candidate) => candidate.id !== id);
          throw error;
        }
        return toSummary(record);
      } catch (error) {
        if (copied) {
          await fs.unlink(storedPath).catch(() => undefined);
        }
        throw error;
      }
    });
  }

  read(documentId: string, startPage = 1, endPage?: number): DocumentReadResult {
    const record = this.getRequiredRecord(documentId);
    const first = Math.max(1, Math.floor(startPage));
    const requestedEnd = endPage == null ? first : Math.floor(endPage);
    const last = Math.min(record.pages, Math.max(first, requestedEnd), first + 19);
    if (first > record.pages) {
      throw new Error(`Page ${first} is outside this ${record.pages}-page document.`);
    }

    return {
      document: toSummary(record),
      pages: record.pageTexts.slice(first - 1, last).map((text, index) => ({
        page: first + index,
        text,
      })),
    };
  }

  search(query: string, documentId?: string, limit = 20): DocumentSearchHit[] {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) {
      throw new Error("Search query cannot be empty.");
    }

    const records = documentId ? [this.getRequiredRecord(documentId)] : this.records;
    const hits: DocumentSearchHit[] = [];
    const maxHits = Math.min(Math.max(Math.floor(limit), 1), 100);

    for (const record of records) {
      for (let index = 0; index < record.pageTexts.length; index += 1) {
        const pageText = record.pageTexts[index];
        const position = pageText.toLocaleLowerCase().indexOf(needle);
        if (position === -1) {
          continue;
        }

        const start = Math.max(0, position - 120);
        const end = Math.min(pageText.length, position + needle.length + 180);
        hits.push({
          documentId: record.id,
          title: record.title,
          page: index + 1,
          snippet: pageText.slice(start, end).replace(/\s+/g, " ").trim(),
        });
        if (hits.length >= maxHits) {
          return hits;
        }
      }
    }

    return hits;
  }

  private getRequiredRecord(documentId: string): DocumentRecord {
    const record = this.getRecord(documentId);
    if (!record) {
      throw new Error(`Document ${documentId} was not found.`);
    }
    return record;
  }

  private validateRecord(value: unknown): DocumentRecord {
    if (!isObject(value)) {
      throw new Error("Document index entry must be an object.");
    }

    const pageTexts = value.pageTexts;
    if (!Array.isArray(pageTexts) || !pageTexts.every((text) => typeof text === "string")) {
      throw new Error("Document index pageTexts is invalid.");
    }
    if (!isNonEmptyString(value.id) || !isNonEmptyString(value.title) || !isNonEmptyString(value.fileName)) {
      throw new Error("Document index identity fields are invalid.");
    }
    if (!isNonEmptyString(value.filePath) || !isNonEmptyString(value.createdAt)) {
      throw new Error("Document index path/time fields are invalid.");
    }
    if (value.sourceUrl !== undefined && typeof value.sourceUrl !== "string") {
      throw new Error("Document index source URL is invalid.");
    }
    const pages = value.pages;
    if (typeof pages !== "number" || !Number.isInteger(pages) || pages < 0 || pages !== pageTexts.length) {
      throw new Error("Document index page count is invalid.");
    }
    const characters = pageTexts.reduce((sum, text) => sum + text.length, 0);
    const storedCharacters = value.characters;
    if (typeof storedCharacters !== "number" || !Number.isInteger(storedCharacters) || storedCharacters < 0 || storedCharacters !== characters) {
      throw new Error("Document index character count is invalid.");
    }
    if (Number.isNaN(Date.parse(value.createdAt))) {
      throw new Error("Document index timestamp is invalid.");
    }
    if (!/^[a-f0-9]{64}$/i.test(String(value.sha256))) {
      throw new Error("Document index hash is invalid.");
    }

    const filePath = path.resolve(String(value.filePath));
    if (!isInside(this.documentsDir, filePath)) {
      throw new Error("Document index path escapes the document library.");
    }

    return {
      id: value.id,
      title: value.title,
      fileName: value.fileName,
      pages,
      characters: storedCharacters,
      createdAt: value.createdAt,
      filePath,
      sha256: String(value.sha256).toLowerCase(),
      sourceUrl: normalizeSourceUrl(typeof value.sourceUrl === "string" ? value.sourceUrl : undefined),
      pageTexts,
    };
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(operation, operation);
    this.mutationQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  private async backupCorruptIndex(): Promise<void> {
    try {
      await fs.stat(this.indexPath);
    } catch {
      return;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${this.indexPath}.corrupt-${stamp}-${randomUUID()}.json`;
    try {
      await fs.rename(this.indexPath, backupPath);
    } catch {
      await fs.copyFile(this.indexPath, backupPath);
      await fs.unlink(this.indexPath).catch(() => undefined);
    }
  }

  private async extractPdf(buffer: Buffer): Promise<{ pageTexts: string[]; title?: string }> {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(buffer),
      useSystemFonts: true,
      disableFontFace: true,
    });
    const document = await loadingTask.promise;
    const pageTexts: string[] = [];
    let title: string | undefined;

    try {
      const metadata = await document.getMetadata().catch(() => null);
      const info = metadata?.info as { Title?: string } | undefined;
      title = info?.Title;

      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent();
        const parts: string[] = [];
        for (const item of content.items) {
          if (!("str" in item)) {
            continue;
          }
          parts.push(item.str);
          if (item.hasEOL) {
            parts.push("\n");
          } else {
            parts.push(" ");
          }
        }
        pageTexts.push(parts.join("").replace(/[ \t]+\n/g, "\n").trim());
        page.cleanup();
      }
    } finally {
      await document.destroy();
    }

    return { pageTexts, title };
  }

  private async persist(): Promise<void> {
    const temporaryPath = `${this.indexPath}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporaryPath, "w");
      try {
        await handle.writeFile(JSON.stringify(this.records, null, 2), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporaryPath, this.indexPath);
    } catch (error) {
      await fs.unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}
