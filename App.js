import React, { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, Pressable, StyleSheet, ScrollView, Modal, Animated, PanResponder, Switch, Platform, ActivityIndicator, Easing, Linking } from "react-native";
import { StatusBar } from "expo-status-bar";
import MapView, { Marker, Circle } from "react-native-maps";
import * as Location from "expo-location";
import * as Haptics from "expo-haptics";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { WebView } from "react-native-webview";
import { SvgXml } from "react-native-svg";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { createAudioPlayer, setAudioModeAsync } from "expo-audio";

import { BY, SVGS, SHADOWS, RARCOL } from "./src/species";
import { distM, offset, bearing, fetchArea, habsAt } from "./src/geo";
import {
  ENCOUNTER_RANGE_M, DEN_RANGE_M, LURE_MS, MAX_SPAWNS, BAG_MAX, ITEMS, newSave, levelOf, rankOf, phase, season, nowHour, nowMonth,
  makeSpawn, pruneSpawns, densFromArea, denReady, denLeft, bagTotal, fmtMS, spinDen,
} from "./src/game";
import { WEB_BASE } from "./src/config";
import { DEN_DISC, DEN_ICON, ITEM_ICON, EXPLORER } from "./src/art";

const C = {
  bg: "#EEF1EC", surface: "#FBFCF9", ink: "#1D2622", muted: "#5C6B63", line: "#CDD5CF", accent: "#B0186F",
  teal: "#18A999", lilac: "#9B8BD0", blue: "#1A73E8", plate: "#E6E3D6", good: "#2F7F4A", bad: "#B23A2E",
};
const SAVE_KEY = "wildside.v1";
const PREFS_KEY = "wildside.app";
const DEFAULT_START = { latitude: 51.3405, longitude: 0.734 }; // Sittingbourne High Street, used for test walking without GPS
const pt = c => ({ latitude: c.latitude, longitude: c.longitude });
const fallbackArea = p => ({ origin: p, center: p, radius: 700, polys: [], lines: [], churches: [], stations: [], bridges: [], parks: [], woods: [], waters: [], fallback: true, fetchedAt: Date.now() });
const haptic = (kind = "light") => {
  try {
    if (kind === "success") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    else if (kind === "warn") Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    else Haptics.impactAsync(kind === "heavy" ? Haptics.ImpactFeedbackStyle.Heavy : kind === "medium" ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light);
  } catch (e) {}
};

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <Game />
    </SafeAreaProvider>
  );
}

