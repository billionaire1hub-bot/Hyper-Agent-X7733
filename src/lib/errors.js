export class AppError extends Error {
  constructor(message, { status = 500, code = "INTERNAL_ERROR", details, retryable = false, cause } = {}) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryable = retryable;
    this.cause = cause;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.details !== undefined ? { details: this.details } : {}),
      ...(this.retryable ? { retryable: true } : {}),
    };
  }

  static badRequest(message, details, code = "INVALID_REQUEST") {
    return new AppError(message, { status: 400, code, details });
  }

  static unauthorized(message = "Unauthorized", code = "UNAUTHORIZED") {
    return new AppError(message, { status: 401, code });
  }

  static paymentRequired(message, details, code = "PAYMENT_REQUIRED") {
    return new AppError(message, { status: 402, code, details });
  }

  static forbidden(message, details, code = "FORBIDDEN") {
    return new AppError(message, { status: 403, code, details });
  }

  static notFound(message, code = "NOT_FOUND") {
    return new AppError(message, { status: 404, code });
  }

  static conflict(message, details, code = "CONFLICT") {
    return new AppError(message, { status: 409, code, details });
  }

  static unavailable(message, details, code = "SERVICE_UNAVAILABLE") {
    return new AppError(message, { status: 503, code, details, retryable: true });
  }

  static upstream(message, details, code = "UPSTREAM_ERROR", cause) {
    return new AppError(message, { status: 502, code, details, retryable: true, cause });
  }

  static timeout(message, details, code = "TIMEOUT") {
    return new AppError(message, { status: 504, code, details, retryable: true });
  }
}

export const asAppError = (error, fallbackMessage = "Unexpected error") => {
  if (error instanceof AppError) return error;
  const message = error instanceof Error ? error.message : fallbackMessage;
  return new AppError(message, { status: 500, code: "INTERNAL_ERROR", cause: error });
};
