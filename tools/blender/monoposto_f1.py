"""
MONOPOSTO 2026 (design originale) costruita con uno script di Blender.

Uso, dentro Blender:  Scripting → Apri questo file → Esegui
oppure nella Console Python di Blender:
    exec(open(r"C:/Users/Stefano/Documents/progetto corsa/tools/blender/monoposto_f1.py", encoding="utf-8").read())

Crea la collezione "Monoposto_F1" (rifatta da zero a ogni esecuzione, il resto della scena non
viene toccato), salva una copia modificabile in tools/blender/monoposto.blend ed esporta
public/models/monoposto.glb con la convenzione del gioco (vedi public/models/LEGGIMI.md):
  - metri, muso verso -Y, alto +Z, origine a terra a metà tra gli assi;
  - ruote wheel_FL/FR/RL/RR con origine al mozzo e asse X;
  - aero_front_flap / aero_rear_flap con origine sul bordo d'attacco (ruotano attorno a X);
  - steering_wheel, cam_cockpit (occhi del pilota), cam_hood (T-cam);
  - materiali: paint (livrea, ricolorata dal gioco), accent (contrasto), number (numero di gara),
    tyrestripe (colore della mescola), più carbonio, gomma, cerchi, abitacolo, casco.

Misure come la fisica (monoposto_2026.car.json): passo 3,40 m, carreggiate 1,62/1,56 m,
ruote da 0,72 m di diametro, lunghezza ~5,1 m, larghezza ~1,9 m.
"""
import math
import os

import bmesh
import bpy
from mathutils import Matrix, Vector

PROJECT = r"C:/Users/Stefano/Documents/progetto corsa"
GLB = os.path.join(PROJECT, "public", "models", "monoposto.glb")
BLEND = os.path.join(PROJECT, "tools", "blender", "monoposto.blend")
COLL = "Monoposto_F1"

WB = 3.40            # passo
YF, YR = -WB / 2, WB / 2   # assi (muso verso -Y)
TF, TR = 1.62, 1.56  # carreggiate
R = 0.36             # raggio ruota
WF, WR = 0.30, 0.38  # larghezza gomme

# ----------------------------------------------------------------------------- scena


def reset_collection():
    old = bpy.data.collections.get(COLL)
    if old:
        for o in list(old.all_objects):
            bpy.data.objects.remove(o, do_unlink=True)
        bpy.data.collections.remove(old)
    c = bpy.data.collections.new(COLL)
    bpy.context.scene.collection.children.link(c)
    s = bpy.context.scene
    s.unit_settings.system = 'METRIC'
    s.unit_settings.scale_length = 1.0
    return c


COL = reset_collection()


def mat(name, color, metal=0.0, rough=0.5, clearcoat=0.0):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes.get("Principled BSDF")
    b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Metallic"].default_value = metal
    b.inputs["Roughness"].default_value = rough
    for key in ("Coat Weight", "Clearcoat"):
        if key in b.inputs:
            b.inputs[key].default_value = clearcoat
            break
    m.diffuse_color = (*color, 1)
    return m


M = {
    "paint": mat("paint", (0.75, 0.04, 0.03), 0.2, 0.28, 1.0),
    "accent": mat("accent", (0.95, 0.95, 0.95), 0.0, 0.35, 0.6),
    "carbon": mat("carbon", (0.025, 0.025, 0.028), 0.3, 0.38, 0.5),
    "tyre": mat("tyre", (0.03, 0.03, 0.03), 0.0, 0.85),
    "rim": mat("rim", (0.08, 0.08, 0.09), 0.9, 0.3),
    "stripe": mat("tyrestripe", (0.95, 0.8, 0.1), 0.0, 0.6),
    "cockpit": mat("cockpit", (0.01, 0.01, 0.012), 0.0, 0.7),
    "helmet": mat("helmet", (0.98, 0.82, 0.1), 0.1, 0.2, 1.0),
    "number": mat("number", (1, 1, 1), 0.0, 0.4),
    "metal": mat("metal", (0.6, 0.6, 0.62), 1.0, 0.25),
    "glow": mat("rainlight", (1.0, 0.05, 0.03), 0.0, 0.3),
}


