/** @type {string | null} */
let frozenIso = null;

/**
 * Server clock for `created_at`. Truncated to whole UTC seconds so the stored
 * value and the hash input cannot disagree about milliseconds.
 * @returns {Date}
 */
export function nowUtc() {
  const source = frozenIso ? new Date(frozenIso) : new Date();
  return new Date(Math.floor(source.getTime() / 1000) * 1000);
}

/**
 * @param {string | Date | null} iso
 */
export function freezeTime(iso) {
  frozenIso = iso instanceof Date ? iso.toISOString() : iso;
}

export function unfreezeTime() {
  frozenIso = null;
}
