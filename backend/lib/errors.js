// Error types and the exact user-facing messages from the specification (section 42).
// AppError carries a safe message that may be shown to users. Everything else is internal and
// is mapped to a generic message before leaving the server.

export const MESSAGES = Object.freeze({
  busy: 'System busy. Another data request is currently being processed. Please try again shortly.',
  inProgress: 'Data not available yet. The requested date is still in progress. Please retry later.',
  notVerified:
    'Data not available yet. The requested date has not been fully processed and verified. Please retry later.',
  invalidRange: 'Invalid date range. The start date must not be later than the end date.',
  datasetFailure: 'The requested historical data could not be prepared at this time. Please try again later.',
  future: 'Invalid date range. Future dates cannot be requested.',
  expired: 'This download has expired. Please generate the data again.',
  interrupted: 'The request was interrupted before it finished. Please try again.',
  starting: 'The service is starting up. Please try again in a moment.',
  misconfigured: 'The service is not fully configured yet. Please try again later.',
});

export class AppError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

export const Errors = {
  busy: () => new AppError('SYSTEM_BUSY', MESSAGES.busy, 409),
  inProgress: () => new AppError('DATA_NOT_AVAILABLE_YET', MESSAGES.inProgress, 409, { reason: 'in_progress' }),
  notVerified: () => new AppError('DATA_NOT_AVAILABLE_YET', MESSAGES.notVerified, 409, { reason: 'not_verified' }),
  invalidRange: () => new AppError('INVALID_RANGE', MESSAGES.invalidRange, 400),
  future: () => new AppError('FUTURE_DATE', MESSAGES.future, 400),
  datasetFailure: () => new AppError('DATASET_FAILURE', MESSAGES.datasetFailure, 500),
  expired: () => new AppError('EXPORT_EXPIRED', MESSAGES.expired, 410),
  interrupted: () => new AppError('JOB_INTERRUPTED', MESSAGES.interrupted, 500),
  starting: () => new AppError('SERVICE_UNAVAILABLE', MESSAGES.starting, 503),
  misconfigured: () => new AppError('SERVICE_UNAVAILABLE', MESSAGES.misconfigured, 503),
  invalidInstrument: () => new AppError('INVALID_INSTRUMENT', 'Unsupported instrument.', 400),
  invalidTimeframe: () => new AppError('INVALID_TIMEFRAME', 'Unsupported timeframe.', 400),
  invalidDate: (field) => new AppError('INVALID_DATE', `${field} must be a valid date in YYYY-MM-DD format.`, 400),
  invalidRequest: (msg = 'Invalid request.') => new AppError('INVALID_REQUEST', msg, 400),
  rangeTooLarge: (maxDays) =>
    new AppError('RANGE_TOO_LARGE', `The requested range is too large. Please request at most ${maxDays} days at a time.`, 400),
  beforeMinDate: (year) =>
    new AppError('DATE_TOO_EARLY', `Data is only available from ${year}-01-01 onwards.`, 400),
  notFound: () => new AppError('NOT_FOUND', 'Not found.', 404),
  tooManyRequests: () => new AppError('RATE_LIMITED', 'Too many requests. Please slow down.', 429),
};

/** Internal: the source (OANDA) does not yet hold complete data for a day. Retry later. */
export class DataNotReadyError extends Error {
  constructor(message, day) {
    super(message);
    this.name = 'DataNotReadyError';
    this.day = day;
  }
}

/** Internal: a dataset could not be built or verified. */
export class DatasetBuildError extends Error {
  constructor(message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'DatasetBuildError';
  }
}

/** Internal: binary dataset is malformed / truncated / wrong identity / hash mismatch. */
export class FormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FormatError';
  }
}

/** Internal: work stopped because the lock was lost or the process is shutting down. */
export class AbortedError extends Error {
  constructor(message = 'aborted') {
    super(message);
    this.name = 'AbortedError';
  }
}

export class OandaError extends Error {
  constructor(message, { status = null, retryable = false } = {}) {
    super(message);
    this.name = 'OandaError';
    this.status = status;
    this.retryable = retryable;
  }
}