function Game() {
  const insets = useSafeAreaInsets();
  const mapRef = useRef(null);
  const [perm, setPerm] = useState("asking");
  const [gps, setGps] = useState(null);
  const [heading, setHeading] = useState(0);
  const [sim, setSim] = useState(null);
  const [prefs, setPrefs] = useState({ simOn: false, sound: true });
  const [area, setArea] = useState(null);
  const [areaState, setAreaState] = useState("idle");
  const [spawns, setSpawns] = useState([]);
  const [dens, setDens] = useState([]);
  const [save, setSaveState] = useState(null);
  const [sheet, setSheet] = useState(null);
  const [web, setWeb] = useState(null);
  const [toastMsg, setToastMsg] = useState(null);
  const [follow, setFollow] = useState(true);
  const [lure, setLure] = useState(null);
  const [, setTick] = useState(0);

  const player = prefs.simOn ? sim || gps || DEFAULT_START : gps;
  const refs = useRef({});
  refs.current = { player, area, lure, save, prefs, spawns };
  const ignoreMapPress = useRef(0);
  const simTarget = useRef(null);
  const pending = useRef(null);
  const loadingArea = useRef(false);
  const toastTimer = useRef(null);

  const toast = msg => { setToastMsg(msg); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToastMsg(null), 2400); };
  const setSave = next => { setSaveState(next); AsyncStorage.setItem(SAVE_KEY, JSON.stringify(next)).catch(() => {}); };
  const setPref = (k, v) => setPrefs(p => { const n = { ...p, [k]: v }; AsyncStorage.setItem(PREFS_KEY, JSON.stringify(n)).catch(() => {}); return n; });

  // ---- load save + prefs ----
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(SAVE_KEY);
        const s = raw ? JSON.parse(raw) : null;
        setSaveState(s ? { ...newSave(), ...s, bag: { seed: 0, lens: 0, hide: 0, ...(s.bag || {}) }, dens: s.dens || {}, denSeen: s.denSeen || {} } : newSave());
      } catch (e) { setSaveState(newSave()); }
      try { const p = JSON.parse((await AsyncStorage.getItem(PREFS_KEY)) || "null"); if (p) setPrefs(q => ({ ...q, ...p })); } catch (e) {}
    })();
  }, []);

  // ---- location ----
  useEffect(() => {
    let sub, hsub, alive = true;
    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (!alive) return;
        if (status !== "granted") { setPerm("denied"); return; }
        setPerm("granted");
        const last = await Location.getLastKnownPositionAsync();
        if (last && alive) setGps(pt(last.coords));
        sub = await Location.watchPositionAsync({ accuracy: Location.Accuracy.BestForNavigation, distanceInterval: 2, timeInterval: 1000 }, loc => setGps(pt(loc.coords)));
        try { hsub = await Location.watchHeadingAsync(h => setHeading(h.trueHeading >= 0 ? h.trueHeading : h.magHeading)); } catch (e) {}
      } catch (e) { setPerm("denied"); }
    })();
    return () => { alive = false; sub && sub.remove(); hsub && hsub.remove(); };
  }, []);

  // ---- real map data for habitats and Dens ----
  useEffect(() => {
    if (!player || loadingArea.current) return;
    if (area && !area.fallback && distM(player, area.center) < 350) return;
    if (area && area.fallback && Date.now() - area.fetchedAt < 60000 && distM(player, area.center) < 350) return;
    loadingArea.current = true; setAreaState("loading");
    const at = { ...player };
    fetchArea(at, 700)
      .then(a => { setArea(a); setAreaState("ok"); setDens(densFromArea(a, at)); })
      .catch(() => { const f = fallbackArea(at); setArea(f); setAreaState("error"); setDens(d => (d.length ? d : densFromArea(f, at))); })
      .finally(() => { loadingArea.current = false; });
  }, [player && player.latitude, player && player.longitude, area]);

  // ---- spawning ----
  useEffect(() => {
    const spawnOnce = () => {
      const { player: p, area: a, lure: l } = refs.current;
      if (!p) return;
      setSpawns(prev => {
        let list = pruneSpawns(prev, p);
        const max = MAX_SPAWNS + (l && l.until > Date.now() ? 5 : 0);
        if (list.length < max) { const s = makeSpawn(a, p, list, l); if (s) list = [...list, s]; }
        return list;
      });
    };
    const t1 = setInterval(spawnOnce, 3500);
    const t2 = setInterval(() => setTick(x => x + 1), 1000);
    return () => { clearInterval(t1); clearInterval(t2); };
  }, []);
  useEffect(() => {
    if (!area) return;
    for (let i = 0; i < 5; i++) setTimeout(() => {
      const { player: p, lure: l } = refs.current; if (!p) return;
      setSpawns(prev => { const s = makeSpawn(area, p, prev, l); return s ? [...prev, s] : prev; });
    }, 150 * i);
  }, [area]);

  // ---- test walking (tap the map to move) ----
  useEffect(() => {
    if (prefs.simOn && !sim) setSim(gps || DEFAULT_START);
  }, [prefs.simOn, gps]);
  useEffect(() => {
    const t = setInterval(() => {
      const tg = simTarget.current; if (!tg) return;
      setSim(cur => {
        if (!cur) return cur;
        const d = distM(cur, tg);
        if (d < 1.5) { simTarget.current = null; return { latitude: tg.latitude, longitude: tg.longitude }; }
        return offset(cur, Math.min(d, 1.8), bearing(cur, tg));
      });
    }, 200);
    return () => clearInterval(t);
  }, []);
  const walkTo = (target, then) => { simTarget.current = { latitude: target.latitude, longitude: target.longitude }; pending.current = then || null; setFollow(true); };

  // arriving at something you tapped while test walking
  useEffect(() => {
    const pd = pending.current; if (!pd || !player) return;
    if (pd.kind === "spawn") {
      const s = spawns.find(x => x.id === pd.id);
      if (!s) { pending.current = null; return; }
      if (distM(s, player) <= ENCOUNTER_RANGE_M * 0.8) { pending.current = null; simTarget.current = null; openEncounter(s); }
    } else if (pd.kind === "den") {
      const d = dens.find(x => x.id === pd.id);
      if (d && distM(d, player) <= DEN_RANGE_M * 0.8) { pending.current = null; simTarget.current = null; setSheet({ type: "den", den: d }); }
    }
  }, [player && player.latitude, player && player.longitude]);

  // ---- camera follows the player ----
  useEffect(() => {
    if (!player || !mapRef.current || !follow) return;
    mapRef.current.animateCamera({ center: player, pitch: 55, altitude: 330, zoom: 17.6 }, { duration: 700 });
  }, [player && player.latitude, player && player.longitude, follow]);

  // ---- soundtrack (streams from the web side) ----
  const audio = useRef({});
  const h = nowHour();
  const nightish = h >= 17 || h < 7.5;
  const playing = prefs.sound && !web && perm !== "asking";
  useEffect(() => { setAudioModeAsync({ playsInSilentMode: true }).catch(() => {}); }, []);
  useEffect(() => {
    const a = audio.current;
    try {
      if (!playing) { a.music && a.music.pause(); a.amb && a.amb.pause(); return; }
      const musicUri = WEB_BASE + (nightish ? "audio/music_fieldofdreams.mp3" : "audio/music_town.mp3");
      const ambUri = WEB_BASE + (h >= 20 || h < 5.5 ? "audio/amb_crickets.mp3" : "audio/amb_park_birds.mp3");
      if (!a.music) { a.music = createAudioPlayer({ uri: musicUri }); a.musicUri = musicUri; }
      else if (a.musicUri !== musicUri) { a.music.replace({ uri: musicUri }); a.musicUri = musicUri; }
      if (!a.amb) { a.amb = createAudioPlayer({ uri: ambUri }); a.ambUri = ambUri; }
      else if (a.ambUri !== ambUri) { a.amb.replace({ uri: ambUri }); a.ambUri = ambUri; }
      a.music.loop = true; a.music.volume = 0.3; a.music.play();
      a.amb.loop = true; a.amb.volume = 0.45; a.amb.play();
    } catch (e) {}
  }, [playing, nightish, h >= 20 || h < 5.5]);
  useEffect(() => () => { const a = audio.current; try { a.music && a.music.remove(); a.amb && a.amb.remove(); } catch (e) {} }, []);

  // ---- actions ----
  function openEncounter(s) { haptic("medium"); setWeb({ mode: "encounter", spawn: s }); }
  function tapSpawn(s) {
    ignoreMapPress.current = Date.now();
    if (!player) return;
    const d = distM(s, player);
    if (d <= ENCOUNTER_RANGE_M) openEncounter(s);
    else if (prefs.simOn) { walkTo(s, { kind: "spawn", id: s.id }); toast("Walking closer…"); }
    else toast(`${Math.round(d)} m away. Walk closer to track it.`);
  }
  function tapDen(d) { ignoreMapPress.current = Date.now(); haptic(); setSheet({ type: "den", den: d }); }
  function mapPress(e) {
    if (Date.now() - ignoreMapPress.current < 400) return;
    if (prefs.simOn && e.nativeEvent && e.nativeEvent.coordinate) { walkTo(e.nativeEvent.coordinate); }
  }
  function recenter() { setFollow(true); if (player && mapRef.current) mapRef.current.animateCamera({ center: player, pitch: 55, heading: 0, altitude: 330, zoom: 17.6 }, { duration: 500 }); }
  function scatterSeed() {
    if (!save || !(save.bag.seed > 0) || !player) return;
    const ext = lure && lure.until > Date.now() && distM(lure, player) < 30;
    setLure({ latitude: player.latitude, longitude: player.longitude, until: (ext ? lure.until : Date.now()) + LURE_MS });
    setSave({ ...save, bag: { ...save.bag, seed: save.bag.seed - 1 } });
    setSheet(null); haptic("success");
    toast(ext ? "More seed scattered. 3 extra minutes." : "Seed scattered. Birds will drop in for 3 minutes.");
  }
  function onWebMessage(e) {
    let m; try { m = JSON.parse(e.nativeEvent.data); } catch (err) { return; }
    if (m.type === "save" && m.save) setSave({ ...save, ...m.save });
    if (m.type === "result" && web && web.spawn) {
      haptic(m.result === "caught" ? "success" : "warn");
      if (m.result === "caught" || m.result === "fled") setSpawns(p => p.filter(x => x.id !== web.spawn.id));
    }
    if (m.type === "close") setWeb(null);
  }

  // ---- derived ----
  const nearby = useMemo(() => {
    if (!player) return { animals: [], dens: [] };
    const animals = spawns.map(s => ({ s, d: distM(s, player) })).filter(o => o.d <= 300).sort((a, b) => a.d - b.d);
    const nd = dens.map(d => ({ den: d, d: distM(d, player) })).filter(o => o.d <= 400).sort((a, b) => a.d - b.d).slice(0, 2);
    return { animals, dens: nd };
  }, [spawns, dens, player && player.latitude, player && player.longitude]);

  if (!save) return <View style={[styles.fill, styles.center]}><ActivityIndicator color={C.accent} /></View>;

  if (perm === "denied" && !prefs.simOn) {
    return (
      <View style={[styles.fill, styles.center, { padding: 28, backgroundColor: C.bg }]}>
        <Text style={styles.wordmark}>WILD<Text style={{ color: C.accent }}>SIDE</Text></Text>
        <Text style={[styles.p, { textAlign: "center", marginTop: 12 }]}>Wildside needs your location to show the wildlife around you. You can allow it in Settings → Privacy → Location Services → Expo Go.</Text>
        <Pressable style={[styles.btnPrimary, { marginTop: 18 }]} onPress={() => Linking.openSettings()}><Text style={styles.btnPrimaryT}>Open Settings</Text></Pressable>
        <Pressable style={[styles.btn, { marginTop: 10 }]} onPress={() => setPref("simOn", true)}><Text style={styles.btnT}>Try test walking instead</Text></Pressable>
      </View>
    );
  }

  const lv = levelOf(save.xp), lo = 40 * (lv - 1) ** 2, hi = 40 * lv ** 2;
  const tracked = id => !!(save.rec[id] && save.rec[id].tracked);
  const lureOn = lure && lure.until > Date.now();
  const playerHeading = prefs.simOn && simTarget.current && player ? bearing(player, simTarget.current) : heading;

  return (
    <View style={styles.fill}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        mapType={Platform.OS === "ios" ? "mutedStandard" : "standard"}
        showsUserLocation={false}
        showsBuildings
        pitchEnabled
        rotateEnabled
        showsPointsOfInterest={false}
        showsCompass={false}
        toolbarEnabled={false}
        initialCamera={{ center: player || DEFAULT_START, pitch: 55, heading: 0, altitude: 330, zoom: 17.6 }}
        onPanDrag={() => setFollow(false)}
        onPress={mapPress}
      >
        {player && <Circle center={player} radius={ENCOUNTER_RANGE_M} strokeColor="rgba(26,115,232,0.65)" strokeWidth={2} fillColor="rgba(26,115,232,0.08)" />}
        {lureOn && <Circle center={lure} radius={55} strokeColor="rgba(224,184,58,0.85)" strokeWidth={2} fillColor="rgba(245,215,110,0.18)" />}
        {dens.map(d => (
          <Marker key={d.id + (denReady(save, d) ? "r" : "c")} coordinate={d} anchor={{ x: 0.5, y: 0.9 }} centerOffset={{ x: 0, y: -22 }} onPress={() => tapDen(d)} tracksViewChanges={false}>
            <DenPin ready={denReady(save, d)} />
          </Marker>
        ))}
        {spawns.map(s => (
          <Marker key={s.id} coordinate={s} anchor={{ x: 0.5, y: 0.5 }} onPress={() => tapSpawn(s)} tracksViewChanges={false}>
            <AnimalPin sp={BY[s.sp]} />
          </Marker>
        ))}
        {player && (
          <Marker coordinate={player} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false} zIndex={999}>
            <PlayerPin heading={playerHeading} />
          </Marker>
        )}
      </MapView>

      {/* top bar */}
      <View style={[styles.top, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
        <View style={[styles.card, { flex: 1 }]}>
          <Text style={styles.wordmark}>WILD<Text style={{ color: C.accent }}>SIDE</Text></Text>
          <View style={styles.rowBetween}><Text style={styles.small}>{rankOf(lv)}</Text><Text style={styles.small}>Lv {lv} · {save.xp} XP</Text></View>
          <View style={styles.xpbar}><View style={[styles.xpfill, { width: `${Math.round(((save.xp - lo) / (hi - lo)) * 100)}%` }]} /></View>
        </View>
        <View style={[styles.card, { alignItems: "flex-end", minWidth: 120 }]}>
          <Text style={styles.clock}>{new Date().toTimeString().slice(0, 5)}</Text>
          <Text style={styles.small}>{phase(h)} · {season(nowMonth())}</Text>
          <Text style={[styles.tiny, { color: areaState === "error" ? C.bad : C.muted }]}>
            {areaState === "loading" ? "Reading the map…" : areaState === "error" ? "Map data offline" : prefs.simOn ? "Test walking" : "GPS live"}
          </Text>
        </View>
      </View>

      {/* right-side map controls */}
      <View style={[styles.mapctl, { bottom: insets.bottom + 168 }]}>
        <Pressable style={styles.iconBtn} onPress={recenter} accessibilityLabel="Centre on me"><Text style={[styles.iconT, { color: follow ? C.blue : C.ink }]}>◎</Text></Pressable>
      </View>

      {/* bottom: nearby + buttons */}
      <View style={[styles.bottom, { paddingBottom: insets.bottom + 10 }]} pointerEvents="box-none">
        <View style={styles.card}>
          <View style={styles.rowBetween}>
            <Text style={styles.label}>NEARBY</Text>
            <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
              {lureOn && <Text style={styles.lureChip}>Seed {fmtMS(lure.until - Date.now())}</Text>}
              <Text style={styles.small}>{nearby.animals.filter(o => o.d <= ENCOUNTER_RANGE_M).length ? `${nearby.animals.filter(o => o.d <= ENCOUNTER_RANGE_M).length} in range` : nearby.animals.length ? `${nearby.animals.length} within 300 m` : ""}</Text>
            </View>
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingTop: 6, minHeight: 66 }}>
            {nearby.dens.map(({ den, d }) => {
              const r = d <= DEN_RANGE_M, ready = denReady(save, den);
              return (
                <Pressable key={den.id} style={styles.chip} onPress={() => tapDen(den)}>
                  <View style={[styles.chipIc, { borderRadius: 12, borderColor: ready ? C.teal : C.lilac, backgroundColor: ready ? "#E3F4F1" : C.plate }, r && styles.inRange]}>
                    <SvgXml xml={DEN_ICON} width={28} height={28} />
                  </View>
                  <Text style={[styles.chipD, r && { color: C.blue }]}>{r ? "in range" : `${Math.round(d / 10) * 10} m`}</Text>
                </Pressable>
              );
            })}
            {nearby.animals.slice(0, 10).map(({ s, d }) => {
              const sp = BY[s.sp], seen = tracked(sp.id), r = d <= ENCOUNTER_RANGE_M;
              return (
                <Pressable key={s.id} style={styles.chip} onPress={() => tapSpawn(s)}>
                  <View style={[styles.chipIc, { borderColor: RARCOL[sp.rar], borderWidth: sp.rar === "rare" || sp.rar === "legendary" ? 3 : 2 }, r && styles.inRange]}>
                    <SvgXml xml={seen ? SVGS[sp.id] : SHADOWS[sp.id]} width={30} height={30} />
                    {!seen && <Text style={styles.newTag}>NEW</Text>}
                  </View>
                  <Text style={[styles.chipD, r && { color: C.blue }]}>{r ? "in range" : `${Math.max(10, Math.round(d / 10) * 10)} m`}</Text>
                </Pressable>
              );
            })}
            {!nearby.animals.length && <Text style={[styles.small, { alignSelf: "center" }]}>{player ? "No animals close by. Keep walking." : "Finding your location…"}</Text>}
          </ScrollView>
        </View>
        <View style={styles.btnRow}>
          <Pressable style={styles.iconBtn} onPress={() => setSheet({ type: "settings" })} accessibilityLabel="Settings"><Text style={styles.iconT}>⚙︎</Text></Pressable>
          <Pressable style={styles.iconBtn} onPress={() => setSheet({ type: "bag" })} accessibilityLabel="Bag">
            <SvgXml xml={ITEM_ICON.bag} width={20} height={20} />
            <View style={styles.badge}><Text style={styles.badgeT}>{bagTotal(save)}</Text></View>
          </Pressable>
          <Pressable style={styles.btnPrimary} onPress={() => setWeb({ mode: "guide" })}>
            <Text style={styles.btnPrimaryT}>Field Guide  <Text style={{ fontWeight: "400", fontSize: 12 }}>{Object.values(save.rec).filter(r => r.tracked).length}/41</Text></Text>
          </Pressable>
        </View>
      </View>

      {toastMsg && <View style={[styles.toast, { top: insets.top + 96 }]} pointerEvents="none"><Text style={styles.toastT}>{toastMsg}</Text></View>}

      {sheet && sheet.type === "den" && (
        <DenSheet den={sheet.den} save={save} player={player} simOn={prefs.simOn}
          onClose={() => setSheet(null)}
          onWalk={() => { walkTo(sheet.den, { kind: "den", id: sheet.den.id }); setSheet(null); toast("Heading for the den…"); }}
          onResult={r => { setSave(r.save); }} />
      )}
      {sheet && sheet.type === "bag" && <BagSheet save={save} lureOn={lureOn} onSeed={scatterSeed} onClose={() => setSheet(null)} />}
      {sheet && sheet.type === "settings" && <SettingsSheet prefs={prefs} setPref={setPref} perm={perm} onClose={() => setSheet(null)} />}

      {web && <GameWeb web={web} save={save} area={area} onMessage={onWebMessage} onClose={() => setWeb(null)} insets={insets} />}
    </View>
  );
}

