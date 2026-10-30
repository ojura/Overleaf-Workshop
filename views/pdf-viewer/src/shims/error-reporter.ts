// Stands in for Overleaf's infrastructure/error-reporter, which sends errors to Overleaf's
// Sentry. The viewer of the extension reports to its own console instead.
export function captureException(error: unknown, context?: unknown) {
    console.warn('pdf viewer:', error, context ?? '');
}
