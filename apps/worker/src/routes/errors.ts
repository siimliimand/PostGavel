import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * HTTPException carrying a machine-readable code. The app-level onError turns
 * it into the extended error envelope: `{ "error": "message", "code": "…" }`.
 * Optional extra headers (e.g. `Retry-After` on a 429) are merged into that
 * JSON response by onError. (This Hono version's HTTPException has no headers
 * option, so the headers travel on the subclass.)
 */
export class CodedHTTPException extends HTTPException {
  readonly code: string;
  readonly extraHeaders?: Record<string, string>;

  constructor(
    status: ContentfulStatusCode,
    message: string,
    code: string,
    headers?: Record<string, string>,
  ) {
    super(status, { message });
    this.code = code;
    this.extraHeaders = headers;
  }
}
