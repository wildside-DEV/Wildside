// Game rules shared by the app: spawning, Dens, items, levels.
import { SPECIES, BY, RAR } from "./species";
import { distM, offset, habsAt } from "./geo";

export const ENCOUNTER_RANGE_M = 40;   // how close you need to be to track an animal
export const DEN_RANGE_M = 40;         // how close you need to be to spin a Den
export const DEN_COOLDOWN = 5 * 60 * 1000;
export const LURE_MS = 3 * 60 * 1000;
export const BAG_MAX = 60;
export const MAX_SPAWNS = 10;

export const ITEMS = {
  seed: { name: "Bird seed", desc: "Scatter it where you stand. Extra birds turn up nearby for 3 minutes.", col: "#C9961A" },
  lens: { name: "Zoom lens", desc: "Use while tracking to get one step closer without moving.", col: "#2A66AE" },
  hide: { name: "Hide", desc: "Use while tracking. The next time the animal spots you, it doesn't count.", col: "#2F7F4A" },
  page: { name: "Field journal page", desc: "Notes from another naturalist. Worth 50 XP.", col: "#B0186F" },
};

export const newSave = () => ({ xp: 0, rec: {}, dens: {}, denSeen: {}, bag: { seed: 1, lens: 2, hide: 1 } });

export function levelOf(xp) { return Math.floor(Math.sqrt(xp / 40)) + 1; }
export const RANKS = [[1, "Kerb Spotter"], [3, "Hedge Watcher"], [5, "Dusk Tracker"], [8, "Field Naturalist"], [12, "Urban Ranger"]];
export const rankOf = lv => RANKS.filter(r => lv >= r[0]).pop()[1];

export function phase(h) { return h >= 5 && h < 7.5 ? "Dawn" : h >= 7.5 && h < 17 ? "Day" : h >= 17 && h < 20 ? "Dusk" : "Night"; }
export function season(m) { return [12, 1, 2].includes(m) ? "Winter" : [3, 4, 5].includes(m) ? "Spring" : [6, 7, 8].includes(m) ? "Summer" : "Autumn"; }
export function nowHour() { const d = new Date(); return d.getHours() + d.getMinutes() / 60; }
export function nowMonth() { return new Date().getMonth() + 1; }

function activeAt(s, h) { const [a, b] = s.hrs; if (a === 0 && b === 24) return true; return a < b ? h >= a && h < b : h >= a || h < b; }
export function eligible(habs, h, m) { return SPECIES.filter(s => s.mon.includes(m) && activeAt(s, h) && s.hab.some(x => habs.includes(x))); }
export function stillActive(sp, h, m) { return sp.mon.includes(m) && activeAt(sp, h); }

const BIRD_SHAPES = new Set(["bird", "wader", "duck", "owl"]);
let uid = 1;

// one new spawn near the player (or near a seed patch), or null
export function makeSpawn(area, player, spawns, lure) {
  const h = nowHour(), m = nowMonth();
  const lured = lure && lure.until > Date.now() && Math.random() < 0.6;
  for (let tries = 0; tries < 8; tries++) {
    const center = lured ? lure : player;
    const p = offset(center, lured ? 8 + Math.random() * 55 : 25 + Math.random() * 170, Math.random() * 360);
    if (spawns.some(s => distM(s, p) < 18)) continue;
    let list = eligible(habsAt(area, p), h, m);
    if (lured) { const birds = list.filter(s => BIRD_SHAPES.has(s.shape)); if (birds.length) list = birds; }
    if (!list.length) continue;
    let tot = list.reduce((t, s) => t + RAR[s.rar].w, 0), pick = Math.random() * tot, sp = list[0];
    for (const s of list) { pick -= RAR[s.rar].w; if (pick <= 0) { sp = s; break; } }
    const now = Date.now();
    return { id: "s" + now + "_" + uid++, sp: sp.id, latitude: p.latitude, longitude: p.longitude, born: now, until: now + (4 + Math.random() * 4) * 60000 };
  }
  return null;
}

export function pruneSpawns(spawns, player) {
  const h = nowHour(), m = nowMonth(), now = Date.now();
  return spawns.filter(s => s.until > now && distM(s, player) < 450 && stillActive(BY[s.sp], h, m));
}

