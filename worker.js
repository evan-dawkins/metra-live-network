// Metra live relay: fetches Metra's GTFS-realtime feeds, decodes the protobuf by hand,
// and returns clean JSON to the dashboard. No caching: every call hits Metra fresh.
// Secret required: METRA_API_TOKEN
//
//   /          -> live data for the dashboard
//   /?trips=1  -> the same, plus per-stop predictions from the tripupdates feed
//   /?peek=1   -> a readable sample of what Metra actually sends (for checking the data)
//   /?report=1 -> the same, plus today's report card (needs the REPORT KV binding and the 2-minute Cron Trigger)
//   /?runreport=1 -> run the report card check now and show the result (troubleshooting; at most once a minute)

function readVarint(b, p) { let r = 0, s = 1, byte; do { byte = b[p]; r += (byte & 0x7f) * s; s *= 128; p++; } while (byte & 0x80); return [r, p]; }
// int32/int64 fields (like a delay) can be negative; those need exact 64-bit maths
function readSigned(b, p) {
  let r = 0n, s = 0n, byte;
  do { byte = b[p]; r |= BigInt(byte & 0x7f) << s; s += 7n; p++; } while (byte & 0x80);
  if (r >= 1n << 63n) r -= 1n << 64n;
  return [Number(r), p];
}
function readFloat(b, p) { const dv = new DataView(b.buffer, b.byteOffset + p, 4); return [dv.getFloat32(0, true), p + 4]; }
function skip(b, p, wt) {
  if (wt === 0) return readVarint(b, p)[1];
  if (wt === 1) return p + 8;
  if (wt === 5) return p + 4;
  if (wt === 2) { const [len, p2] = readVarint(b, p); return p2 + len; }
  throw new Error("bad wiretype " + wt);
}
function readString(b, p) { const [len, p2] = readVarint(b, p); const s = new TextDecoder().decode(b.subarray(p2, p2 + len)); return [s, p2 + len]; }
function readSub(b, p) { const [len, p2] = readVarint(b, p); return [b.subarray(p2, p2 + len), p2 + len]; }

// Walk every field of a message: cb(fieldNumber, wireType, bytes, position) returns the new position
// (or undefined to have the field skipped).
function eachField(b, cb) {
  let p = 0;
  while (p < b.length) {
    const [tag, p1] = readVarint(b, p); p = p1;
    const f = tag >>> 3, wt = tag & 7;
    const np = cb(f, wt, b, p);
    p = np === undefined ? skip(b, p, wt) : np;
  }
}
// FeedMessage -> each entity's bytes
function eachEntity(buf, cb) {
  eachField(new Uint8Array(buf), (f, wt, b, p) => {
    if (f !== 2 || wt !== 2) return;
    const [ent, np] = readSub(b, p); cb(ent); return np;
  });
}
function feedTimestamp(buf) {
  let ts = null;
  eachField(new Uint8Array(buf), (f, wt, b, p) => {
    if (f !== 1 || wt !== 2) return;                         // FeedHeader
    const [h, np] = readSub(b, p);
    eachField(h, (hf, hwt, hb, hp) => { if (hf === 3 && hwt === 0) { const [v, n] = readVarint(hb, hp); ts = v; return n; } });
    return np;
  });
  return ts;
}

/* ------------------------------ shared small messages ------------------------------ */
function parseTripDescriptor(tb) {
  const t = { trip_id: null, route_id: null, direction_id: null, start_date: null, start_time: null, schedule_relationship: null };
  eachField(tb, (f, wt, b, p) => {
    if (f === 1 && wt === 2) { const [s, n] = readString(b, p); t.trip_id = s; return n; }
    if (f === 2 && wt === 2) { const [s, n] = readString(b, p); t.start_time = s; return n; }
    if (f === 3 && wt === 2) { const [s, n] = readString(b, p); t.start_date = s; return n; }
    if (f === 4 && wt === 0) { const [v, n] = readVarint(b, p); t.schedule_relationship = v; return n; }
    if (f === 5 && wt === 2) { const [s, n] = readString(b, p); t.route_id = s; return n; }
    if (f === 6 && wt === 0) { const [v, n] = readVarint(b, p); t.direction_id = v; return n; }
  });
  return t;
}
function parseVehicleDescriptor(vb) {
  const v = { id: null, label: null };
  eachField(vb, (f, wt, b, p) => {
    if (f === 1 && wt === 2) { const [s, n] = readString(b, p); v.id = s; return n; }
    if (f === 2 && wt === 2) { const [s, n] = readString(b, p); v.label = s; return n; }
  });
  return v;
}

