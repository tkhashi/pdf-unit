import { describe, expect, it } from "vitest";
import { createPageBodyCache } from "./page-body-cache";
import type { PageBody } from "./pdf";

const body = (n: number): PageBody => ({
  bytes: new Uint8Array([n]),
  sha256: String(n),
});

describe("ページPDFの使い回し", () => {
  it("同時の要求でも1回だけ切り出し、直近 capacity 件を残す", async () => {
    const calls: number[] = [];
    const get = createPageBodyCache((n) => {
      calls.push(n);
      return Promise.resolve(body(n));
    }, 2);
    const [a, b] = [get(1), get(1)];
    expect(a).toBe(b);
    await get(2);
    await get(1); // 1 を最近使ったものにする
    await get(3); // 2 が追い出される
    await get(1);
    await get(2);
    expect(calls).toEqual([1, 2, 3, 2]);
  });

  it("失敗した切り出しは残さない", async () => {
    let fail = true;
    const get = createPageBodyCache((n) => {
      if (fail) {
        fail = false;
        return Promise.reject(new Error("x"));
      }
      return Promise.resolve(body(n));
    }, 2);
    await expect(get(1)).rejects.toThrow("x");
    await expect(get(1)).resolves.toEqual(body(1));
  });
});
