import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * HTTPException carrying a machine-readable code. The app-level onError turns
 * it into the extended error envelope: `{ "error": "message", "code": "…" }`.
 */
export class CodedHTTPException extends HTTPException {
  readonly code: string;

  constructor(status: ContentfulStatusCode, message: string, code: string) {
    super(status, { message });
    this.code = code;
  }
}
