export interface ResponseHeader {
  name: string;
  value: string;
}

function headerValue(headers: ResponseHeader[], name: string): string {
  return headers.find((header) => header.name.toLowerCase() === name)?.value.trim().toLowerCase() || "";
}

/**
 * A URL ending in .pdf is not sufficient: publishers commonly return an HTML
 * login or Cloudflare challenge at the original PDF URL. Buffering and
 * fulfilling that HTML as though it were a PDF changes the verification flow.
 */
export function isCapturablePdfResponse(status: number, headers: ResponseHeader[]): boolean {
  if (status < 200 || status >= 300) return false;
  const contentType = headerValue(headers, "content-type").split(";", 1)[0];
  if (contentType === "application/pdf") return true;
  if (contentType !== "application/octet-stream") return false;
  return /(?:filename\*?=|attachment;).*\.pdf(?:["';\s]|$)/i.test(headerValue(headers, "content-disposition"));
}