const BLURB = {
  Churchyard: "Old walls, yews and ivy. Good for wrens, jackdaws and, at night, owls.",
  Railway: "Rail embankments are long wildlife corridors. Look for butterflies and foxes.",
  Park: "Lawns, hedges and big trees. Check the edges at dawn and dusk.",
  Woodland: "Dead wood and leaf litter: beetles, slow-worms and woodpeckers.",
  Water: "Still or running water draws herons, egrets and dragonflies.",
  Bridge: "Watch the water below for a flash of kingfisher blue.",
  Wayside: "A quiet corner. Even small patches of green hold wildlife.",
};

// pick up to 12 Dens from real landmarks, spread at least 90 m apart
export function densFromArea(area, center) {
  if (!area) return [];
  const cand = [];
  const add = (list, kind, fallback, prio) => list.forEach(p => cand.push({ id: "den_" + p.id, kind, name: p.name ? p.name : fallback, blurb: BLURB[kind], latitude: p.latitude, longitude: p.longitude, prio: prio + (p.name ? 0 : 1) + (p.size ? Math.max(0, 1 - p.size / 400) : 0) }));
  add(area.churches, "Churchyard", "Churchyard", 0);
  add(area.stations, "Railway", "Station", 0);
  add(area.parks.filter(p => p.size > 40), "Park", "Green space", 1);
  add(area.woods.filter(p => p.size > 40), "Woodland", "Woodland", 1);
  add(area.waters.filter(p => p.size > 25), "Water", "Pond", 1);
  add(area.bridges, "Bridge", "Bridge", 2);
  cand.sort((a, b) => a.prio - b.prio || distM(a, center) - distM(b, center));
  const out = [];
  for (const c of cand) {
    if (distM(c, center) > area.radius) continue;
    if (out.some(o => distM(o, c) < 90)) continue;
    out.push(c); if (out.length >= 12) break;
  }
  if (out.length < 3) {
    // not many mapped landmarks: add wayside dens so there is always something to spin
    for (let i = 0; out.length < 3 && i < 12; i++) {
      const p = offset(center, 80 + i * 35, (i * 137) % 360);
      if (out.some(o => distM(o, p) < 90)) continue;
      out.push({ id: `den_way_${p.latitude.toFixed(4)}_${p.longitude.toFixed(4)}`, kind: "Wayside", name: "Wayside den", blurb: BLURB.Wayside, latitude: p.latitude, longitude: p.longitude, prio: 9 });
    }
  }
  return out;
}

export const denReady = (save, d) => !(save.dens[d.id] > 0) || Date.now() - save.dens[d.id] >= DEN_COOLDOWN;
export const denLeft = (save, d) => Math.max(0, DEN_COOLDOWN - (Date.now() - (save.dens[d.id] || 0)));
export const bagTotal = save => Object.values(save.bag || {}).reduce((a, b) => a + b, 0);
export const fmtMS = ms => { const s = Math.ceil(ms / 1000); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };

function rollItem() { const r = Math.random(); return r < 0.36 ? "lens" : r < 0.63 ? "seed" : r < 0.9 ? "hide" : "page"; }

// spin a Den: returns a new save plus what was found
export function spinDen(save, den) {
  const first = !save.denSeen[den.id];
  const n = 3 + (first ? 2 : 0) + (Math.random() < 0.2 ? 1 : 0);
  const got = {}; let xp = first ? 100 : 25, full = 0;
  const bag = { ...save.bag };
  for (let i = 0; i < n; i++) {
    const k = rollItem();
    if (k === "page") { xp += 50; got.page = (got.page || 0) + 1; continue; }
    if (Object.values(bag).reduce((a, b) => a + b, 0) >= BAG_MAX) { full++; continue; }
    bag[k] = (bag[k] || 0) + 1; got[k] = (got[k] || 0) + 1;
  }
  const next = { ...save, xp: save.xp + xp, bag, dens: { ...save.dens, [den.id]: Date.now() }, denSeen: { ...save.denSeen, [den.id]: true } };
  return { save: next, got, xp, first, full };
}
