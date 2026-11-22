"""
Converte i tracciati GeoJSON (bacinger/f1-circuits, licenza MIT) nel formato
pista v2 del gioco.
Uso: python -I tools/converti_circuiti.py f1-circuits.geojson public/tracks
"""
import json, math, sys, os

R = 6371000.0

# (numero, id dataset, id gioco, nome, larghezza, invertire senso)
CAL = [
    (1, 'au-1953', 'melbourne', 'Melbourne – Albert Park', 14, False),
    (2, 'cn-2004', 'shanghai', 'Shanghai', 15, False),
    (3, 'jp-1962', 'suzuka', 'Suzuka', 13, False),
    (4, 'bh-2002', 'sakhir', 'Sakhir (Bahrain)', 15, False),
    (5, 'sa-2021', 'jeddah', 'Jeddah', 12, False),
    (6, 'us-2022', 'miami', 'Miami', 13, False),
    (7, 'ca-1978', 'montreal', 'Montréal – Gilles Villeneuve', 12, False),
    (8, 'mc-1929', 'monaco', 'Monaco', 9.5, False),
    (9, 'es-1991', 'barcellona', 'Barcellona – Catalunya', 14, False),
    (10, 'at-1969', 'spielberg', 'Spielberg – Red Bull Ring', 14, False),
    (11, 'gb-1948', 'silverstone', 'Silverstone', 15, False),
    (12, 'be-1925', 'spa', 'Spa-Francorchamps', 14, False),
    (13, 'hu-1986', 'hungaroring', 'Hungaroring', 13, False),
    (14, 'nl-1948', 'zandvoort', 'Zandvoort', 12, False),
    (15, 'it-1922', 'monza', 'Monza', 14, False),
    (16, 'es-2026', 'madring', 'Madrid – Madring', 13, False),
    (17, 'az-2016', 'baku', 'Baku', 12, False),
    (18, 'sg-2008', 'singapore', 'Singapore – Marina Bay', 12, True),
    (19, 'us-2012', 'austin', 'Austin – COTA', 15, False),
    (20, 'mx-1962', 'citta_del_messico', 'Città del Messico', 14, False),
    (21, 'br-1940', 'interlagos', 'San Paolo – Interlagos', 13, False),
    (22, 'us-2023', 'las_vegas', 'Las Vegas', 13, False),
    (23, 'qa-2004', 'lusail', 'Lusail (Qatar)', 14, False),
    (24, 'ae-2009', 'yas_marina', 'Abu Dhabi – Yas Marina', 14, False),
]


def project(coords):
    lons = [c[0] for c in coords]; lats = [c[1] for c in coords]
    lon0 = (min(lons) + max(lons)) / 2; lat0 = (min(lats) + max(lats)) / 2
    k = math.cos(math.radians(lat0))
    return [(R * math.radians(c[0] - lon0) * k, -R * math.radians(c[1] - lat0)) for c in coords]


def plen(p):
    return sum(math.dist(p[i], p[(i + 1) % len(p)]) for i in range(len(p)))


def resample(p, step):
    """Polilinea chiusa → punti equidistanti (a partire dal primo)."""
    L = plen(p); n = max(20, round(L / step)); st = L / n
    out = []; i = 0; acc = 0.0; seglen = math.dist(p[0], p[1])
    for k in range(n):
        t = k * st
        while acc + seglen < t:
            acc += seglen; i += 1; seglen = math.dist(p[i % len(p)], p[(i + 1) % len(p)])
        a = p[i % len(p)]; b = p[(i + 1) % len(p)]
        f = (t - acc) / seglen if seglen > 0 else 0
        out.append((a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f))
    return out


def smooth(p, passes):
    n = len(p)
    for _ in range(passes):
        p = [((p[i - 1][0] + 2 * p[i][0] + p[(i + 1) % n][0]) / 4, (p[i - 1][1] + 2 * p[i][1] + p[(i + 1) % n][1]) / 4) for i in range(n)]
    return p


# --- Bézier con maniglie automatiche (identiche a BezierPath.ts) ---
def auto_handles(pts, i):
    n = len(pts); p = pts[i]; pr = pts[i - 1]; nx = pts[(i + 1) % n]
    dx, dz = nx[0] - pr[0], nx[1] - pr[1]; l = math.hypot(dx, dz) or 1; dx /= l; dz /= l
    lo = math.dist(nx, p) / 3; li = math.dist(p, pr) / 3
    return (-dx * li, -dz * li), (dx * lo, dz * lo)