def obj_from_bm(name, bm, material, smooth=True, subdiv=0, parent=None, origin=(0, 0, 0)):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    if isinstance(material, list):
        for mm in material:
            me.materials.append(mm)
    else:
        me.materials.append(material)
    if smooth:
        for p in me.polygons:
            p.use_smooth = True
    o = bpy.data.objects.new(name, me)
    COL.objects.link(o)
    if origin != (0, 0, 0):
        me.transform(Matrix.Translation(-Vector(origin)))
        o.location = origin
    if subdiv:
        mod = o.modifiers.new("Suddivisione", 'SUBSURF')
        mod.levels = subdiv
        mod.render_levels = subdiv
    if parent:
        o.parent = parent
    return o


# ----------------------------------------------------------------------------- forme base


def superellipse_ring(bm, y, w, h, zc, n_top=2.6, n_bot=4.0, seg=28, x0=0.0):
    """Anello di vertici (sezione) di una carrozzeria: superellisse più piatta sotto."""
    verts = []
    for i in range(seg):
        a = 2 * math.pi * i / seg
        c, s = math.cos(a), math.sin(a)
        n = n_top if s >= 0 else n_bot
        x = x0 + (w / 2) * math.copysign(abs(c) ** (2 / n), c)
        z = zc + (h / 2) * math.copysign(abs(s) ** (2 / n), s)
        verts.append(bm.verts.new((x, y, z)))
    return verts


def loft(name, sections, material, subdiv=1, seg=28, caps=True, x0=0.0):
    """Corpo "estruso" lungo Y da sezioni (y, larghezza, altezza, z centro[, n_top, n_bot])."""
    bm = bmesh.new()
    rings = []
    for sec in sections:
        y, w, h, zc = sec[:4]
        nt = sec[4] if len(sec) > 4 else 2.6
        nb = sec[5] if len(sec) > 5 else 4.0
        rings.append(superellipse_ring(bm, y, w, h, zc, nt, nb, seg, x0))
    for a, b in zip(rings, rings[1:]):
        for i in range(seg):
            j = (i + 1) % seg
            bm.faces.new((a[i], a[j], b[j], b[i]))
    if caps:
        bm.faces.new(list(reversed(rings[0])))
        bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return obj_from_bm(name, bm, material, subdiv=subdiv)


def box(name, center, size, material, bevel=0.0, parent=None, origin=None, smooth=False):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=size, verts=bm.verts)
    bmesh.ops.translate(bm, vec=center, verts=bm.verts)
    if bevel > 0:
        bmesh.ops.bevel(bm, geom=bm.edges[:], offset=bevel, segments=2, affect='EDGES')
    return obj_from_bm(name, bm, material, smooth=smooth, parent=parent, origin=origin or (0, 0, 0))


def airfoil(name, x_span, y_le, z, chord, thick, material, twist=0.0, parent=None, origin_le=False, sweep=0.0, seg=14):
    """Profilo alare (sezione a goccia) esteso lungo X. Origine opzionale sul bordo d'attacco."""
    bm = bmesh.new()
    pts = []
    for i in range(seg):
        t = i / (seg - 1)
        # NACA-like semplificato
        yt = 5 * thick * (0.2969 * math.sqrt(t) - 0.126 * t - 0.3516 * t ** 2 + 0.2843 * t ** 3 - 0.1036 * t ** 4)
        pts.append((t, yt))
    outline = [(t, yt) for t, yt in pts] + [(t, -yt * 0.6) for t, yt in reversed(pts[1:-1])]
    rings = []
    xs = [-x_span / 2, -x_span / 6, x_span / 6, x_span / 2]
    for x in xs:
        ring = []
        sw = sweep * abs(x) / (x_span / 2)
        for t, yt in outline:
            ly, lz = t * chord, yt * chord
            ca, sa = math.cos(twist), math.sin(twist)
            ry = ly * ca - lz * sa
            rz = ly * sa + lz * ca
            ring.append(bm.verts.new((x, y_le + ry + sw, z + rz)))
        rings.append(ring)
    n = len(outline)
    for a, b in zip(rings, rings[1:]):
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((a[i], a[j], b[j], b[i]))
    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return obj_from_bm(name, bm, material, smooth=True, parent=parent, origin=(0, y_le, z) if origin_le else (0, 0, 0))


