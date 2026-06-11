import { afterEach, describe, expect, it, vi } from "vitest";

import { deriveWsUrl, fetchBootstrap } from "@/lib/bootstrap";

describe("bootstrap helpers", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("prefers the server-provided websocket URL without appending a token", () => {
    // claudebot has no auth token — deriveWsUrl ignores the token parameter.
    expect(deriveWsUrl("/", "tok en", "ws://127.0.0.1:18790/")).toBe(
      "ws://127.0.0.1:18790/",
    );
  });

  it("falls back to the current window host without appending a token", () => {
    expect(deriveWsUrl("/", "tok")).toBe(
      "ws://localhost:3000/",
    );
  });

  it("times out when the bootstrap endpoint never responds", async () => {
    vi.useFakeTimers();
    // Mock fetch that listens to the abort signal so controller.abort() rejects.
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      }),
    ));

    const pending = expect(fetchBootstrap("", "", 25)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(25);

    await pending;
  });
});
