/**
 * Tests for the date-based blind holds. Run: npm test
 */

import { holdOpenReason } from "./blind-holds.mjs";
import assert from "node:assert/strict";

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message.split("\n").join("\n      ")}`);
  }
}

// Local-time constructor, matching how the service reads the Pi's clock.
const at = (y, m, d, h = 18) => new Date(y, m - 1, d, h, 0, 0);

console.log("\nblind holds\n");

test("Living Room Center and Right are held on Halloween evening", () => {
  assert.equal(holdOpenReason("Living Room Center", at(2026, 10, 31)), "Halloween");
  assert.equal(holdOpenReason("Living Room Right", at(2026, 10, 31)), "Halloween");
});

test("the hold repeats every year", () => {
  assert.equal(holdOpenReason("Living Room Center", at(2027, 10, 31)), "Halloween");
  assert.equal(holdOpenReason("Living Room Right", at(2031, 10, 31, 23)), "Halloween");
});

test("Living Room Left and other blinds still close on Halloween", () => {
  for (const name of ["Living Room Left", "Dining Room Center", "Kitchen Right", "Bedroom Center"]) {
    assert.equal(holdOpenReason(name, at(2026, 10, 31)), null, name);
  }
});

test("no hold the day before or after", () => {
  assert.equal(holdOpenReason("Living Room Center", at(2026, 10, 30)), null);
  assert.equal(holdOpenReason("Living Room Right", at(2026, 11, 1, 0)), null);
});

test("name match is case-insensitive substring, like CLOSE_ORDER", () => {
  assert.equal(holdOpenReason("living room right blind", at(2026, 10, 31)), "Halloween");
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