def tube(name, p0, p1, radius, material, parent=None, seg=8):
    """Braccetto: cilindro tra due punti."""
    p0, p1 = Vector(p0), Vector(p1)
    d = p1 - p0
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=radius, radius2=radius, depth=d.length)
    rot = d.to_track_quat('Z', 'Y').to_matrix().to_4x4()
    bmesh.ops.transform(bm, matrix=Matrix.Translation((p0 + p1) / 2) @ rot, verts=bm.verts)
    return obj_from_bm(name, bm, material, smooth=True, parent=parent)


def cyl_x(bm, radius, width, x_center=0.0, seg=40):
    """Cilindro con asse X (per ruote e cerchi)."""
    r = bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=radius, radius2=radius, depth=width)
    bmesh.ops.rotate(bm, verts=r["verts"], cent=(0, 0, 0), matrix=Matrix.Rotation(math.pi / 2, 3, 'Y'))
    bmesh.ops.translate(bm, vec=(x_center, 0, 0), verts=r["verts"])
    return r


# ----------------------------------------------------------------------------- ruote


def wheel(name, x, y, width, outer_sign):
    """Ruota completa: pneumatico (con spalla arrotondata), fascia della mescola, cerchio, dado."""
    bm = bmesh.new()
    # pneumatico: profilo di rivoluzione attorno a X (spalla arrotondata)
    seg = 48
    prof = []
    hw = width / 2
    rr = R * 0.66  # raggio del cerchio
    for k in range(9):
        a = -math.pi / 2 + math.pi * k / 8
        prof.append((hw * math.sin(a) * 1.0, R - 0.045 + 0.045 * math.cos(a)))
    prof = [(-hw, rr)] + prof + [(hw, rr)]
    rings = []
    for i in range(seg):
        th = 2 * math.pi * i / seg
        ring = [bm.verts.new((px, math.cos(th) * pr, math.sin(th) * pr)) for px, pr in prof]
        rings.append(ring)
    tyre_faces = []
    for i in range(seg):
        a, b = rings[i], rings[(i + 1) % seg]
        for k in range(len(prof) - 1):
            tyre_faces.append(bm.faces.new((a[k], b[k], b[k + 1], a[k + 1])))
    for f in tyre_faces:
        f.material_index = 0
    # fascia colorata sul fianco esterno: anello tra 0,80 e 0,86 del raggio, appena fuori dal fianco
    xs = outer_sign * (hw + 0.003)
    inner = [bm.verts.new((xs, math.cos(2 * math.pi * i / seg) * R * 0.80, math.sin(2 * math.pi * i / seg) * R * 0.80)) for i in range(seg)]
    outer = [bm.verts.new((xs, math.cos(2 * math.pi * i / seg) * R * 0.86, math.sin(2 * math.pi * i / seg) * R * 0.86)) for i in range(seg)]
    for i in range(seg):
        j = (i + 1) % seg
        quad = (inner[i], inner[j], outer[j], outer[i]) if outer_sign > 0 else (inner[i], outer[i], outer[j], inner[j])
        bm.faces.new(quad).material_index = 1
    # cerchio (incavato) e dado centrale
    rim = cyl_x(bm, rr, width * 0.92, seg=seg)
    for v in rim["verts"]:
        for f in v.link_faces:
            f.material_index = 2
    nut = cyl_x(bm, 0.045, width * 0.98 + 0.03, seg=12)
    for v in nut["verts"]:
        for f in v.link_faces:
            f.material_index = 3
    o = obj_from_bm(name, bm, [M["tyre"], M["stripe"], M["rim"], M["metal"]], smooth=True)
    o.location = (x, y, R)
    return o


for nm, x, y, w in (("wheel_FL", TF / 2, YF, WF), ("wheel_FR", -TF / 2, YF, WF), ("wheel_RL", TR / 2, YR, WR), ("wheel_RR", -TR / 2, YR, WR)):
    wheel(nm, x, y, w, 1 if x > 0 else -1)

# ----------------------------------------------------------------------------- telaio e carrozzeria

