// CI check: the widget file must parse as an async function body (how
// Scriptable executes it), and the score/break-point derivations must
// behave per the Score schema in the Live Tennis API OpenAPI spec.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const src = readFileSync(new URL("../live-tennis.js", import.meta.url), "utf8");

// 1. Syntax: Scriptable runs the file with top-level await available.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
new AsyncFunction(src);

// 2. Derivation logic, extracted between its section markers.
const start = src.indexOf("function scoreView");
const end = src.indexOf("// ---------- widget rendering");
assert.ok(start > 0 && end > start, "derivation section markers present");
const { scoreView, isBreakPoint } = new Function(
  `${src.slice(start, end)}; return { scoreView, isBreakPoint };`
)();

// Receiver at 40 vs server below 40 -> BP.
let v = scoreView({ sets: [1, 0], games: [[6, 4], [4, 3]], points: ["30", "40"], server: 1, is_tiebreak: false });
assert.deepEqual(v.curGames, [4, 3]);
assert.deepEqual(v.sets, [1, 0]);
assert.equal(isBreakPoint(v), true);

// Receiver AD -> BP.
v = scoreView({ sets: [0, 0], games: [[2], [3]], points: ["40", "AD"], server: 1, is_tiebreak: false });
assert.equal(isBreakPoint(v), true);

// Server AD -> not BP.
v = scoreView({ sets: [0, 0], games: [[2], [3]], points: ["AD", "40"], server: 1, is_tiebreak: false });
assert.equal(isBreakPoint(v), false);

// Deuce -> not BP.
v = scoreView({ sets: [0, 0], games: [[2], [3]], points: ["40", "40"], server: 1, is_tiebreak: false });
assert.equal(isBreakPoint(v), false);

// Tiebreak -> never BP.
v = scoreView({ sets: [1, 1], games: [[6, 6, 6], [4, 7, 6]], points: ["6", "5"], server: 2, is_tiebreak: true });
assert.equal(isBreakPoint(v), false);

// server=2 means p1 receives.
v = scoreView({ sets: [0, 1], games: [[3], [4]], points: ["40", "15"], server: 2, is_tiebreak: false });
assert.equal(isBreakPoint(v), true);

// Null points, null server, empty games arrays are real feed states.
v = scoreView({ sets: [2, 1], games: [[], []], points: [null, null], server: null, is_tiebreak: false });
assert.equal(isBreakPoint(v), false);
assert.deepEqual(v.curGames, [null, null]);

// Null score object (upcoming matches).
assert.equal(scoreView(null), null);
assert.equal(isBreakPoint(null), false);

console.log("check.mjs: syntax + derivation tests pass");