/* ------------------------------------ vehicle positions ------------------------------------ */
function parseVehicles(buf) {
  const out = [];
  eachEntity(buf, ent => {
    let vehicleSub = null;
    eachField(ent, (f, wt, b, p) => { if (f === 4 && wt === 2) { const [v, n] = readSub(b, p); vehicleSub = v; return n; } });
    if (!vehicleSub) return;
    let trip = null, veh = { id: null, label: null }, lat = null, lon = null, ts = null;
    eachField(vehicleSub, (f, wt, b, p) => {
      if (f === 1 && wt === 2) { const [s, n] = readSub(b, p); trip = parseTripDescriptor(s); return n; }
      if (f === 8 && wt === 2) { const [s, n] = readSub(b, p); veh = parseVehicleDescriptor(s); return n; }
      if (f === 2 && wt === 2) {
        const [pb, n] = readSub(b, p);
        eachField(pb, (pf, pwt, pbb, pp) => {
          if (pf === 1 && pwt === 5) { const [x, m] = readFloat(pbb, pp); lat = x; return m; }
          if (pf === 2 && pwt === 5) { const [x, m] = readFloat(pbb, pp); lon = x; return m; }
        });
        return n;
      }
      if (f === 5 && wt === 0) { const [v, n] = readVarint(b, p); ts = v; return n; }
    });
    const route_id = trip && trip.route_id;
    if (lat != null && lon != null && route_id) out.push({
      route_id, trip_id: trip.trip_id, direction_id: trip.direction_id,
      latitude: lat, longitude: lon, updated_at: ts, vehicle_id: veh.id, veh_label: veh.label
    });
  });
  return out;
}

/* --------------------------------------- trip updates --------------------------------------- */
// TripUpdate: trip (1), stop_time_update (2), vehicle (3), timestamp (4), delay (5)
// StopTimeUpdate: stop_sequence (1), arrival (2), departure (3), stop_id (4), schedule_relationship (5)
// StopTimeEvent: delay (1), time (2), uncertainty (3)
function parseStopTimeEvent(eb) {
  const e = {};
  eachField(eb, (f, wt, b, p) => {
    if (f === 1 && wt === 0) { const [v, n] = readSigned(b, p); e.delay = v; return n; }
    if (f === 2 && wt === 0) { const [v, n] = readSigned(b, p); e.time = v; return n; }
    if (f === 3 && wt === 0) { const [v, n] = readSigned(b, p); e.uncertainty = v; return n; }
  });
  return e;
}
function parseTripUpdates(buf) {
  const out = [];
  eachEntity(buf, ent => {
    let id = "", tuBytes = null, deleted = false;
    eachField(ent, (f, wt, b, p) => {
      if (f === 1 && wt === 2) { const [s, n] = readString(b, p); id = s; return n; }
      if (f === 2 && wt === 0) { const [v, n] = readVarint(b, p); deleted = !!v; return n; }
      if (f === 3 && wt === 2) { const [s, n] = readSub(b, p); tuBytes = s; return n; }
    });
    if (!tuBytes || deleted) return;
    const tu = { entity_id: id, trip: null, vehicle: null, timestamp: null, delay: null, stops: [] };
    eachField(tuBytes, (f, wt, b, p) => {
      if (f === 1 && wt === 2) { const [s, n] = readSub(b, p); tu.trip = parseTripDescriptor(s); return n; }
      if (f === 3 && wt === 2) { const [s, n] = readSub(b, p); tu.vehicle = parseVehicleDescriptor(s); return n; }
      if (f === 4 && wt === 0) { const [v, n] = readVarint(b, p); tu.timestamp = v; return n; }
      if (f === 5 && wt === 0) { const [v, n] = readSigned(b, p); tu.delay = v; return n; }
      if (f === 2 && wt === 2) {
        const [sb, n] = readSub(b, p);
        const st = { stop_id: null, stop_sequence: null, arrival: null, departure: null, schedule_relationship: null };
        eachField(sb, (sf, swt, sbb, sp) => {
          if (sf === 1 && swt === 0) { const [v, m] = readVarint(sbb, sp); st.stop_sequence = v; return m; }
          if (sf === 4 && swt === 2) { const [s, m] = readString(sbb, sp); st.stop_id = s; return m; }
          if (sf === 2 && swt === 2) { const [e, m] = readSub(sbb, sp); st.arrival = parseStopTimeEvent(e); return m; }
          if (sf === 3 && swt === 2) { const [e, m] = readSub(sbb, sp); st.departure = parseStopTimeEvent(e); return m; }
          if (sf === 5 && swt === 0) { const [v, m] = readVarint(sbb, sp); st.schedule_relationship = v; return m; }
        });
        tu.stops.push(st);
        return n;
      }
    });
    if (tu.trip) out.push(tu);
  });
  return out;
}
// The dashboard only needs what's still ahead, in a compact shape.
function compactTrips(list, nowSec) {
  return list.map(tu => { const kept = tu.stops.filter(s => s.stop_id && s.schedule_relationship !== 1); return {
    trip_id: tu.trip.trip_id, route_id: tu.trip.route_id, direction_id: tu.trip.direction_id,
    canceled: tu.trip.schedule_relationship === 3 || undefined,
    vehicle_id: tu.vehicle && tu.vehicle.id, veh_label: tu.vehicle && tu.vehicle.label,
    updated_at: tu.timestamp,
    stops: kept                                                                // skipped stops (1) dropped
      .map(s => ({ id: s.stop_id, arr: s.arrival && s.arrival.time || undefined, dep: s.departure && s.departure.time || undefined,
                   delay: (s.arrival && s.arrival.delay) ?? (s.departure && s.departure.delay) ?? undefined }))
      .filter(s => (s.arr || s.dep || 0) >= nowSec - 120 || (!s.arr && !s.dep)),
    last_stop: kept.length ? kept[kept.length - 1].stop_id : undefined
  }; });
}