# monoscocca + muso + cofano motore (sezioni dal muso alla coda)
loft("scocca", [
    (-2.62, 0.10, 0.08, 0.20, 2.2, 2.2),
    (-2.50, 0.20, 0.13, 0.21),
    (-2.20, 0.27, 0.18, 0.24),
    (-1.80, 0.34, 0.24, 0.29),
    (-1.30, 0.44, 0.33, 0.35),
    (-0.85, 0.62, 0.43, 0.40),
    (-0.40, 0.76, 0.50, 0.42),
    (0.10, 0.84, 0.52, 0.43),
    (0.60, 0.80, 0.56, 0.45),
    (1.10, 0.62, 0.52, 0.45),
    (1.60, 0.40, 0.42, 0.42),
    (2.05, 0.24, 0.30, 0.36),
    (2.30, 0.16, 0.18, 0.33),
], M["paint"], subdiv=1, seg=32)

# pance laterali (sidepod) con le prese d'aria
for side in (1, -1):
    sp = loft(f"pancia_{'sx' if side > 0 else 'dx'}", [
        (-0.30, 0.34, 0.30, 0.34, 3.0, 4.0),
        (-0.15, 0.44, 0.40, 0.36, 3.0, 4.0),
        (0.40, 0.46, 0.40, 0.35, 2.8, 4.0),
        (0.95, 0.36, 0.30, 0.31),
        (1.45, 0.22, 0.20, 0.26),
        (1.75, 0.10, 0.12, 0.22),
    ], M["paint"], subdiv=1, seg=24, x0=side * 0.55)
    # bocca della presa d'aria (scura)
    box(f"presa_{side}", (side * 0.55, -0.295, 0.36), (0.26, 0.012, 0.20), M["cockpit"], bevel=0.03)
    # striscia accent sulla pancia
    loft(f"striscia_{side}", [
        (-0.10, 0.02, 0.05, 0.50), (0.9, 0.02, 0.05, 0.44), (1.5, 0.02, 0.04, 0.33),
    ], M["accent"], subdiv=0, seg=8, x0=side * 0.77)

# fondo (piatto) con i bordi e il diffusore
box("fondo", (0, 0.35, 0.045), (1.40, 3.10, 0.03), M["carbon"], bevel=0.01)
box("fondo_muso", (0, -1.35, 0.05), (0.50, 0.70, 0.03), M["carbon"])
for side in (1, -1):
    box(f"bordo_fondo_{side}", (side * 0.69, 0.40, 0.07), (0.03, 2.6, 0.06), M["carbon"])
loft("diffusore", [
    (1.85, 1.0, 0.06, 0.06, 6, 6), (2.25, 1.0, 0.26, 0.16, 6, 6), (2.38, 0.96, 0.30, 0.19, 6, 6),
], M["carbon"], subdiv=0, seg=16, caps=True)

# abitacolo (incavo scuro), casco, poggiatesta
loft("abitacolo", [
    (-0.62, 0.30, 0.05, 0.68, 2.2, 2.2), (-0.45, 0.46, 0.10, 0.69), (0.05, 0.50, 0.12, 0.70), (0.22, 0.40, 0.08, 0.70),
], M["cockpit"], subdiv=1, seg=20)
bm = bmesh.new()
bmesh.ops.create_uvsphere(bm, u_segments=24, v_segments=16, radius=0.13)
bmesh.ops.scale(bm, vec=(1.0, 1.12, 1.0), verts=bm.verts)
bmesh.ops.translate(bm, vec=(0, 0.02, 0.80), verts=bm.verts)
obj_from_bm("casco", bm, M["helmet"])
box("visiera", (0, -0.12, 0.81), (0.17, 0.02, 0.05), M["cockpit"], bevel=0.008)

# presa d'aria sopra la testa (airbox) e roll-bar
loft("airbox", [
    (0.14, 0.16, 0.10, 0.90, 3, 3), (0.30, 0.30, 0.30, 0.84, 3, 3), (0.70, 0.30, 0.36, 0.70), (1.20, 0.18, 0.24, 0.58), (1.60, 0.10, 0.12, 0.52),
], M["paint"], subdiv=1, seg=20)
box("bocca_airbox", (0, 0.145, 0.90), (0.13, 0.015, 0.08), M["cockpit"], bevel=0.015)
# pinna sul cofano (accent)
box("pinna", (0, 1.25, 0.72), (0.012, 0.9, 0.22), M["accent"])

