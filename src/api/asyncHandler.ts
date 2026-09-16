import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Wraps an async Express route handler so a rejected promise reaches
 * Express's error-handling middleware via next(err), instead of becoming an
 * unhandled promise rejection.
 *
 * Express 4 (the version pinned in package.json) does not do this for you:
 * it only catches *synchronous* throws inside a handler. An async handler
 * that awaits a rejected promise — a Postgres error, a Redis error, a
 * downstream "Unknown order" throw from SagaOrchestrator — rejects silently
 * as far as Express is concerned. On Node, an unhandled promise rejection
 * terminates the process by default, so without this wrapper a single bad
 * request (e.g. a transient DB hiccup) can take the entire server down
 * instead of just failing that one request with a 500. (Express 5 fixes
 * this natively; this wrapper is the standard workaround for Express 4.)
 */
export function asyncHandler(handler: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}
