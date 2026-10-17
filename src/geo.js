// Real-world geography: distances, and habitat lookup from OpenStreetMap (via the free Overpass API).
const R = 6371000;
const rad = d => (d * Math.PI) / 180;

export function distM(a, b) {
  const dLat = rad(b.latitude - a.latitude), dLon = rad(b.longitude - a.longitude);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// move `dist` metres from a point on a compass bearing (degrees)
export function offset(p, dist, bearing) {
  const d = dist / R, b = rad(bearing), la = rad(p.latitude), lo = rad(p.longitude);
  const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
  const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
  return { latitude: (la2 * 180) / Math.PI, longitude: (lo2 * 180) / Math.PI };
}

export function bearing(a, b) {
  const y = Math.sin(rad(b.longitude - a.longitude)) * Math.cos(rad(b.latitude));
  const x = Math.cos(rad(a.latitude)) * Math.sin(rad(b.latitude)) - Math.sin(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.cos(rad(b.longitude - a.longitude));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// flat x/y in metres around an origin, good enough over a few hundred metres
function toXY(o, p) {
  return { x: rad(p.longitude - o.longitude) * R * Math.cos(rad(o.latitude)), y: rad(p.latitude - o.latitude) * R };
}

function inPoly(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y || 1e-9) + a.x) inside = !inside;
  }
  return inside;
}

function segDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy || 1e-9;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function polyKind(t) {
  const L = t.leisure, U = t.landuse, N = t.natural;
  if (/^(park|garden|recreation_ground|common|playground|nature_reserve|dog_park)$/.test(L || "")) return "park";
  if (/^(grass|meadow|recreation_ground|village_green|allotments|cemetery)$/.test(U || "")) return "park";
  if (/^(wood|scrub|heath)$/.test(N || "") || U === "forest") return "woodland";
  if (/^(water|wetland)$/.test(N || "") || /^(reservoir|basin)$/.test(U || "")) return "river";
  if (U === "residential") return "garden";
  if (/^(retail|commercial)$/.test(U || "")) return "centre";
  return null;
}

const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];

export async function fetchArea(center, radius = 700) {
  const a = `(around:${radius},${center.latitude.toFixed(6)},${center.longitude.toFixed(6)})`;
  const q = `[out:json][timeout:25];(
way${a}[leisure~"^(park|garden|recreation_ground|common|playground|nature_reserve)$"];
way${a}[landuse~"^(grass|meadow|recreation_ground|village_green|allotments|cemetery|forest|residential|retail|commercial|reservoir|basin)$"];
way${a}[natural~"^(wood|scrub|heath|water|wetland)$"];
way${a}[waterway~"^(river|stream|canal|drain|ditch)$"];
way${a}[railway~"^(rail|light_rail|narrow_gauge)$"];
node${a}[amenity=place_of_worship];way${a}[amenity=place_of_worship];
node${a}[railway=station];
way${a}[highway][bridge=yes];
);out geom 1200;`;
  let json = null, lastErr = null;
  for (const url of OVERPASS) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "data=" + encodeURIComponent(q) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      json = await r.json();
      break;
    } catch (e) { lastErr = e; }
  }
  if (!json) throw lastErr || new Error("Map data unavailable");
  const origin = { latitude: center.latitude, longitude: center.longitude };
  const area = { origin, center: origin, radius, polys: [], lines: [], churches: [], stations: [], bridges: [], parks: [], woods: [], waters: [], fetchedAt: Date.now() };
  for (const el of json.elements || []) {
    const t = el.tags || {};
    if (el.type === "node") {
      const p = { latitude: el.lat, longitude: el.lon };
      if (t.amenity === "place_of_worship") area.churches.push({ id: "n" + el.id, name: t.name, ...p });
      else if (t.railway === "station") area.stations.push({ id: "n" + el.id, name: t.name, ...p });
      continue;
    }
    if (!el.geometry || el.geometry.length < 2) continue;
    const pts = el.geometry.map(g => toXY(origin, { latitude: g.lat, longitude: g.lon }));
    const mid = el.geometry[Math.floor(el.geometry.length / 2)];
    const cen = el.geometry.reduce((s, g) => ({ latitude: s.latitude + g.lat / el.geometry.length, longitude: s.longitude + g.lon / el.geometry.length }), { latitude: 0, longitude: 0 });
    if (t.amenity === "place_of_worship") { area.churches.push({ id: "w" + el.id, name: t.name, ...cen }); continue; }
    if (t.highway && t.bridge === "yes") { area.bridges.push({ id: "w" + el.id, name: t.name, latitude: mid.lat, longitude: mid.lon }); continue; }
    if (t.waterway) { area.lines.push({ kind: "river", pts, near: 35 }); continue; }
    if (t.railway) { area.lines.push({ kind: "rail", pts, near: 30 }); continue; }
    const kind = polyKind(t);
    if (!kind) continue;
    const closed = el.geometry.length > 3 && el.geometry[0].lat === el.geometry[el.geometry.length - 1].lat && el.geometry[0].lon === el.geometry[el.geometry.length - 1].lon;
    if (!closed) continue;
    const size = Math.hypot(Math.max(...pts.map(p => p.x)) - Math.min(...pts.map(p => p.x)), Math.max(...pts.map(p => p.y)) - Math.min(...pts.map(p => p.y)));
    area.polys.push({ kind, pts });
    const named = { id: "w" + el.id, name: t.name, size, ...cen };
    if (kind === "park" && t.landuse !== "cemetery") area.parks.push(named);
    if (kind === "woodland") area.woods.push(named);
    if (kind === "river") area.waters.push(named);
  }
  return area;
}

// which habitats a point belongs to (same names the game uses)
export function habsAt(area, p) {
  const h = new Set(["street"]);
  if (!area) { h.add("garden"); h.add("park"); return [...h]; }
  const pt = toXY(area.origin, p);
  let anyLand = false;
  for (const poly of area.polys) {
    if (inPoly(pt, poly.pts)) {
      anyLand = true;
      if (poly.kind === "centre") { if (Math.random() < 0.25) h.add("church"); }
      else h.add(poly.kind);
    }
  }
  for (const ln of area.lines) {
    for (let i = 1; i < ln.pts.length; i++) if (segDist(pt, ln.pts[i - 1], ln.pts[i]) < ln.near) { h.add(ln.kind); break; }
  }
  for (const c of area.churches) if (distM(c, p) < 70) h.add("church");
  if (!anyLand && !h.has("park")) h.add("garden"); // unmapped suburbs are mostly gardens
  return [...h];
}
