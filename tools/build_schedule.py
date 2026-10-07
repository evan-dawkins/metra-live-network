"""Build schedule.json from Metra's public timetable (GTFS static).

For every scheduled trip it keeps just two things: the trip's last stop and the
time it is due there. The Worker compares that with Metra's live prediction to
decide whether a train finished on time. Runs daily from a GitHub Action.

Usage: python tools/build_schedule.py [path/to/schedule.zip]
With no path it downloads the zip from Metra.
"""
import csv, io, json, sys, urllib.request, zipfile

SOURCE = "https://schedules.metrarail.com/gtfs/schedule.zip"
OUT = "schedule.json"

def rows(z, name):
    with z.open(name) as f:
        rd = csv.reader(io.TextIOWrapper(f, encoding="utf-8-sig"))
        head = [h.strip().lower() for h in next(rd)]         # Metra's headers can carry stray spaces
        print(f"{name} columns: {head}")
        for r in rd:
            yield {k: (v.strip() if v else "") for k, v in zip(head, r)}

def main():
    if len(sys.argv) > 1:
        data = open(sys.argv[1], "rb").read()
    else:
        req = urllib.request.Request(SOURCE, headers={"User-Agent": "metra-live-network timetable builder"})
        with urllib.request.urlopen(req, timeout=120) as r:
            print(f"Downloaded {r.geturl()} -> HTTP {r.status}, {r.headers.get('Content-Type')}")
            data = r.read()
    print(f"{len(data)} bytes, starts with {data[:4]!r}")
    z = zipfile.ZipFile(io.BytesIO(data))
    print("files:", ", ".join(z.namelist()))

    last = {}                                    # trip_id -> (stop_sequence, stop_id, arrival_time)
    for r in rows(z, "stop_times.txt"):
        tid, seq = r.get("trip_id", ""), r.get("stop_sequence", "")
        if not seq.isdigit():
            continue
        seq = int(seq)
        t = (r.get("arrival_time") or r.get("departure_time") or "").strip()
        if not tid or not t:
            continue
        if tid not in last or seq > last[tid][0]:
            last[tid] = (seq, r.get("stop_id", ""), t if len(t) == 8 else t.zfill(8))

    # Keep only trips that run in the next 8 days (the job runs daily), so the file stays small and quick to read.
    import datetime
    today = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=-6))).date()
    days = [today + datetime.timedelta(d) for d in range(-1, 8)]
    names = set(z.namelist())
    active = set()
    if "calendar.txt" in names:
        wk = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
        for r in rows(z, "calendar.txt"):
            try:
                a = datetime.datetime.strptime(r["start_date"], "%Y%m%d").date(); b = datetime.datetime.strptime(r["end_date"], "%Y%m%d").date()
            except (KeyError, ValueError):
                continue
            if any(a <= d <= b and r.get(wk[d.weekday()]) == "1" for d in days):
                active.add(r.get("service_id", ""))
    if "calendar_dates.txt" in names:
        want = {d.strftime("%Y%m%d") for d in days}
        for r in rows(z, "calendar_dates.txt"):
            if r.get("date") in want and r.get("exception_type") == "1":
                active.add(r.get("service_id", ""))
    if active and "trips.txt" in names:
        keep = {r.get("trip_id", "") for r in rows(z, "trips.txt") if r.get("service_id") in active}
        before = len(last)
        last = {k: v for k, v in last.items() if k in keep}
        print(f"Running this week: {len(last)} of {before} trips")

    version = ""
    if "feed_info.txt" in z.namelist():
        for r in rows(z, "feed_info.txt"):
            version = (r.get("feed_version") or r.get("feed_start_date") or "").strip()
            break

    out = {"source": SOURCE, "version": version,
           "trips": {tid: [stop, t] for tid, (_, stop, t) in sorted(last.items())}}
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"{OUT}: {len(out['trips'])} trips, version {version or 'unknown'}")
    if len(out["trips"]) < 100:
        sys.exit("Too few trips: the timetable looks wrong, not saving a broken file.")

if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:                      # show the reason on the Actions page (as an annotation)
        msg = f"{type(e).__name__}: {e}".replace("\n", " ")[:900]
        print(f"::error title=Timetable build failed::{msg}")
        raise
