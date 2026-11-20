import { expect, test } from "bun:test";
import { CMD2_SPECS, WorldMap } from "../memory/world-map";
import { decideTurnAction } from "./active-solver";

test("prefer observing the open side of an abyss line unless a safe plan says otherwise", () => {
  const map = new WorldMap();
  // Discover the southern abyss at x=0..2, then approach its unseen extension from the north.
  for (const cmd of ["wr", "wd", "wu", "wu", "wl", "wl", "wd"] as const) {
    const [x, y] = map.getPosition();
    const [dx, dy] = CMD2_SPECS[cmd].move;
    const view = Array.from({ length: 9 }, (_, i) =>
      y + dy + Math.floor(i / 3) - 1 === 2 && x + dx + i % 3 - 1 >= 0 ? 12 : 0);
    map.applyObservation("CMD2", cmd, view, 1);
  }
  expect(map.getPosition()).toEqual([-1, 0]);
  expect(map.getTile(-1, 2)).toBeUndefined(); // hypothesis, not an observed hazard
  expect(decideTurnAction(map, "CMD1", 2).command).toBe("grl");
  expect(decideTurnAction(map, "CMD2", 2).command).toBe("wl");
  expect(decideTurnAction(map, "CMD2", 2, { target: [-1, 1] }).command).toBe("wd");
});

test("a previously visited hole is still better than staying when it is the only exit", () => {
  const map = new WorldMap();
  const wall = [12, 12, 12, 12, 12];
  map.setGlobalGrid([wall, [12, 0, 0, 0, 12], wall], [1, 1]);
  for (const right of [0, 12]) {
    map.applyObservation("CMD2", "wr", [12, 12, 12, 0, 0, right, 12, 12, 12], 1);
  }
  expect(map.getTile(1, 0)?.visitedCount).toBe(1);
  expect(decideTurnAction(map, "CMD1", 2).command).toBe("grl");
});
