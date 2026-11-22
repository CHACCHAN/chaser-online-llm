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

test("fresh adjacent put beats a collection plan; absent enemy lets the plan beat metal", () => {
  const map = new WorldMap();
  map.applyObservation("CMD1", "gr", [12, 2000, 12, 77, 1000, 2, 12, 12, 12], 7);
  const plan = { target: [1, 0] as [number, number] };
  expect(decideTurnAction(map, "CMD1", 7, plan).command).toBe("gr");
  // Opposite landing is an abyss; clockwise put lands on soil.
  expect(decideTurnAction(map, "CMD2", 7, plan).command).toBe("pu3su");
  map.applyObservation("CMD1", "gr", [12, 12, 12, 77, 1000, 2, 12, 12, 12], 8);
  expect(decideTurnAction(map, "CMD2", 8, plan).command).toBe("wr");
});

test("pursue a fresh enemy five squares away over the collection plan but not stale sightings", () => {
  const map = new WorldMap();
  map.setGlobalGrid([[77, 1000, 2, 2, 2, 2, 2000]], [1, 0], null, 7, 1000);
  const plan = { target: [-1, 0] as [number, number] };
  expect(decideTurnAction(map, "CMD1", 8, plan).command).toBe("grr");
  expect(decideTurnAction(map, "CMD1", 9, plan).command).toBe("grl");
});

test("a portal center suppresses old local routes even when no warp was detected", () => {
  const map = new WorldMap();
  map.applyObservation("CMD1", "gr", [0, 2, 4, 0, 22, 4, 0, 0, 4], 1474);
  expect(map.getLastEventFlags().warped).toBe(false);
  const decision = decideTurnAction(map, "CMD2", 1474, { target: [0, -1] });
  expect(decision.command).toMatch(/^d[udlr]$/);
  expect(decision.triggerReason).toBe("PORTAL_POSITION_UNCONFIRMED");
});

test("plans can end at portals, but cannot route through them", () => {
  const map = new WorldMap();
  const wall = [12, 12, 12, 12, 12];
  map.setGlobalGrid([wall, [12, 0, 21, 77, 12], [12, 2, 2, 2, 12], wall], [1, 1]);
  expect(decideTurnAction(map, "CMD1", 2, { target: [2, 0] }).command).toBe("grd");
  expect(decideTurnAction(map, "CMD1", 2, { target: [1, 0] }).command).toBe("grr");
});

test("an unknown cardinal or knight landing does not justify moving while boxed in", () => {
  const map = new WorldMap();
  expect(decideTurnAction(map, "CMD1", 1).command).toBe("gr");
  expect(decideTurnAction(map, "CMD2", 1, { target: [1, 0] }).command).toMatch(/^d[udlr]$/);
});

test("favor a safe onward pickup over a slightly better isolated pickup", () => {
  const map = new WorldMap();
  const wall = [12, 12, 12, 12, 12];
  map.setGlobalGrid([wall, [12, 3, 0, 2, 77], wall], [2, 1]);
  expect(decideTurnAction(map, "CMD1", 2).command).toBe("grr");
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
