/**
 * Browser client for the unprefixed Fastify API. Vite strips the /api prefix.
 */
export class ApiError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {object} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.details = details;
  }
}

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown, actor?: string, idempotencyKey?: string }} [options]
 */
export async function request(path, options = {}) {
  const headers = {};
  if (options.actor) headers["x-actor"] = options.actor;
  if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
  /** @type {BodyInit | undefined} */
  let body;
  if (options.body instanceof FormData) body = options.body;
  else if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  const response = await fetch(`/api${path}`, { method: options.method ?? "GET", headers, body });
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("spreadsheet") || type.includes("octet-stream")) {
    if (!response.ok) throw new ApiError("INTERNAL_ERROR", "Download failed.");
    return response.blob();
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = payload.error ?? {};
    throw new ApiError(error.code ?? "INTERNAL_ERROR", error.message ?? "Request failed.", error.details ?? {});
  }
  return payload;
}

/**
 * @param {Blob} blob
 * @param {string} filename
 */
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
