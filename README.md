# Wildside Go (iPhone app)

A Pokémon Go–style game for UK urban wildlife. Walk around for real, find animals that spawn where the real species lives, track them in a 3D scene, and spin Dens at real landmarks for kit.

- `App.js`, `src/` – the Expo (React Native) app: GPS, Google Maps tiles, spawning, Dens, Bag, settings.
- `docs/` – the web side, published with GitHub Pages: the 3D tracking scene, Field Guide, 3D models and audio. The app opens it inside the game.

Built for **Expo SDK 57**.

## One-time setup on your PC (Windows)

1. Install **Node.js LTS** from https://nodejs.org (accept the defaults).
2. Install **Git** from https://git-scm.com/download/win (accept the defaults).
3. On your iPhone, install **Expo Go** from the App Store.

## Run it on your iPhone

Open **PowerShell** and run:

```
git clone https://github.com/YOUR-GITHUB-USERNAME/wildside-go.git
cd wildside-go
npm install
npx expo start --tunnel
```

A QR code appears. Open the iPhone **Camera**, point it at the QR code and tap the banner. Wildside Go opens in Expo Go.

- Allow location when asked.
- No GPS indoors? Open ⚙ Settings → **Test walking**, then tap the map to move.
- After the first time, you only need `cd wildside-go` and `npx expo start --tunnel`.

`--tunnel` works even when your phone and PC are on different networks. If your phone and PC share the same Wi-Fi you can use `npx expo start` instead, which is quicker.

## Google Maps and standalone builds

This app uses Google Maps tiles on the device. In Expo Go that works without an API key because Expo Go ships the Google Maps SDK.

For a standalone iOS or Android build (an app you install directly, not via Expo Go), you need a Google Cloud API key for the Google Maps SDK and an EAS build. That is the step that is not covered by this README; see Expo’s `react-native-maps` docs for the iOS and Android API key setup.

## Publish the web side (GitHub Pages)

In the repository on github.com: **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main`, folder `/docs` → Save.** After a minute it is live at `https://YOUR-GITHUB-USERNAME.github.io/wildside-go/` . `src/config.js` must point at that address.

## Credits

3D models, music and sounds are credited in the in-game Field Guide (Credits section). Map tiles © Google. Habitat and Den data comes from OpenStreetMap, via the Overpass API.