/* --------------------------------------- service alerts --------------------------------------- */
// Metra's alert text can contain HTML; send the dashboard plain text only.
function plainText(s) {
  return String(s || "")
    .replace(/<\s*br\s*\/?>/gi, "\n").replace(/<\/\s*(p|div|li)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
}
// GTFS-rt TranslatedString: prefer English, else the first translation.
function translated(b) {
  let first = null, en = null;
  eachField(b, (f, wt, bb, p) => {
    if (f !== 1 || wt !== 2) return;
    const [tb, np] = readSub(bb, p);
    let text = null, lang = "";
    eachField(tb, (tf, twt, tbb, tp) => {
      if (tf === 1 && twt === 2) { const [s, n] = readString(tbb, tp); text = s; return n; }
      if (tf === 2 && twt === 2) { const [s, n] = readString(tbb, tp); lang = s.toLowerCase(); return n; }
    });
    if (text != null) { if (first == null) first = text; if (!en && (lang === "" || lang.startsWith("en"))) en = text; }
    return np;
  });
  return en ?? first ?? "";
}
function parseAlerts(buf) {
  const out = [];
  eachEntity(buf, ent => {
    let id = "", alertBytes = null, deleted = false;
    eachField(ent, (ef, ewt, eb, ep) => {
      if (ef === 1 && ewt === 2) { const [s, n] = readString(eb, ep); id = s; return n; }
      if (ef === 2 && ewt === 0) { const [v, n] = readVarint(eb, ep); deleted = !!v; return n; }
      if (ef === 5 && ewt === 2) { const [a, n] = readSub(eb, ep); alertBytes = a; return n; }
    });
    if (!alertBytes || deleted) return;
    const a = { id, header: "", description: "", url: "", routes: [], stops: [], periods: [], cause: null, effect: null, severity: null };
    const routes = new Set(), stops = new Set();
    eachField(alertBytes, (af, awt, ab, ap) => {
      if (af === 1 && awt === 2) {                          // active_period
        const [tr, n] = readSub(ab, ap); const per = { start: null, end: null };
        eachField(tr, (tf, twt, tb, tp) => {
          if (tf === 1 && twt === 0) { const [v, m] = readVarint(tb, tp); per.start = v; return m; }
          if (tf === 2 && twt === 0) { const [v, m] = readVarint(tb, tp); per.end = v; return m; }
        });
        a.periods.push(per); return n;
      }
      if (af === 5 && awt === 2) {                          // informed_entity
        const [ie, n] = readSub(ab, ap);
        eachField(ie, (xf, xwt, xb, xp) => {
          if (xf === 2 && xwt === 2) { const [s, m] = readString(xb, xp); routes.add(s); return m; }
          if (xf === 5 && xwt === 2) { const [s, m] = readString(xb, xp); stops.add(s); return m; }
          if (xf === 4 && xwt === 2) {                      // trip -> its route_id
            const [tb, m] = readSub(xb, xp); const t = parseTripDescriptor(tb); if (t.route_id) routes.add(t.route_id);
            return m;
          }
        });
        return n;
      }
      if (af === 6 && awt === 0) { const [v, n] = readVarint(ab, ap); a.cause = v; return n; }
      if (af === 7 && awt === 0) { const [v, n] = readVarint(ab, ap); a.effect = v; return n; }
      if (af === 14 && awt === 0) { const [v, n] = readVarint(ab, ap); a.severity = v; return n; }
      if (af === 8 && awt === 2) { const [s, n] = readSub(ab, ap); a.url = translated(s); return n; }
      if (af === 10 && awt === 2) { const [s, n] = readSub(ab, ap); a.header = plainText(translated(s)); return n; }
      if (af === 11 && awt === 2) { const [s, n] = readSub(ab, ap); a.description = plainText(translated(s)); return n; }
    });
    a.routes = [...routes]; a.stops = [...stops];
    if (!/^https?:\/\//i.test(a.url)) a.url = "";
    if (a.header || a.description) out.push(a);
  });
  return out;
}

/* -------------------------------------- daily report card -------------------------------------- */
// Every 2 minutes (a Cron Trigger) the Worker notes each train's predicted arrival at its last stop.
// When the train finishes, that last prediction is compared with Metra's timetable (schedule.json,
// rebuilt nightly by a GitHub Action). Within 5:59 counts as on time, Metra's own rule.
// Backup: if Metra's arrival times are missing (or that feed is down), a train still counts once its
// own GPS reaches its last station, timed by that GPS report.
// Honesty: minutes when the times feed was down (or checks didn't run) are added up and shown.
// The day's tallies live in one KV key and start fresh at 3 AM Chicago time.
const SCHEDULE_URL = "https://evan-dawkins.github.io/metra-live-network/schedule.json";
const ON_TIME_SEC = 359, TZ = "America/Chicago", REPORT_KEY = "report";
const ARRIVED_KM = 0.45;                                    // GPS this close to the last station = arrived
const REPORT_V = 2;                                         // bump to start today's tallies over after a scoring fix

let chicagoFmt = null;                                      // built once: making these is slow
function chicago(ms) {
  chicagoFmt ||= new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const p = {}; for (const x of chicagoFmt.formatToParts(new Date(ms))) p[x.type] = x.value; return p;
}
function offsetMs(ms) {                                     // Chicago local time minus UTC, at that moment
  const p = chicago(ms);
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}
// GTFS times count from "noon minus 12 h" on the service date, and can run past 24:00.
const dayBase = new Map();
function scheduledEpoch(date, hms) {
  let base = dayBase.get(date);
  if (base == null) {
    const y = +date.slice(0, 4), mo = +date.slice(4, 6) - 1, d = +date.slice(6, 8), noonGuess = Date.UTC(y, mo, d, 12);
    base = Math.round((noonGuess - offsetMs(noonGuess)) / 1000) - 12 * 3600; dayBase.set(date, base);
  }
  const [h, m, sec] = hms.split(":").map(Number);
  return base + h * 3600 + m * 60 + sec;
}
function reportDay(ms) { const p = chicago(ms - 3 * 3600e3); return p.year + p.month + p.day; }   // the day rolls over at 3 AM
function km(aLat, aLon, bLat, bLon) {
  const r = Math.PI / 180, x = (bLon - aLon) * r * Math.cos((aLat + bLat) / 2 * r), y = (bLat - aLat) * r;
  return Math.hypot(x, y) * 6371;
}

let scheduleMemo = null, scheduleAt = 0;
async function loadSchedule() {
  if (scheduleMemo && Date.now() - scheduleAt < 3 * 3600e3) return scheduleMemo;
  const r = await fetch(SCHEDULE_URL, { cf: { cacheTtl: 3 * 3600, cacheEverything: true } });
  if (!r.ok) throw new Error(`Timetable (schedule.json) returned ${r.status}`);
  scheduleMemo = await r.json(); scheduleAt = Date.now(); return scheduleMemo;
}
function freshReport(day) {
  return { day, on: 0, late: 0, canceled: 0, gps: 0, by: {}, worst: null, active: {}, done: {}, downMs: 0, checked: 0, problem: "" };
}

// One step: fold the latest data into the day's tallies. Pure, so it can be tested on its own.
//   updates:  parsed trip updates, or null if that feed failed
//   vehicles: parsed vehicle positions, or null if that feed failed
function stepReport(st, updates, vehicles, sched, nowMs) {
  const nowSec = Math.floor(nowMs / 1000), day = reportDay(nowMs);
  if (!st || st.day !== day || st.v !== REPORT_V) { const prev = st && st.checked; st = freshReport(day); st.checked = prev || 0; }
  st.v = REPORT_V;
  st.gps ||= 0; st.downMs ||= 0;
  // honesty: time the times feed was down, or checks didn't happen (Cloudflare skipped runs)
  if (st.checked) {
    const gap = Math.min(nowMs - st.checked, 6 * 3600e3);
    if (!updates) st.downMs += gap; else if (gap > 6 * 60e3) st.downMs += gap - 2 * 60e3;
  }
  st.checked = nowMs;

  const line = r => (st.by[r] ||= [0, 0, 0]);                // [on time, late, canceled]
  const finish = (id, a, arrSec, byGps) => {
    const d = arrSec - a.s;
    if (Math.abs(d) <= 3 * 3600) {                          // more than 3 h off means a timetable mix-up: don't rate it
      const ok = d <= ON_TIME_SEC; ok ? st.on++ : st.late++; line(a.r)[ok ? 0 : 1]++;
      if (byGps) st.gps++;
      if (!ok && (!st.worst || d > st.worst.d)) st.worst = { r: a.r, n: a.n, d };
    }
    st.done[id] = 1; delete st.active[id];
  };
  const seen = new Set();
  const track = (id, r, n, date) => {                       // start following a trip the first time we meet it
    const sc = sched.trips[id];
    if (!sc || st.done[id]) return null;
    seen.add(id);
    return st.active[id] ||= { r, n, s: scheduledEpoch(date, sc[1]), p: 0, seen: nowSec };
  };

  for (const tu of updates || []) {
    const t = tu.trip || {}, id = t.trip_id;
    if (!id || !t.start_date || !sched.trips[id] || st.done[id]) continue;
    const r = t.route_id || "?";
    if (t.schedule_relationship === 3) { seen.add(id); st.canceled++; line(r)[2]++; st.done[id] = 1; delete st.active[id]; continue; }
    const a = track(id, r, (tu.vehicle && tu.vehicle.label) || "", t.start_date);
    if (!a) continue;
    const last = tu.stops.filter(x => x.stop_id === sched.trips[id][0] && x.schedule_relationship !== 1).pop();
    const p = last && ((last.arrival && last.arrival.time) || (last.departure && last.departure.time));
    if (p) { a.p = p; if (p - nowSec > 300) a.far = 1; }      // still well on its way per Metra's times
    a.seen = nowSec;
  }

  // GPS: keeps trains alive while the times feed is down, and marks arrival when a train reaches its last station
  const stops = sched.stops || {};
  for (const v of vehicles || []) {
    const id = v.trip_id, sc = id && sched.trips[id];
    if (!sc || st.done[id]) continue;
    const a = track(id, v.route_id || "?", v.veh_label || "", day);
    if (!a) continue;
    a.seen = nowSec;
    const at = stops[sc[0]], fix = +v.updated_at || 0;
    if (!at || !fix || nowSec - fix > 600) continue;
    const near = km(v.latitude, v.longitude, at[0], at[1]) < ARRIVED_KM;
    if (!near) { a.far = 1; continue; }
    // only a train we saw on its way counts by GPS; one already parked at its last stop arrived before we were watching
    if (a.far) {
      // pulled in: Metra's last prediction if it had one and it's close to the GPS time, otherwise the GPS time
      const usePred = a.p && Math.abs(a.p - fix) < 240;
      finish(id, a, usePred ? a.p : fix, !usePred);
    }
  }

  for (const [id, a] of Object.entries(st.active)) {
    const gone = !seen.has(id);
    if (a.p && (a.p <= nowSec - 180 || (gone && updates && a.p - nowSec < 600))) finish(id, a, a.p, false);   // arrived per Metra's times
    else if (gone && nowSec - a.seen > 1800) delete st.active[id];                                           // vanished long before arriving: not rated
  }
  return st;
}
function reportSummary(st) {
  if (!st) return null;
  return { day: st.day, on: st.on, late: st.late, canceled: st.canceled, by: st.by, worst: st.worst,
           running: Object.keys(st.active || {}).length, gps: st.gps || 0, down_min: Math.round((st.downMs || 0) / 60e3),
           checked: st.checked || 0, problem: st.problem || "", updated: st.checked || 0 };
}
async function updateReport(env) {
  if (!env.REPORT) throw new Error("No REPORT storage connected to the Worker");
  const headers = { Authorization: `Bearer ${env.METRA_API_TOKEN}` };
  const [tup, pos, sch, old] = await Promise.allSettled([getFeed("tripupdates", headers), getFeed("positions", headers),
                                                        loadSchedule(), env.REPORT.get(REPORT_KEY, { type: "json" })]);
  const prev = old.status === "fulfilled" ? old.value : null, now = Date.now();
  let st, problem = "";
  if (sch.status !== "fulfilled") {                         // no timetable: can't rate anything, but note that we tried
    st = prev && prev.day === reportDay(now) ? prev : freshReport(reportDay(now));
    if (st.checked) st.downMs = (st.downMs || 0) + Math.min(now - st.checked, 6 * 3600e3);
    st.checked = now; problem = String(sch.reason && sch.reason.message || sch.reason);
  } else {
    let updates = null, vehicles = null;
    try { if (tup.status === "fulfilled") updates = parseTripUpdates(tup.value); else problem = String(tup.reason && tup.reason.message || tup.reason); }
    catch (e) { problem = "Couldn't read trip updates: " + e.message; }
    try { if (pos.status === "fulfilled") vehicles = parseVehicles(pos.value); } catch (e) {}
    st = stepReport(prev, updates, vehicles, sch.value, now);
  }
  st.problem = problem;
  await env.REPORT.put(REPORT_KEY, JSON.stringify(st));     // one write per run (720 a day, under the free 1,000)
  return st;
}

/* ------------------------------------------ handler ------------------------------------------ */
const BASE = "https://gtfspublic.metrarr.com/gtfs/public/";
const JSON_HEADERS = { "content-type": "application/json", "access-control-allow-origin": "*", "Cache-Control": "no-store" };

// Metra's feed blips now and then: try once more after 1.5 s before giving up (not for a real refusal like a bad key).
async function getFeed(name, headers) {
  for (let attempt = 1; ; attempt++) {
    let r = null, err = null;
    try { r = await fetch(BASE + name, { headers }); } catch (e) { err = e; }
    if (r && r.ok) return r.arrayBuffer();
    const blip = !r || r.status >= 500 || r.status === 429;
    if (!blip || attempt >= 2) throw err || new Error(`Metra ${name} feed returned ${r.status}`);
    await new Promise(res => setTimeout(res, 1500));
  }
}

export default {
  async fetch(request, env) {
    const headers = { Authorization: `Bearer ${env.METRA_API_TOKEN}` };
    const url = new URL(request.url);
    /* ---- runreport: run the 2-minute report check right now and show the result (for troubleshooting) ---- */
    if (url.searchParams.has("runreport")) {
      try {
        const last = env.REPORT && await env.REPORT.get(REPORT_KEY, { type: "json" });
        if (last && Date.now() - (last.checked || 0) < 60e3) return new Response(JSON.stringify({ skipped: "checked under a minute ago", report: reportSummary(last) }), { headers: JSON_HEADERS });
        const st = await updateReport(env);
        return new Response(JSON.stringify({ ok: true, report: reportSummary(st) }), { headers: JSON_HEADERS });
      } catch (e) { return new Response(JSON.stringify({ ok: false, error: String(e && e.stack || e) }), { headers: JSON_HEADERS }); }
    }

    // All three feeds in parallel. If one fails, the others still come through.
    const [pos, alr, tup] = await Promise.allSettled([
      getFeed("positions", headers), getFeed("alerts", headers), getFeed("tripupdates", headers)
    ]);
    const nowSec = Math.floor(Date.now() / 1000);

    /* ---- peek: a human-readable sample for checking what Metra really sends ---- */
    if (url.searchParams.has("peek")) {
      const peek = { what: "Sample of Metra's live feeds, decoded. Safe to share: no token in here.", checked_at: new Date().toISOString() };
      try {
        if (pos.status !== "fulfilled") throw pos.reason;
        const v = parseVehicles(pos.value);
        peek.positions = { feed_time: feedTimestamp(pos.value), trains: v.length, sample: v.slice(0, 12) };
      } catch (e) { peek.positions = { error: String(e) }; }
      try {
        if (tup.status !== "fulfilled") throw tup.reason;
        const t = parseTripUpdates(tup.value), ids = new Set(), byRoute = {};
        for (const u of t) { for (const s of u.stops) if (s.stop_id) ids.add(s.stop_id); const r = u.trip.route_id || "?"; byRoute[r] = (byRoute[r] || 0) + 1; }
        const withTimes = t.filter(u => u.stops.some(s => (s.arrival && s.arrival.time) || (s.departure && s.departure.time))).length;
        peek.tripupdates = {
          feed_time: feedTimestamp(tup.value), trips: t.length, trips_with_stop_times: withTimes, trips_per_route: byRoute,
          stops_per_trip: t.map(u => u.stops.length).sort((a, b) => a - b),
          all_stop_ids: [...ids].sort(), sample: t.slice(0, 10)
        };
      } catch (e) { peek.tripupdates = { error: String(e) }; }
      try {
        if (alr.status !== "fulfilled") throw alr.reason;
        peek.alerts = { count: parseAlerts(alr.value).length };
      } catch (e) { peek.alerts = { error: String(e) }; }
      return new Response(JSON.stringify(peek, null, 2), { headers: JSON_HEADERS });
    }

    /* ---- normal: what the dashboard reads every 30 s ---- */
    const out = {};
    try {
      if (pos.status !== "fulfilled") throw pos.reason;
      const byRoute = {};
      for (const v of parseVehicles(pos.value)) (byRoute[v.route_id] ||= []).push(v);
      out.metra_lines = byRoute;
    } catch (e) { out.metra_error = String(e && e.message || e); }

    try {
      if (alr.status !== "fulfilled") throw alr.reason;
      out.alerts = parseAlerts(alr.value);
    } catch (e) { out.alerts_error = String(e && e.message || e); }

    // Per-stop predictions are only sent when the dashboard asks (?trips=1), to keep every poll small.
    if (url.searchParams.has("trips")) try {
      if (tup.status !== "fulfilled") throw tup.reason;
      out.trips = compactTrips(parseTripUpdates(tup.value), nowSec);
    } catch (e) { out.trips_error = String(e && e.message || e); }

    // The day's report card (?report=1), kept up to date by the Cron Trigger below.
    if (url.searchParams.has("report")) try {
      if (!env.REPORT) throw new Error("Report card isn't set up yet (no REPORT storage on the Worker)");
      const st = await env.REPORT.get(REPORT_KEY, { type: "json" });
      const today = reportDay(Date.now());
      out.report = reportSummary(st && st.day === today ? st : { ...freshReport(today), checked: st && st.checked || 0, problem: st && st.problem || "" });
    } catch (e) { out.report_error = String(e && e.message || e); }

    out.fetched_at = Date.now();
    return new Response(JSON.stringify(out), { headers: JSON_HEADERS });
  },

  // Cron Trigger (every 2 minutes): keeps the report card going even when nobody has the page open.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(updateReport(env).catch(e => console.log("report check failed:", e && e.stack || e)));
  }
};
