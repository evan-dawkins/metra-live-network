"""Builds data/geo.json and bakes it into index.html: the real Lake Michigan shoreline and the real
Illinois-Wisconsin and Illinois-Indiana state lines, for MetraBot's base map.

Source: US Census Bureau TIGER/Line 2023 (public domain).
  - COASTLINE (national): the Great Lakes shoreline. The lake is the part of the box on the water side of it.
  - STATE (national): state outlines. A border is the line Illinois shares with Wisconsin or Indiana, on land only.
Runs on GitHub (see .github/workflows/geo.yml) because census.gov can't be reached from everywhere.

The map itself is a diagram, not true geography: the page bends these real shapes to fit the diagram's
station positions when it loads (see "BASE MAP" in index.html). So everything here stays in lat/lon.

Output, as [lat, lon] points simplified to about 40 m:
  lake:    rings of Lake Michigan, cut to the box
  borders: {"wi": [lines], "in": [lines]}
"""
import io, json, math, os, re, sys, urllib.request, zipfile
import shapefile  # pyshp

YEAR = "2023"
COAST = f"https://www2.census.gov/geo/tiger/TIGER{YEAR}/COASTLINE/tl_{YEAR}_us_coastline.zip"
STATES = f"https://www2.census.gov/geo/tiger/TIGER{YEAR}/STATE/tl_{YEAR}_us_state.zip"
OPEN_LAKE = (-87.40, 42.00)       # well offshore from Evanston: certainly lake
# every Metra station (Kenosha 42.58 N, University Park 41.44 N, Harvard -88.60), plus a wide margin
S, N, W, E = 41.10, 42.90, -89.00, -86.60
SIMPLIFY_M = 40


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "metrabot map builder (+https://github.com/evan-dawkins/metrabot)"})
    return zipfile.ZipFile(io.BytesIO(urllib.request.urlopen(req, timeout=300).read()))


def reader(z):
    base = [n[:-4] for n in z.namelist() if n.endswith(".shp")][0]
    return shapefile.Reader(shp=io.BytesIO(z.read(base + ".shp")), dbf=io.BytesIO(z.read(base + ".dbf")),
                            shx=io.BytesIO(z.read(base + ".shx")))


def parts(shape):
    p = list(shape.parts) + [len(shape.points)]
    return [shape.points[p[i]:p[i + 1]] for i in range(len(p) - 1)]


def rdp(pts, eps_m):
    """Simplify a line of (lon, lat) points; eps in metres."""
    if len(pts) < 3:
        return pts
    lat0 = math.radians(sum(p[1] for p in pts) / len(pts))
    xy = [(p[0] * 111320 * math.cos(lat0), p[1] * 110540) for p in pts]
    keep = [False] * len(pts); keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        (ax, ay), (bx, by) = xy[a], xy[b]
        dx, dy = bx - ax, by - ay; L = math.hypot(dx, dy)
        best, bi = -1, -1
        for i in range(a + 1, b):
            d = abs(dy * (xy[i][0] - ax) - dx * (xy[i][1] - ay)) / L if L > 1 else math.hypot(xy[i][0] - ax, xy[i][1] - ay)
            if d > best:
                best, bi = d, i
        if best > eps_m:
            keep[bi] = True; stack += [(a, bi), (bi, b)]
    return [p for p, k in zip(pts, keep) if k]


def out(coords):
    r = rdp(list(coords), SIMPLIFY_M)
    return [[round(p[1], 5), round(p[0], 5)] for p in r]


def lines_of(g):
    """Every LineString inside a (Multi)LineString / GeometryCollection, merged where they touch."""
    from shapely.ops import linemerge
    if g.is_empty:
        return []
    if g.geom_type == "LineString":
        return [g]
    if g.geom_type == "MultiLineString":
        m = linemerge(g)
        return [m] if m.geom_type == "LineString" else list(m.geoms)
    return [x for sub in getattr(g, "geoms", []) for x in lines_of(sub)]


def main():
    if "--bake" in sys.argv:
        return bake(json.load(open("data/geo.json")))
    from shapely.geometry import LineString, Point, Polygon, box
    from shapely.ops import polygonize, unary_union
    frame = box(W, S, E, N)

    # ---- the lake
    lines = []
    for shp in reader(fetch(COAST)).shapes():
        x0, y0, x1, y1 = shp.bbox
        if x1 < W or x0 > E or y1 < S or y0 > N:
            continue
        for part in parts(shp):
            if len(part) > 1:
                g = LineString(part).intersection(frame)
                if not g.is_empty:
                    lines.append(g)
    faces = list(polygonize(unary_union(lines + [frame.boundary])))
    water = [f for f in faces if f.contains(Point(*OPEN_LAKE))]
    if not water:
        sys.exit("No Lake Michigan polygon found: stopping rather than drawing a map without the lake")
    lake_poly = unary_union(water)
    lake = [out(f.exterior.coords) for f in water]

    # ---- state lines Illinois shares with Wisconsin and Indiana, on land only
    st = reader(fetch(STATES))
    names = [f[0] for f in st.fields[1:]]
    poly = {}
    for rec, shp in zip(st.records(), st.shapes()):
        r = dict(zip(names, rec))
        if r["STUSPS"] in ("IL", "WI", "IN"):
            rings = [Polygon(p) for p in parts(shp) if len(p) >= 4]
            poly[r["STUSPS"]] = unary_union([g.buffer(0) for g in rings])
    if set(poly) != {"IL", "WI", "IN"}:
        sys.exit(f"State outlines missing: found {sorted(poly)}")
    borders = {}
    for other, key in (("WI", "wi"), ("IN", "in")):
        shared = poly["IL"].boundary.intersection(poly[other].buffer(1e-5))
        land = shared.difference(lake_poly.buffer(1e-4)).intersection(frame)
        ls = [l for l in lines_of(land) if l.length > 0.01]
        if not ls:
            sys.exit(f"The Illinois-{other} state line came out empty: stopping")
        borders[key] = [out(l.coords) for l in ls]

    data = {"source": "US Census Bureau TIGER/Line " + YEAR, "box": [S, W, N, E], "lake": lake, "borders": borders}
    os.makedirs("data", exist_ok=True)
    json.dump(data, open("data/geo.json", "w"), separators=(",", ":"))
    print(f"lake: {len(lake)} ring(s), {sum(map(len, lake))} points; "
          + ", ".join(f"{k}: {len(v)} line(s), {sum(map(len, v))} points" for k, v in borders.items()))

    bake(data)


def bake(data):
    """Write the shapes into index.html (between /*GEO:BEGIN*/ and /*GEO:END*/), so the page also works opened as a file."""
    lake, borders = data["lake"], data["borders"]
    if os.path.exists("index.html"):
        html = open("index.html").read()
        js = json.dumps({"lake": lake, "borders": borders}, separators=(",", ":"))
        new, n = re.subn(r"/\*GEO:BEGIN\*/.*?/\*GEO:END\*/", lambda m: "/*GEO:BEGIN*/const GEO=" + js + ";/*GEO:END*/", html, flags=re.S)
        if n == 1 and new != html:
            open("index.html", "w").write(new)
            print("index.html updated")


if __name__ == "__main__":
    main()
