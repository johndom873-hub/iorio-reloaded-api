import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { errorHandler } from "./errorHandler.js";

function fakeResponse(headersSent: boolean) {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  return { response: { headersSent, status } as unknown as Response, status, json };
}

afterEach(() => vi.restoreAllMocks());

describe("errorHandler", () => {
  it("answers 500 with a friendly message when nothing has been sent yet", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { response, status, json } = fakeResponse(false);
    const next = vi.fn() as unknown as NextFunction;

    errorHandler(new Error("boom"), {} as Request, response, next);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ error: "Something went wrong. Please try again." });
    expect(next).not.toHaveBeenCalled();
  });

  it.each([
    [413, "Request body is too large."],
    [400, "Invalid request."],
    [431, "Invalid request."],
  ])("answers a body-parser style client error with its own %i, not a server error, and does not log it", (status, message) => {
    const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { response, status: statusSpy, json } = fakeResponse(false);
    errorHandler(Object.assign(new Error("request entity too large: secret internals"), { status }), {} as Request, response, vi.fn() as unknown as NextFunction);
    expect(statusSpy).toHaveBeenCalledWith(status);
    expect(json).toHaveBeenCalledWith({ error: message });
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("reads the status from statusCode too", () => {
    const { response, status } = fakeResponse(false);
    errorHandler(Object.assign(new Error("x"), { statusCode: 413 }), {} as Request, response, vi.fn() as unknown as NextFunction);
    expect(status).toHaveBeenCalledWith(413);
  });

  it.each([200, 302, 500, 503, 399, 600, 413.5, "413", null, undefined])("does not treat status %s as a client error", (candidate) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { response, status } = fakeResponse(false);
    errorHandler(Object.assign(new Error("x"), { status: candidate }), {} as Request, response, vi.fn() as unknown as NextFunction);
    expect(status).toHaveBeenCalledWith(500);
  });

  it("delegates to Express instead of writing again when headers were already sent", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { response, status, json } = fakeResponse(true);
    const next = vi.fn() as unknown as NextFunction;
    const failure = new Error("late failure");

    errorHandler(failure, {} as Request, response, next);

    expect(status).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(failure);
  });

  it("answers 404 instead of a server error for a malformed uuid (Postgres code 22P02) and does not log it as a fault", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { response, status, json } = fakeResponse(false);
    const next = vi.fn() as unknown as NextFunction;

    errorHandler(Object.assign(new Error('invalid input syntax for type uuid: "x"'), { code: "22P02" }), {} as Request, response, next);

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({ error: "Not found." });
    expect(consoleError).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("treats every other error code as a server error", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { response, status, json } = fakeResponse(false);

    errorHandler(Object.assign(new Error("deadlock"), { code: "40P01" }), {} as Request, response, vi.fn() as unknown as NextFunction);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ error: "Something went wrong. Please try again." });
  });

  it("copes with things that are not Error objects (null, a string, a rejected plain value)", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const thrown of [null, undefined, "plain string", 42]) {
      const { response, status, json } = fakeResponse(false);
      errorHandler(thrown, {} as Request, response, vi.fn() as unknown as NextFunction);
      expect(status).toHaveBeenCalledWith(500);
      expect(json).toHaveBeenCalledWith({ error: "Something went wrong. Please try again." });
    }
  });

  it("logs the real error server-side but never puts its message or stack in the response", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { response, json } = fakeResponse(false);
    const failure = new Error("connect ECONNREFUSED 10.0.0.5:5432");

    errorHandler(failure, {} as Request, response, vi.fn() as unknown as NextFunction);

    expect(consoleError).toHaveBeenCalledWith(failure);
    expect(JSON.stringify(json.mock.calls)).not.toMatch(/ECONNREFUSED|10\.0\.0\.5|at /);
  });

  it("logs the error even when it has to be handed to Express because headers were already sent", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { response } = fakeResponse(true);
    const failure = new Error("late failure");

    errorHandler(failure, {} as Request, response, vi.fn() as unknown as NextFunction);

    expect(consoleError).toHaveBeenCalledWith(failure);
  });
});
