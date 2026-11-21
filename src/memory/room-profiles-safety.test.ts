import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOM_PROFILES_PATH } from "../paths";
import { getRoomProfile, loadRoomProfiles, saveRoomProfile } from "./knowledge-store";

describe("room-profiles.json が壊れても記録を失わない", () => {
  test("壊れたら控えを残し、前に読めた中身で続け、次の保存で直る", () => {
    saveRoomProfile({ ...getRoomProfile(99901), highScore: 1234 });
    saveRoomProfile({ ...getRoomProfile(99902), highScore: 55 });
    expect(loadRoomProfiles().rooms["99901"]?.highScore).toBe(1234);

    writeFileSync(ROOM_PROFILES_PATH, '{"version":1,"rooms":{"99901":', "utf-8"); // 書きかけ
    expect(loadRoomProfiles().rooms["99901"]?.highScore).toBe(1234);
    const dir = path.dirname(ROOM_PROFILES_PATH);
    expect(readdirSync(dir).some((f) => f.startsWith("room-profiles.json.broken-"))).toBe(true);

    saveRoomProfile({ ...getRoomProfile(99903), highScore: 7 });
    const after = JSON.parse(readFileSync(ROOM_PROFILES_PATH, "utf-8"));
    expect(after.rooms["99901"].highScore).toBe(1234);
    expect(after.rooms["99902"].highScore).toBe(55);
    expect(after.rooms["99903"].highScore).toBe(7);
    // 一時ファイルは残らない
    expect(readdirSync(dir).some((f) => f.includes(".tmp-"))).toBe(false);
  });
});