def bezier_samples(pts, sub=24):
    n = len(pts); hs = [auto_handles(pts, i) for i in range(n)]; out = []
    for i in range(n):
        j = (i + 1) % n; p0 = pts[i]; p1 = pts[j]
        c1 = (p0[0] + hs[i][1][0], p0[1] + hs[i][1][1]); c2 = (p1[0] + hs[j][0][0], p1[1] + hs[j][0][1])
        for k in range(sub):
            t = k / sub; u = 1 - t
            a, b, c, d = u ** 3, 3 * u * u * t, 3 * u * t * t, t ** 3
            out.append((a * p0[0] + b * c1[0] + c * c2[0] + d * p1[0], a * p0[1] + b * c1[1] + c * c2[1] + d * p1[1]))
    return out


def simplify(dense, tol, max_seg):
    """Sceglie i punti di controllo: aggiunge punti dove la Bézier si allontana dal tracciato."""
    n = len(dense)
    step = 3
    keep = set(range(0, n, max(1, int(max_seg / 5))))  # griglia di base (ogni max_seg m circa)
    keep.add(0)
    # nelle curve strette teniamo un punto ogni 10 m: la Bézier non "taglia" né crea spigoli
    for i in range(0, n, 2):
        if radius3(dense[i - 1], dense[i], dense[(i + 1) % n]) < 30:
            keep.add(i)
    for _ in range(30):
        idx = sorted(keep)
        pts = [dense[i] for i in idx]
        bz = bezier_samples(pts, 16)
        # errore: per ogni punto denso, distanza dal campione bezier più vicino (ricerca locale)
        worst = []
        m = len(bz); j = 0
        for i in range(0, n, step):
            q = dense[i]
            best = min(range(j - 30, j + 30), key=lambda k: (bz[k % m][0] - q[0]) ** 2 + (bz[k % m][1] - q[1]) ** 2)
            j = best
            e = math.dist(bz[best % m], q)
            if e > tol:
                worst.append((e, i))
        if not worst:
            break
        # aggiunge il punto peggiore di ogni gruppo
        worst.sort(reverse=True)
        added = 0
        for e, i in worst:
            if all(abs(i - k) > 2 for k in keep):
                keep.add(i); added += 1
            if added > 40:
                break
        if added == 0:
            break
    return [dense[i] for i in sorted(keep)], sorted(keep)


def radius3(a, b, c):
    ab, bc, ca = math.dist(a, b), math.dist(b, c), math.dist(c, a)
    cross = abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]))
    return 1e9 if cross < 1e-9 else ab * bc * ca / (2 * cross)


def relax_hairpins(p, width):
    """Allarga i tornanti con raggio impossibile (< 0,8 × larghezza) smussandoli localmente."""
    n = len(p); p = list(p)
    for _ in range(200):
        bad = [i for i in range(n) if radius3(p[i - 2], p[i], p[(i + 2) % n]) < width * 0.8]
        if not bad:
            break
        for i in bad:
            for k in range(-3, 4):
                j = (i + k) % n
                a = p[j - 1]; c = p[(j + 1) % n]
                p[j] = ((a[0] + 2 * p[j][0] + c[0]) / 4, (a[1] + 2 * p[j][1] + c[1]) / 4)
    return p


def headings(p):
    n = len(p); out = []
    for i in range(n):
        a = p[i - 1]; b = p[(i + 1) % n]
        tx, tz = b[0] - a[0], b[1] - a[1]; l = math.hypot(tx, tz) or 1
        out.append((tx / l, tz / l))
    return out


def clearance(dense, x, z, skip_i, skip_range):
    n = len(dense); best = 1e9
    for i in range(0, n, 2):
        if min(abs(i - skip_i), n - abs(i - skip_i)) < skip_range:
            continue
        best = min(best, math.dist(dense[i], (x, z)))
    return best