// ---------------- map pins ----------------
function AnimalPin({ sp }) {
  return (
    <View style={[styles.pin, { borderColor: RARCOL[sp.rar], borderWidth: sp.rar === "common" ? 2 : 3 }]}>
      <SvgXml xml={SVGS[sp.id]} width={28} height={28} />
    </View>
  );
}
function DenPin({ ready }) {
  return (
    <View style={{ alignItems: "center" }}>
      <View style={[styles.denPin, { backgroundColor: ready ? C.teal : C.lilac }]}><SvgXml xml={DEN_ICON} width={26} height={26} /></View>
      <View style={[styles.denPost, { backgroundColor: ready ? C.teal : C.lilac }]} />
    </View>
  );
}
function PlayerPin({ heading }) {
  return (
    <View style={{ width: 54, height: 54, alignItems: "center", justifyContent: "center" }}>
      <View style={[styles.beam, { transform: [{ rotate: `${heading || 0}deg` }] }]}><View style={styles.beamTip} /></View>
      <SvgXml xml={EXPLORER} width={34} height={34} />
    </View>
  );
}

// ---------------- Den sheet with a spinning disc ----------------
function DenSheet({ den, save, player, simOn, onClose, onWalk, onResult }) {
  const rot = useRef(new Animated.Value(0)).current;
  const angle = useRef(0);
  const [spinning, setSpinning] = useState(false);
  const [loot, setLoot] = useState(null);
  const dist = player ? distM(den, player) : 9999;
  const near = dist <= DEN_RANGE_M, ready = denReady(save, den);
  const stateRef = useRef({}); stateRef.current = { near, ready, spinning, save, den, onResult };

  const doSpin = () => {
    const st = stateRef.current;
    if (st.spinning || !st.ready || !st.near) return;
    st.spinning = true;
    setSpinning(true); haptic("heavy");
    const target = Math.ceil((angle.current + 900) / 360) * 360;
    Animated.timing(rot, { toValue: target, duration: 1400, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start(() => {
      angle.current = target;
      const cur = stateRef.current;
      const r = spinDen(cur.save, cur.den);
      cur.onResult(r); setLoot(r); setSpinning(false);
      haptic("success");
      Object.keys(r.got).forEach((k, i) => setTimeout(() => haptic("light"), 120 * (i + 1)));
    });
  };
  stateRef.current.doSpin = doSpin;
  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderMove: (e, g) => { if (!stateRef.current.spinning) rot.setValue(angle.current + g.dx * 0.8); },
    onPanResponderRelease: (e, g) => {
      if (Math.abs(g.dx) > 40 && stateRef.current.near && stateRef.current.ready) { angle.current = angle.current + g.dx * 0.8; stateRef.current.doSpin(); }
      else Animated.spring(rot, { toValue: angle.current, useNativeDriver: true }).start();
    },
  })).current;
  const rotate = rot.interpolate({ inputRange: [-100000, 100000], outputRange: ["-100000deg", "100000deg"] });

  let status, action, actionLabel;
  if (spinning) { status = "Searching…"; }
  else if (loot) { status = loot.full ? `Bag full. ${loot.full} left behind.` : "Found some kit!"; action = onClose; actionLabel = "Close"; }
  else if (!ready) { status = `Searched. Refills in ${fmtMS(denLeft(save, den))}`; action = onClose; actionLabel = "Close"; }
  else if (!near) { status = `${Math.round(dist)} m away. Walk closer to search it.`; action = simOn ? onWalk : onClose; actionLabel = simOn ? "Walk there" : "Close"; }
  else { status = save.denSeen[den.id] ? "Swipe the disc to search the den." : "New den! Swipe the disc for a first-visit bonus."; action = doSpin; actionLabel = "Spin the den"; }
  const ringColor = ready || loot ? (loot ? C.lilac : C.teal) : C.lilac;

  return (
    <Sheet onClose={onClose} eyebrow={`DEN · ${den.kind.toUpperCase()}`} title={den.name}>
      <Text style={styles.p}>{den.blurb}</Text>
      <View style={{ alignItems: "center", paddingVertical: 10 }}>
        <Animated.View {...pan.panHandlers} style={[styles.disc, { borderColor: ringColor, opacity: !near && ready ? 0.7 : 1, transform: [{ rotate }] }]}>
          <SvgXml xml={DEN_DISC} width="100%" height="100%" />
        </Animated.View>
      </View>
      <Text style={[styles.denState, { color: !ready && !loot ? "#6E5DB0" : !near ? C.muted : C.ink }]}>{status}</Text>
      {action && <Pressable style={[styles.btnPrimary, { alignSelf: "stretch", marginTop: 10 }]} onPress={action}><Text style={styles.btnPrimaryT}>{actionLabel}</Text></Pressable>}
      {loot && (
        <View style={styles.lootGrid}>
          {Object.keys(loot.got).map(k => (
            <View key={k} style={styles.lootItem}><SvgXml xml={ITEM_ICON[k]} width={26} height={26} /><Text style={styles.lootT}>{loot.got[k]}× {ITEMS[k].name}</Text></View>
          ))}
          <View style={styles.lootItem}><Text style={[styles.lootT, { color: C.accent }]}>+{loot.xp} XP{loot.first ? " · first visit" : ""}</Text></View>
        </View>
      )}
    </Sheet>
  );
}

