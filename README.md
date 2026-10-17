# Wildside (iPhone app)

A Pokémon Go–style game for UK urban wildlife. Walk around for real, find animals that spawn where the real species lives, track them in a 3D scene, and spin Dens at real landmarks for kit.

- `App.js`, `src/` – the Expo (React Native) app: GPS, Apple Maps, spawning, Dens, Bag, settings.
- `docs/` – the web side, published with GitHub Pages: the 3D tracking scene, Field Guide, 3D models and audio. The app opens it inside the game.

Built for **Expo SDK 54**, the version the App Store's Expo Go app runs.

## One-time setup on your PC (Windows)

1. Install **Node.js LTS** from https://nodejs.org (accept the defaults).
2. Install **Git** from https://git-scm.com/download/win (accept the defaults).
3. On your iPhone, install **Expo Go** from the App Store.

## Run it on your iPhone

Open **PowerShell** and run:

```
git clone https://github.com/YOUR-GITHUB-USERNAME/wildside.git
cd wildside
npm install
npx expo start --tunnel
```

A QR code appears. Open the iPhone **Camera**, point it at the QR code and tap the banner. Wildside opens in Expo Go.

- Allow location when asked.
- No GPS indoors? Open ⚙ Settings → **Test walking**, then tap the map to move.
- After the first time, you only need `cd wildside` and `npx expo start --tunnel`.

`--tunnel` works even when your phone and PC are on different networks. If your phone and PC share the same Wi-Fi you can use `npx expo start` instead, which is quicker.

## Publish the web side (GitHub Pages)

In the repository on github.com: **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main`, folder `/docs` → Save.** After a minute it is live at `https://YOUR-GITHUB-USERNAME.github.io/wildside/`. `src/config.js` must point at that address.

## Credits

3D models, music and sounds are credited in the in-game Field Guide (Credits section). Map data © OpenStreetMap contributors, via the Overpass API.