def build(feature, num, gid, name, width, reverse):
    p = project(feature['geometry']['coordinates'])
    if math.dist(p[0], p[-1]) < 0.5:
        p = p[:-1]
    if reverse:
        p = [p[0]] + p[1:][::-1]
    official = feature['properties']['length']
    dense = smooth(resample(p, 4.0), 5)
    # scala alla lunghezza ufficiale
    k = official / plen(dense)
    dense = [(x * k, z * k) for x, z in dense]
    # centra nell'origine
    xs = [q[0] for q in dense]; zs = [q[1] for q in dense]
    cx = (min(xs) + max(xs)) / 2; cz = (min(zs) + max(zs)) / 2
    dense = [(x - cx, z - cz) for x, z in dense]
    dense = resample(dense, 5.0)
    dense = relax_hairpins(dense, width)

    pts, idx = simplify(dense, 0.6, 70)
    # larghezza locale: più stretta dove il tracciato passa vicino a un'altra sua parte
    def local_width(i):
        if gid == 'suzuka':
            return width  # l'incrocio del "8" è voluto (in realtà è un ponte)
        c = clearance(dense, dense[i][0], dense[i][1], i, 40)
        return max(7.5, min(width, c - 4.0))
    widths = [local_width(i) for i in idx]
    # niente salti bruschi: una passata di minimo con i vicini
    widths = [min(widths[i - 1] + 2, widths[i], widths[(i + 1) % len(widths)] + 2) for i in range(len(widths))]
    n = len(dense)
    tang = headings(dense)

    # punti della Bézier (il primo è la linea di partenza)
    points = []
    for (x, z), w in zip(pts, widths):
        pt = {'x': round(x, 2), 'z': round(z, 2), 'handle': 'auto', 'kerb': 'auto'}
        if w < width - 0.05:
            pt['width'] = round(w, 1)
        points.append(pt)

    def ref_at(frac):
        target = int(frac * n)
        seg = max(i for i, d in enumerate(idx) if d <= target)
        nxt = idx[seg + 1] if seg + 1 < len(idx) else n
        return {'seg': seg, 't': round((target - idx[seg]) / max(1, nxt - idx[seg]), 3)}

    # --- corsia box parallela al rettilineo di partenza ---
    st = 5.0
    a_s, b_s = -360.0, 250.0  # metri rispetto al traguardo
    off_full = width / 2 + 13
    best = None
    for side in (1, -1):
        conflicts = 0
        for s in range(int(a_s), int(b_s), 20):
            i = int(round(s / st)) % n
            tx, tz = tang[i]; nx, nz = tz, -tx
            for extra in (0, 18):
                x = dense[i][0] + nx * side * (off_full + extra); z = dense[i][1] + nz * side * (off_full + extra)
                if clearance(dense, x, z, i, 30) < width / 2 + 6:
                    conflicts += 1
        if best is None or conflicts < best[0]:
            best = (conflicts, side)
    side = best[1]
    pit_pts = []
    for s in range(int(a_s), int(b_s) + 1, 20):
        i = int(round(s / st)) % n
        tx, tz = tang[i]; nx, nz = tz, -tx
        # rampe di ingresso/uscita di ~110 m
        f = min(1.0, (s - a_s) / 110.0, (b_s - s) / 110.0)
        f = f * f * (3 - 2 * f)
        off = (width / 2 - 2.5) + (off_full - (width / 2 - 2.5)) * f
        pit_pts.append({'x': round(dense[i][0] + nx * side * off, 2), 'z': round(dense[i][1] + nz * side * off, 2)})
    pit = {
        'points': pit_pts, 'width': 10, 'speedLimitKmh': 80,
        'garageSide': 'left' if side > 0 else 'right', 'garages': 10,
    }

    # --- tribune lungo il rettilineo, dal lato opposto ai box ---
    props = []
    for s, size in ((-140, 140), (60, 110)):
        i = int(round(s / st)) % n
        tx, tz = tang[i]; nx, nz = tz, -tx
        o = -side * (width / 2 + 16)
        h = math.atan2(tx, tz)
        rot = math.degrees(h - math.pi / 2) if -side > 0 else math.degrees(h + math.pi / 2)
        x, z = dense[i][0] + nx * o, dense[i][1] + nz * o
        if clearance(dense, x, z, i, 40) > width / 2 + 25:
            props.append({'type': 'tribuna', 'x': round(x, 1), 'z': round(z, 1), 'rot': round(rot % 360, 1), 'size': size})

    return {
        'formatVersion': 2,
        'id': f'cal26_{num:02d}_{gid}',
        'name': f'{num:02d} · {name}',
        'author': 'Tracciato da dati aperti (bacinger/f1-circuits, licenza MIT)',
        'defaultWidth': width,
        'points': points,
        'start': {'seg': 0, 't': 0},
        'sectors': [ref_at(1 / 3), ref_at(2 / 3)],
        'pitLane': pit,
        'props': props,
        'autoTrees': True,
        'gridSlots': 20,
    }, official


def main():
    src, out_dir = sys.argv[1], sys.argv[2]
    feats = {f['properties']['id']: f for f in json.load(open(src, encoding='utf-8'))['features']}
    index = json.load(open(os.path.join(out_dir, 'index.json'), encoding='utf-8'))
    index = [e for e in index if not e['id'].startswith('cal26_')]
    for num, fid, gid, name, width, rev in CAL:
        t, official = build(feats[fid], num, gid, name, width, rev)
        fn = f"{t['id']}.track.json"
        with open(os.path.join(out_dir, fn), 'w', encoding='utf-8') as fh:
            json.dump(t, fh, ensure_ascii=False, separators=(',', ':'))
        index.append({'id': t['id'], 'name': t['name'], 'file': fn, 'group': 'Calendario 2026', 'lengthM': official})
        print(f"{t['id']:32} punti={len(t['points']):4} box={'sx' if t['pitLane']['garageSide']=='left' else 'dx'} tribune={len(t['props'])}")
    with open(os.path.join(out_dir, 'index.json'), 'w', encoding='utf-8') as fh:
        json.dump(index, fh, ensure_ascii=False, indent=2)


main()
