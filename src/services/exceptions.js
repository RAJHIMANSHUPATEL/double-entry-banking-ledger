/**
 * Domain failures. HTTP status and error codes live here so route handlers
 * only translate the exception into the envelope.
 */
export class LedgerError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string, details?: object }} [options]
   */
  constructor(message, options = {}) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = options.status ?? 422;
    this.code = options.code ?? "LEDGER_ERROR";
    this.details = options.details ?? {};
  }
}

export class InvalidEntry extends LedgerError {
  /** @param {string} message @param {object} [details] */
  constructor(message, details = {}) {
    super(message, { status: 422, code: "VALIDATION_ERROR", details });
  }
}

export class UnbalancedEntry extends LedgerError {
  /** @param {string} message @param {object} [details] */
  constructor(message, details = {}) {
    super(message, { status: 422, code: "UNBALANCED_ENTRY", details });
  }
}

export class AccountNotFound extends LedgerError {
  /** @param {string} code */
  constructor(code) {
    super(`Account ${code} was not found.`, {
      status: 404,
      code: "ACCOUNT_NOT_FOUND",
      details: { account_code: code },
    });
  }
}

export class AccountNotPostable extends LedgerError {
  /** @param {string} code @param {string} reason */
  constructor(code, reason) {
    super(`Account ${code} is not postable: ${reason}.`, {
      status: 422,
      code: "ACCOUNT_NOT_POSTABLE",
      details: { account_code: code, reason },
    });
  }
}

export class Overdraft extends LedgerError {
  /**
   * @param {string} accountCode
   * @param {number} balancePaise
   * @param {number} attemptedDeltaPaise
   */
  constructor(accountCode, balancePaise, attemptedDeltaPaise) {
    super(
      `Account ${accountCode} would go negative: balance ${balancePaise} paise, attempted change ${attemptedDeltaPaise} paise.`,
      {
        status: 422,
        code: "OVERDRAFT",
        details: {
          account_code: accountCode,
          balance_paise: balancePaise,
          attempted_delta_paise: attemptedDeltaPaise,
        },
      },
    );
  }
}

export class EntryNotFound extends LedgerError {
  /** @param {number} entryId */
  constructor(entryId) {
    super(`Journal entry ${entryId} was not found.`, {
      status: 404,
      code: "ENTRY_NOT_FOUND",
      details: { entry_id: entryId },
    });
  }
}

export class AlreadyReversed extends LedgerError {
  /** @param {number} entryId */
  constructor(entryId) {
    super(`Journal entry ${entryId} has already been reversed.`, {
      status: 409,
      code: "ALREADY_REVERSED",
      details: { entry_id: entryId },
    });
  }
}

export class InvariantViolation extends LedgerError {
  /** @param {string} message */
  constructor(message) {
    super(message, { status: 500, code: "INVARIANT_VIOLATION" });
  }
}