# halo (protezione dell'abitacolo)
pts = [(0, -0.66, 0.66), (0, -0.60, 0.86), (0.18, -0.38, 0.92), (0.27, -0.05, 0.91), (0.26, 0.20, 0.86),
       (-0.26, 0.20, 0.86), (-0.27, -0.05, 0.91), (-0.18, -0.38, 0.92)]
cu = bpy.data.curves.new("halo_curva", 'CURVE')
cu.dimensions = '3D'
cu.bevel_depth = 0.024
cu.bevel_resolution = 3
sp = cu.splines.new('NURBS')
loop = [pts[2], pts[3], pts[4], pts[5], pts[6], pts[7]]
sp.points.add(len(loop) - 1)
for p, c in zip(sp.points, loop):
    p.co = (*c, 1)
sp.use_cyclic_u = True
sp.order_u = 3
halo = bpy.data.objects.new("halo", cu)
COL.objects.link(halo)
halo.data.materials.append(M["carbon"])
tube("halo_pilone", pts[0], pts[1], 0.03, M["carbon"])
tube("halo_pilone2", pts[1], (0, -0.42, 0.91), 0.026, M["carbon"])

# volante e specchietti
sw = box("steering_wheel", (0, -0.42, 0.62), (0.26, 0.04, 0.13), M["carbon"], bevel=0.02, origin=(0, -0.42, 0.62))
for side in (1, -1):
    tube(f"braccio_specchio_{side}", (side * 0.34, -0.55, 0.58), (side * 0.50, -0.60, 0.68), 0.012, M["carbon"])
    box(f"specchio_{side}", (side * 0.52, -0.60, 0.70), (0.15, 0.04, 0.06), M["paint"], bevel=0.015)

# ----------------------------------------------------------------------------- ali

# ala anteriore: piano principale + flap mobile (aerodinamica attiva) + paratie
airfoil("ala_anteriore", 1.74, -2.78, 0.075, 0.34, 0.10, M["carbon"], twist=-0.05, sweep=0.06)
airfoil("aero_front_flap", 1.62, -2.48, 0.14, 0.22, 0.12, M["paint"], twist=-0.38, origin_le=True, sweep=0.05)
for side in (1, -1):
    box(f"paratia_ant_{side}", (side * 0.87, -2.55, 0.15), (0.015, 0.48, 0.20), M["accent"], bevel=0.006)
# supporti del muso
for side in (1, -1):
    tube(f"pilone_ala_{side}", (side * 0.08, -2.45, 0.19), (side * 0.10, -2.55, 0.09), 0.012, M["carbon"])

# ala posteriore: beam wing, piano principale, flap mobile, paratie, pilone e luce della pioggia
airfoil("beam_wing", 0.80, 2.22, 0.42, 0.18, 0.10, M["carbon"], twist=-0.15)
airfoil("ala_posteriore", 0.98, 2.18, 0.80, 0.30, 0.11, M["carbon"], twist=-0.12)
airfoil("aero_rear_flap", 0.96, 2.40, 0.90, 0.20, 0.12, M["paint"], twist=-0.55, origin_le=True)
for side in (1, -1):
    box(f"paratia_post_{side}", (side * 0.50, 2.36, 0.72), (0.015, 0.42, 0.62), M["paint"], bevel=0.008)
    box(f"striscia_paratia_{side}", (side * 0.509, 2.36, 0.86), (0.004, 0.40, 0.06), M["accent"])
tube("pilone_ala_post", (0, 2.10, 0.40), (0, 2.30, 0.80), 0.025, M["carbon"])
box("luce_pioggia", (0, 2.42, 0.30), (0.10, 0.02, 0.05), M["glow"])

# ----------------------------------------------------------------------------- sospensioni

