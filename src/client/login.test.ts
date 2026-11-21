import { describe, expect, test } from "bun:test";
import type { Client } from "./client";
import { loginWithRetry } from "./login";

const fakeClient = (failTimes: number) => {
  let calls = 0;
  const c = {
    aborted: false,
    async login() {
      calls += 1;
      if (calls <= failTimes) throw new Error("ログインに失敗しました");
    },
    get calls() {
      return calls;
    },
  };
  return c;
};

describe("loginWithRetry", () => {
  test("二重ログインで断られても、待てる間はやり直して通る", async () => {
    const c = fakeClient(2);
    const retries: number[] = [];
    const r = await loginWithRetry(c as unknown as Client, { waitMs: 5000, intervalMs: 10, onRetry: ({ attempt }) => retries.push(attempt) });
    expect(r.attempts).toBe(3);
    expect(retries).toEqual([1, 2]);
  });

  test("待てる時間を過ぎたら最後のエラーを投げる", async () => {
    const c = fakeClient(100);
    await expect(loginWithRetry(c as unknown as Client, { waitMs: 30, intervalMs: 10 })).rejects.toThrow("ログインに失敗しました");
    expect(c.calls).toBeGreaterThanOrEqual(2);
  });

  test("停止されたら待たずに抜ける", async () => {
    const c = fakeClient(100);
    let stop = false;
    const p = loginWithRetry(c as unknown as Client, { waitMs: 60_000, intervalMs: 5000, shouldStop: () => stop, onRetry: () => (stop = true) });
    await expect(p).rejects.toThrow("停止ボタン");
    expect(c.calls).toBe(1);
  });
});
