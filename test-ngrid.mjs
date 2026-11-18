/**
 * Tests for the National Grid price parsing and VTOU periods. Run: npm test
 */

import { parseSupplyRows, parseDeliveryRates, vtouPeriod, priceAt } from "./ngrid.mjs";
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

// As the supply API returned it for Central / SC1V on 2026-11-17.
const SUPPLY_JSON = {
  totalRecords: 3,
  data: [
    { zoneName: "Central      ", serviceClassName: "SC1 Vol TOU Off Peak", effectiveDate: "17-11-2026", price: 0.046 },
    { zoneName: "Central      ", serviceClassName: "SC1 Vol TOU Super Peak", effectiveDate: "17-11-2026", price: 0.0 },
    { zoneName: "Central      ", serviceClassName: "SC1 Vol TOU On Peak", effectiveDate: "17-11-2026", price: 0.07573 },
  ],
};

// The Service Rates page's VTOU block, in its real markup shape, with the
// SC-1 standard block before it so a stray number would be caught.
const SERVICE_RATES_HTML = `
<h3>Residential (SC-1)</h3><table><tr><td>Delivery Charge (per kWh)</td><td>10.013&cent;</td></tr></table>
<h3> Residential Voluntary Time of Use (SC-1 VTOU) </h3>
<p>Rates Components for SC1-VTOU</p><p>All Load Zones</p>
<table>
<tr><td>Basic Service Charge<sup>(1)</sup></td><td>$19.00 per month</td></tr>
<tr><td>Incremental Customer Charge (per kWh)</td><td>$4.42 per month</td></tr>
<tr><td>On Peak/ Super Peak Delivery Charge (per kWh)&nbsp;</td><td>12.633¢</td></tr>
<tr><td>Off Peak Delivery Charge (per kWh)&nbsp;</td><td>1.299¢</td></tr>
<tr><td>Legacy Transition Charge (LTC) (per kWh)</td><td>Applicable prices located on ...</td></tr>
</table>
<h3>SC-1C</h3><table><tr><td>Delivery Charge (per kWh)</td><td>4.452&cent;</td></tr></table>`;

const close = (a, b) => Math.abs(a - b) < 1e-9;

test("supply: reads off, on and super-peak; a 0 super-peak means out of season", () => {
  const s = parseSupplyRows(SUPPLY_JSON, "2026-11-17");
  assert.equal(s.offPeak, 0.046);
  assert.equal(s.onPeak, 0.07573);
  assert.equal(s.superPeak, null);
  assert.equal(s.day, "2026-11-17");
});

test("supply: an unpublished day (no rows) is an error, not zeros", () => {
  assert.throws(() => parseSupplyRows({ totalRecords: 0, data: null }, "2026-11-18"), /no supply prices/);
});

test("delivery: reads the VTOU block, not the classes around it", () => {
  const d = parseDeliveryRates(SERVICE_RATES_HTML);
  assert.ok(close(d.onPeak, 0.12633));
  assert.ok(close(d.offPeak, 0.01299));
});

test("delivery: a page without the VTOU block fails loudly", () => {
  assert.throws(() => parseDeliveryRates("<p>Residential (SC-1) 10.013¢</p>"), /no SC-1 VTOU block/);
});

const at = (m, d, h, min = 0) => new Date(2026, m - 1, d, h, min);

test("periods: off-peak 23:00-07:00 every day", () => {
  assert.equal(vtouPeriod(at(11, 18, 23)), "offPeak");
  assert.equal(vtouPeriod(at(11, 19, 3)), "offPeak");
  assert.equal(vtouPeriod(at(11, 19, 6, 59)), "offPeak");
  assert.equal(vtouPeriod(at(11, 19, 7)), "onPeak");
  assert.equal(vtouPeriod(at(11, 21, 15)), "onPeak", "weekends are on-peak by day too");
});

test("periods: super-peak is 14-18 on June-August weekdays, not July 4th", () => {
  assert.equal(vtouPeriod(at(7, 15, 15)), "superPeak"); // Wednesday
  assert.equal(vtouPeriod(at(7, 18, 15)), "onPeak"); // Saturday
  assert.equal(vtouPeriod(at(7, 15, 18)), "onPeak");
  assert.equal(vtouPeriod(at(9, 15, 15)), "onPeak"); // September
  assert.equal(vtouPeriod(new Date(2025, 6, 4, 15)), "onPeak"); // Friday July 4th 2025
});

test("price: supply + delivery for the hour's period", () => {
  const supply = parseSupplyRows(SUPPLY_JSON, "2026-11-17");
  const delivery = parseDeliveryRates(SERVICE_RATES_HTML);
  assert.ok(close(priceAt(at(11, 19, 3), supply, delivery).total, 0.046 + 0.01299));
  assert.ok(close(priceAt(at(11, 19, 12), supply, delivery).total, 0.07573 + 0.12633));
  // Super-peak hour with no super-peak supply price -> on-peak supply.
  assert.ok(close(priceAt(at(7, 15, 15), supply, delivery).total, 0.07573 + 0.12633));
  assert.equal(priceAt(at(11, 19, 3), null, delivery), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
