import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ignoreClosedLogPipe } from "./installCrashHandlers.js";

function streamError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`write ${code}`), { code, syscall: "write" });
}

describe("ignoreClosedLogPipe", () => {
  it("drops a write to a log pipe that has been closed", () => {
    const logStream = new PassThrough();
    ignoreClosedLogPipe(logStream);
    expect(() => logStream.emit("error", streamError("EPIPE"))).not.toThrow();
  });

  it("still throws any other stream error, so the crash handler reports it", () => {
    const logStream = new PassThrough();
    ignoreClosedLogPipe(logStream);
    expect(() => logStream.emit("error", streamError("EBADF"))).toThrow("write EBADF");
  });
});
