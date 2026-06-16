import { describe, expect, test } from "bun:test";
import { createAsyncInputQueue } from "./input-queue.ts";

describe("createAsyncInputQueue", () => {
  test("yields pushed values in order", async () => {
    const queue = createAsyncInputQueue<number>();
    queue.push(1);
    queue.push(2);
    queue.close();

    const values: number[] = [];
    for await (const value of queue.iterable) values.push(value);

    expect(values).toEqual([1, 2]);
  });

  test("throws queued failure to consumer", async () => {
    const queue = createAsyncInputQueue<number>();
    queue.fail(new Error("boom"));

    await expect(async () => {
      for await (const _value of queue.iterable) {
        // consume until failure
      }
    }).toThrow("boom");
  });
});
