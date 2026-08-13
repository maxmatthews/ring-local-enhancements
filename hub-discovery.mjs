/**
 * mDNS discovery for the IKEA Dirigera hub.
 *
 * The dirigera package ships its own discoverGatewayIP, but it resolves on the
 * first address record in the first response packet -- which in practice is
 * often the hub's IPv6 ULA rather than its IPv4 address. Everything else here
 * (the .env hint, the DHCP reservation) is IPv4, so this collects answers over
 * a short window and prefers the A record, falling back to the ipv4address
 * field the hub publishes in TXT, and only then to IPv6.
 *
 * Records for other services on the LAN share these response packets, so
 * addresses are only accepted after correlating PTR -> SRV target -> A/AAAA.
 */

import { createRequire } from "module";

const require = createRequire(import.meta.url);

const SERVICE = "_ihsp._tcp.local";

// Decodes the Buffer-per-entry shape mdns-server hands back for TXT records
// into a plain { key: value } map.
function parseTxt(data) {
  const out = {};
  for (const entry of Array.isArray(data) ? data : []) {
    const s = Buffer.isBuffer(entry) ? entry.toString("utf8") : Buffer.from(entry?.data || []).toString("utf8");
    const eq = s.indexOf("=");
    if (eq > 0) out[s.slice(0, eq)] = s.slice(eq + 1);
  }
  return out;
}

const normalize = (name) => String(name || "").replace(/\.$/, "");

// Pulls a usable hub address out of everything seen so far, or null.
// `requireIpv4` gates the early-exit: we keep listening for an A record until
// the window closes, then accept the best of what arrived.
function resolveFrom(records, requireIpv4) {
  const of = (type) => records.filter((r) => r.type === type);

  const instances = of("PTR")
    .filter((r) => normalize(r.name) === SERVICE)
    .map((r) => normalize(r.data));
  if (!instances.length) return null;

  for (const instance of instances) {
    const srv = of("SRV").find((r) => normalize(r.name) === instance);
    const target = srv ? normalize(srv.data?.target) : null;

    if (target) {
      const a = of("A").find((r) => normalize(r.name) === target);
      if (a?.data) return { ip: a.data, hostname: target, via: "A record" };
    }

    // The hub repeats its IPv4 in TXT, which is just as authoritative and
    // often arrives before the A record does.
    const txt = of("TXT").find((r) => normalize(r.name) === instance);
    const advertised = txt ? parseTxt(txt.data)["ipv4address"] : null;
    if (advertised) return { ip: advertised, hostname: target || instance, via: "TXT ipv4address" };

    if (requireIpv4) continue;

    if (target) {
      const aaaa = of("AAAA").find((r) => normalize(r.name) === target);
      // The client builds a URL from this, so IPv6 needs brackets.
      if (aaaa?.data) return { ip: `[${aaaa.data}]`, hostname: target, via: "AAAA record" };
    }
  }
  return null;
}

/**
 * Queries the LAN for the Dirigera hub.
 * Resolves { ip, hostname, via }; rejects if nothing answers in time.
 */
export function discoverDirigeraHost({ timeoutMs = 10000 } = {}) {
  const createMdnsServer = require("mdns-server");
  const mdns = createMdnsServer({ reuseAddr: true, loopback: false, noInit: true });

  return new Promise((resolve, reject) => {
    const records = [];
    let done = false;

    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        mdns.destroy();
      } catch (_) {}
      fn(arg);
    };

    // Window expiry is a normal outcome, not a failure: take the best address
    // seen, including IPv6, before giving up entirely.
    const timer = setTimeout(() => {
      const found = resolveFrom(records, false);
      if (found) finish(resolve, found);
      else
        finish(
          reject,
          new Error(`no Dirigera hub answered ${SERVICE} within ${timeoutMs}ms`)
        );
    }, timeoutMs);

    mdns.on("response", (response) => {
      records.push(...(response.answers || []), ...(response.additionals || []));
      const found = resolveFrom(records, true); // hold out for IPv4
      if (found) finish(resolve, found);
    });

    mdns.on("error", (err) => finish(reject, err));

    mdns.on("ready", () => {
      mdns.query([
        { name: SERVICE, type: "PTR" },
        { name: SERVICE, type: "SRV" },
        { name: SERVICE, type: "TXT" },
      ]);
    });

    try {
      mdns.initServer();
    } catch (err) {
      finish(reject, err);
    }
  });
}