def suspension(y, track, front):
    for side in (1, -1):
        hub = Vector((side * (track / 2 - 0.12), y, R))
        ch_top = 0.50 if front else 0.46
        for dz, z_ch in ((0.10, ch_top), (-0.10, 0.22)):  # triangolo superiore e inferiore
            for dy in (-0.22, 0.22):
                tube(f"brac_{'a' if front else 'p'}_{side}_{dz}_{dy}", (side * 0.22, y + dy, z_ch), (hub.x, y, R + dz), 0.014, M["carbon"])
        tube(f"puntone_{'a' if front else 'p'}_{side}", (side * 0.20, y + (0.15 if front else -0.15), 0.52), (hub.x, y, R - 0.06), 0.012, M["carbon"])
        tube(f"sterzo_{'a' if front else 'p'}_{side}", (side * 0.22, y - 0.05, 0.36), (hub.x, y - 0.06, R + 0.02), 0.011, M["carbon"])
        # portamozzo e cestello freni (fermi, fuori dalla ruota)
        box(f"portamozzo_{'a' if front else 'p'}_{side}", (side * (track / 2 - 0.16), y, R), (0.07, 0.16, 0.24), M["carbon"], bevel=0.02)


suspension(YF, TF, True)
suspension(YR, TR, False)

# ----------------------------------------------------------------------------- numero di gara

def number_plate(name, center, size, facing):
    """Piano con UV 0..1 e materiale "number" (il gioco ci mette il numero di gara).
    facing: '+X', '-X' (fianchi) o '+Z' (sopra il muso, leggibile guardando dalla coda verso il muso)."""
    bm = bmesh.new()
    sx, sy = size
    if facing == '+X':   # visto dal lato sinistro: u verso la coda (+Y), v in alto
        corners = [(0, -sx / 2, -sy / 2), (0, sx / 2, -sy / 2), (0, sx / 2, sy / 2), (0, -sx / 2, sy / 2)]
    elif facing == '-X':  # lato destro: u verso il muso (-Y)
        corners = [(0, sx / 2, -sy / 2), (0, -sx / 2, -sy / 2), (0, -sx / 2, sy / 2), (0, sx / 2, sy / 2)]
    else:                 # sopra il muso, leggibile dall'alto con il muso in alto
        corners = [(sx / 2, sy / 2, 0), (-sx / 2, sy / 2, 0), (-sx / 2, -sy / 2, 0), (sx / 2, -sy / 2, 0)]
    vs = [bm.verts.new(Vector(c) + Vector(center)) for c in corners]
    f = bm.faces.new(vs)
    uv = bm.loops.layers.uv.new("UVMap")
    for loop_, (u, v) in zip(f.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
        loop_[uv].uv = (u, v)
    bm.normal_update()
    obj_from_bm(name, bm, M["number"], smooth=False)


number_plate("numero_muso", (0, -1.55, 0.415), (0.20, 0.20), '+Z')
number_plate("numero_cofano_sx", (0.405, 0.72, 0.58), (0.22, 0.22), '+X')
number_plate("numero_cofano_dx", (-0.405, 0.72, 0.58), (0.22, 0.22), '-X')

# ----------------------------------------------------------------------------- telecamere

for nm, loc in (("cam_cockpit", (0, -0.05, 0.76)), ("cam_hood", (0, 0.25, 1.06))):
    e = bpy.data.objects.new(nm, None)
    e.empty_display_type = 'PLAIN_AXES'
    e.empty_display_size = 0.15
    e.location = loc
    COL.objects.link(e)

# ----------------------------------------------------------------------------- curve → mesh, esportazione

for o in bpy.context.selected_objects:
    o.select_set(False)
halo.select_set(True)
bpy.context.view_layer.objects.active = halo
bpy.ops.object.convert(target='MESH')

tris = 0
dg = bpy.context.evaluated_depsgraph_get()
for o in COL.all_objects:
    if o.type == 'MESH':
        ev = o.evaluated_get(dg)
        me = ev.to_mesh()
        tris += sum(len(p.vertices) - 2 for p in me.polygons)
        ev.to_mesh_clear()

for o in bpy.context.selected_objects:
    o.select_set(False)
for o in COL.all_objects:
    o.select_set(True)
bpy.context.view_layer.objects.active = bpy.data.objects["scocca"]

os.makedirs(os.path.dirname(GLB), exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=GLB, export_format='GLB', use_selection=True, export_yup=True,
    export_apply=True, export_animations=False, export_extras=False,
)
try:
    bpy.ops.wm.save_as_mainfile(filepath=BLEND, copy=True)
except Exception as ex:  # il salvataggio della copia non è indispensabile
    print("Salvataggio .blend non riuscito:", ex)

print(f"[monoposto_f1] Fatto: {len(COL.all_objects)} oggetti, ~{tris} triangoli → {GLB}")
