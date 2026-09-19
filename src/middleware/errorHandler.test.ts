import { describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { errorHandler } from "./errorHandler.js";

function fakeResponse(headersSent: boolean) {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  return { response: { headersSent, status } as unknown as Response, status, json };
}

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
});