function BagSheet({ save, lureOn, onSeed, onClose }) {
  return (
    <Sheet onClose={onClose} eyebrow={`BAG · ${bagTotal(save)}/${BAG_MAX}`} title="Your kit">
      {["seed", "lens", "hide"].map(k => (
        <View key={k} style={styles.bagRow}>
          <SvgXml xml={ITEM_ICON[k]} width={30} height={30} />
          <View style={{ flex: 1 }}><Text style={styles.bagName}>{ITEMS[k].name}</Text><Text style={styles.small}>{ITEMS[k].desc}</Text></View>
          <Text style={styles.bagCt}>{save.bag[k] || 0}</Text>
          {k === "seed" && <Pressable disabled={!(save.bag.seed > 0)} style={[styles.btn, { opacity: save.bag.seed > 0 ? 1 : 0.4 }]} onPress={onSeed}><Text style={styles.btnT}>{lureOn ? "Add more" : "Scatter"}</Text></Pressable>}
        </View>
      ))}
      <Text style={[styles.small, { marginTop: 6 }]}>Spin Dens to collect more. Dens refill 5 minutes after you search them. Zoom lens and Hide are used during tracking.</Text>
    </Sheet>
  );
}

function SettingsSheet({ prefs, setPref, perm, onClose }) {
  return (
    <Sheet onClose={onClose} eyebrow="SETTINGS" title="Wildside">
      <View style={styles.setRow}>
        <View style={{ flex: 1 }}><Text style={styles.bagName}>Test walking</Text><Text style={styles.small}>Tap the map to move your explorer, for testing indoors. Turn off to use real GPS{perm === "denied" ? " (location is currently off for Expo Go)" : ""}.</Text></View>
        <Switch value={prefs.simOn} onValueChange={v => setPref("simOn", v)} trackColor={{ true: C.accent }} />
      </View>
      <View style={styles.setRow}>
        <View style={{ flex: 1 }}><Text style={styles.bagName}>Music and nature sounds</Text><Text style={styles.small}>Plays even with the silent switch on.</Text></View>
        <Switch value={prefs.sound} onValueChange={v => setPref("sound", v)} trackColor={{ true: C.accent }} />
      </View>
      <Text style={[styles.small, { marginTop: 10 }]}>Habitats and Dens come from OpenStreetMap. Map data © OpenStreetMap contributors. 3D models, music and sounds are credited in the Field Guide.</Text>
    </Sheet>
  );
}

