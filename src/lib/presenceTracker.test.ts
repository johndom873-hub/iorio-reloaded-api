import { beforeEach, describe, expect, it, vi } from "vitest";

describe("presenceTracker", () => {
  let presence: typeof import("./presenceTracker.js");

  beforeEach(async () => {
    // The tracker keeps module-level state; a fresh module per test keeps tests independent.
    vi.resetModules();
    presence = await import("./presenceTracker.js");
  });

  it("starts with nobody online and no connections", () => {
    expect(presence.onlineUserIds()).toEqual([]);
    expect(presence.totalConnectionCount()).toBe(0);
  });

  it("returns the online users after each connect, in first-connection order", () => {
    expect(presence.connect("alice")).toEqual(["alice"]);
    expect(presence.connect("bob")).toEqual(["alice", "bob"]);
  });

  it("counts a second tab of the same user as a connection but not as another user", () => {
    presence.connect("alice");
    presence.connect("alice");
    expect(presence.onlineUserIds()).toEqual(["alice"]);
    expect(presence.totalConnectionCount()).toBe(2);
  });

  it("keeps a user online until their last connection closes", () => {
    presence.connect("alice");
    presence.connect("alice");
    expect(presence.disconnect("alice")).toEqual(["alice"]);
    expect(presence.totalConnectionCount()).toBe(1);
    expect(presence.disconnect("alice")).toEqual([]);
    expect(presence.totalConnectionCount()).toBe(0);
  });

  it("ignores a disconnect for a user who is not connected", () => {
    presence.connect("alice");
    expect(presence.disconnect("ghost")).toEqual(["alice"]);
    expect(presence.totalConnectionCount()).toBe(1);
  });

  it("does not go negative after surplus disconnects", () => {
    presence.connect("alice");
    presence.disconnect("alice");
    presence.disconnect("alice");
    presence.connect("alice");
    expect(presence.totalConnectionCount()).toBe(1);
  });
});