function Sheet({ children, onClose, eyebrow, title }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal transparent animationType="slide" onRequestClose={onClose} visible>
      <Pressable style={styles.scrim} onPress={onClose} />
      <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
        <View style={styles.sheetHead}>
          <View style={{ flex: 1 }}><Text style={styles.eyebrow}>{eyebrow}</Text><Text style={styles.h2}>{title}</Text></View>
          <Pressable style={styles.btn} onPress={onClose}><Text style={styles.btnT}>Close</Text></Pressable>
        </View>
        <ScrollView contentContainerStyle={{ padding: 18, gap: 10 }}>{children}</ScrollView>
      </View>
    </Modal>
  );
}

// ---------------- the 3D tracking scene and Field Guide, from the web game ----------------
function GameWeb({ web, save, area, onMessage, onClose, insets }) {
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  let uri = WEB_BASE + "?embed=" + web.mode;
  if (web.mode === "encounter") {
    const sp = BY[web.spawn.sp];
    const habs = habsAt(area, web.spawn);
    const hab = sp.hab.find(x => habs.includes(x)) || habs[0] || "park";
    uri += `&sp=${sp.id}&hab=${hab}`;
  }
  const injected = `try{localStorage.setItem("wildside.v1",${JSON.stringify(JSON.stringify(save))});localStorage.setItem("wildside.intro","1");localStorage.setItem("wildside.view","3d");}catch(e){}true;`;
  return (
    <Modal animationType="fade" visible onRequestClose={onClose}>
      <View style={[styles.fill, { backgroundColor: C.bg }]}>
        <WebView
          source={{ uri }}
          style={styles.fill}
          originWhitelist={["*"]}
          injectedJavaScriptBeforeContentLoaded={injected}
          onMessage={onMessage}
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          onLoadEnd={() => setLoading(false)}
          onError={() => { setFailed(true); setLoading(false); }}
          onHttpError={() => { setFailed(true); setLoading(false); }}
        />
        {loading && <View style={[StyleSheet.absoluteFill, styles.center, { backgroundColor: C.bg }]}><ActivityIndicator color={C.accent} /><Text style={[styles.small, { marginTop: 8 }]}>{web.mode === "guide" ? "Opening the Field Guide…" : "Creeping closer…"}</Text></View>}
        {failed && (
          <View style={[StyleSheet.absoluteFill, styles.center, { backgroundColor: C.bg, padding: 28 }]}>
            <Text style={[styles.p, { textAlign: "center" }]}>Couldn't load the tracking scene. Check your connection, and that the web side is published at {WEB_BASE}</Text>
          </View>
        )}
        <Pressable style={[styles.webClose, { top: insets.top + 8 }]} onPress={onClose} accessibilityLabel="Close"><Text style={styles.btnT}>✕</Text></Pressable>
      </View>
    </Modal>
  );
}

const shadow = Platform.select({ ios: { shadowColor: "#14201A", shadowOpacity: 0.18, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } }, default: { elevation: 4 } });
const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { alignItems: "center", justifyContent: "center" },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  top: { position: "absolute", left: 0, right: 0, top: 0, flexDirection: "row", gap: 10, paddingHorizontal: 14 },
  card: { backgroundColor: C.surface, borderRadius: 12, borderWidth: 1, borderColor: C.line, paddingHorizontal: 12, paddingVertical: 9, ...shadow },
  wordmark: { fontSize: 22, fontWeight: "800", letterSpacing: 2, color: C.ink },
  clock: { fontSize: 20, fontWeight: "700", color: C.ink, fontVariant: ["tabular-nums"] },
  small: { fontSize: 12, color: C.muted, lineHeight: 16 },
  tiny: { fontSize: 11, color: C.muted, marginTop: 2 },
  p: { fontSize: 15, color: C.ink, lineHeight: 21 },
  label: { fontSize: 12, fontWeight: "700", letterSpacing: 1.5, color: C.muted },
  xpbar: { height: 5, borderRadius: 3, backgroundColor: C.line, overflow: "hidden", marginTop: 5 },
  xpfill: { height: "100%", backgroundColor: C.accent },
  mapctl: { position: "absolute", right: 14 },
  bottom: { position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: 14, gap: 8 },
  btnRow: { flexDirection: "row", gap: 8, justifyContent: "flex-end", alignItems: "center" },
  iconBtn: { width: 46, height: 46, borderRadius: 12, backgroundColor: C.surface, borderWidth: 1, borderColor: C.line, alignItems: "center", justifyContent: "center", ...shadow },
  iconT: { fontSize: 20, color: C.ink },
  badge: { position: "absolute", top: -6, right: -6, minWidth: 18, height: 18, borderRadius: 9, backgroundColor: C.ink, alignItems: "center", justifyContent: "center", paddingHorizontal: 4 },
  badgeT: { color: C.surface, fontSize: 10, fontWeight: "700" },
  btnPrimary: { backgroundColor: C.accent, borderRadius: 12, paddingHorizontal: 16, height: 46, alignItems: "center", justifyContent: "center", ...shadow },
  btnPrimaryT: { color: "#fff", fontWeight: "700", fontSize: 15 },
  btn: { backgroundColor: C.surface, borderRadius: 10, borderWidth: 1, borderColor: C.line, paddingHorizontal: 12, paddingVertical: 8 },
  btnT: { color: C.ink, fontWeight: "700", fontSize: 14 },
  chip: { width: 52, alignItems: "center", gap: 3 },
  chipIc: { width: 44, height: 44, borderRadius: 22, backgroundColor: C.plate, borderWidth: 2, borderColor: C.line, alignItems: "center", justifyContent: "center" },
  inRange: { shadowColor: C.blue, shadowOpacity: 0.9, shadowRadius: 5, shadowOffset: { width: 0, height: 0 } },
  chipD: { fontSize: 10, color: C.muted, fontVariant: ["tabular-nums"] },
  newTag: { position: "absolute", top: -5, right: -8, backgroundColor: C.accent, color: "#fff", fontSize: 9, fontWeight: "800", paddingHorizontal: 4, borderRadius: 6, overflow: "hidden" },
  lureChip: { backgroundColor: "#F5E3A6", color: "#5A4300", fontSize: 11, paddingHorizontal: 8, paddingVertical: 1, borderRadius: 10, overflow: "hidden" },
  pin: { width: 40, height: 40, borderRadius: 20, backgroundColor: "#fff", alignItems: "center", justifyContent: "center", ...shadow },
  denPin: { width: 38, height: 38, borderRadius: 10, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: "#fff", ...shadow },
  denPost: { width: 4, height: 10, borderRadius: 2, marginTop: -1 },
  beam: { position: "absolute", width: 54, height: 54, alignItems: "center" },
  beamTip: { width: 0, height: 0, borderLeftWidth: 8, borderRightWidth: 8, borderBottomWidth: 14, borderLeftColor: "transparent", borderRightColor: "transparent", borderBottomColor: "rgba(26,115,232,0.85)" },
  toast: { position: "absolute", alignSelf: "center", backgroundColor: C.ink, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, maxWidth: "90%" },
  toastT: { color: C.surface, fontWeight: "700", fontSize: 13, textAlign: "center" },
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(10,16,13,0.45)" },
  sheet: { position: "absolute", left: 0, right: 0, bottom: 0, maxHeight: "86%", backgroundColor: C.surface, borderTopLeftRadius: 18, borderTopRightRadius: 18 },
  sheetHead: { flexDirection: "row", alignItems: "flex-start", gap: 10, padding: 18, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: C.line },
  eyebrow: { fontSize: 12, fontWeight: "700", letterSpacing: 1.6, color: C.muted, marginBottom: 2 },
  h2: { fontSize: 26, fontWeight: "800", color: C.ink },
  disc: { width: 230, height: 230, borderRadius: 115, borderWidth: 8, overflow: "hidden", backgroundColor: "#EFEADA", ...shadow },
  denState: { textAlign: "center", fontWeight: "700", fontSize: 15 },
  lootGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  lootItem: { flexDirection: "row", alignItems: "center", gap: 8, borderWidth: 1, borderColor: C.line, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, backgroundColor: C.bg },
  lootT: { fontWeight: "700", color: C.ink },
  bagRow: { flexDirection: "row", gap: 10, alignItems: "center", borderWidth: 1, borderColor: C.line, borderRadius: 10, padding: 10, backgroundColor: C.bg },
  bagName: { fontSize: 15, fontWeight: "700", color: C.ink, marginBottom: 2 },
  bagCt: { fontSize: 22, fontWeight: "800", color: C.ink, minWidth: 30, textAlign: "right" },
  setRow: { flexDirection: "row", gap: 12, alignItems: "center", borderBottomWidth: 1, borderBottomColor: C.line, paddingVertical: 10 },
  webClose: { position: "absolute", right: 14, width: 40, height: 40, borderRadius: 20, backgroundColor: C.surface, borderWidth: 1, borderColor: C.line, alignItems: "center", justifyContent: "center" },
});
