# 🎯 DustIII

<div align="center">

**Dust II Defusal — 5v5 Bomb Defusal In Your Browser**  
*A faithful CS2-style ruleset built with Three.js: real economy, buy menu, spray patterns, wallbangs, utility, bomb sites, and four tiers of bot opponents — served as a static site with zero backend.*

[![Platform: Browser](https://img.shields.io/badge/Platform-WebGL%202%20%2F%20ES%20Modules-blue.svg?style=flat-square&logo=googlechrome)](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API)
[![Engine: Three.js](https://img.shields.io/badge/Engine-Three.js%200.170-black.svg?style=flat-square)](https://threejs.org)
[![Rules: CS2 Competitive](https://img.shields.io/badge/Rules-CS2%20Competitive-orange.svg?style=flat-square)](#-competitive-rules-and-economy)
[![Status: Playable](https://img.shields.io/badge/Status-Playable-success.svg?style=flat-square)](#-overview-and-core-value)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](license)
[![Pricing: Free & Open-Source](https://img.shields.io/badge/Pricing-100%25%20Free%20%26%20Open%20Source-success.svg?style=flat-square)](#-overview-and-core-value)
[![Privacy: Zero Telemetry](https://img.shields.io/badge/Privacy-Zero%20Telemetry%20%2F%20100%25%20Local-purple.svg?style=flat-square)](#-privacy-and-security-first)

</div>

---

## 🧭 Table Of Contents

- [Overview And Core Value](#-overview-and-core-value)
- [Key Features](#-key-features)
- [Controls](#-controls)
- [Getting Started](#-getting-started)
- [Architecture And Design](#-architecture-and-design)
- [Diagnostics And Verification](#-diagnostics-and-verification)
- [Privacy And Security First](#-privacy-and-security-first)
- [Educational And Fair-Play Disclaimer](#-educational-and-fair-play-disclaimer)
- [License And Terms](#-license-and-terms)

---

## ⚡ Overview And Core Value

DustIII is a browser-native recreation of the classic 5v5 bomb-defusal loop on de_dust2. You hold a rifle, four bot teammates hold angles with you, and five enemy bots buy, rotate, execute, and retake like a coordinated team. Every round is simulated locally in a single page — there is no account, no matchmaking service, no download, and no telemetry.

The project targets desktop Chrome, Firefox, and Safari with WebGL 2. A cold load streams the static map and art bundle from the same origin, then runs the entire match at 60+ FPS on a modern GPU.

---

## 🎮 Key Features

### Competitive Rules And Economy

- **MR12 Match Flow**: First to 13 rounds wins, sides swap after round 12, and the match ends at 24 rounds.
- **Authentic Economy**: $800 starting cash, $16,000 cap, a $1,400 to $3,400 loss-bonus ladder, kill awards, and plant or defuse bonuses.
- **Freeze And Buy Windows**: A 15-second freeze time and a 20-second buy window gate every round.
- **Full Bomb Loop**: 3.2-second plant, 40-second C4 countdown, 10-second defuse, and 5-second defuse with a kit.

### Weapon Sandbox

- **34 Firearms**: Pistols, SMGs, shotguns, rifles, and machine guns, plus the knife, Zeus x27, C4, and six grenades.
- **Ballistics Model**: Per-weapon spread, recoil recovery, armor penetration, hitgroup multipliers, distance falloff, and wall penetration.
- **Spray Patterns**: Hand-tuned AK-47 and M4A4 patterns with deterministic procedural patterns for the rest of the arsenal.
- **Scopes, Silencers, And Burst Mode**: AWP and SSG 08 optics, M4A1-S and USP-S suppression, and Glock-18 or FAMAS burst fire.

### Utility And Bomb Play

- **Throwables**: HE grenade, flashbang, smoke, Molotov, incendiary, and decoy, each with team-specific availability.
- **Kevlar And Defuse Kits**: Armor absorbs damage by hitgroup, and CT defuse kits halve the defuse duration.
- **Dropped Weapons**: Dead players drop their primary and secondary weapons for pickup.

### Tactical Bot Director AI

- **Four Difficulty Tiers**: Easy, normal, hard, and expert tune reaction time, turn speed, aim error, spray control, field of view, and hearing.
- **Team Directors**: Each side runs an execute director that assigns roles, calls rotations, and coordinates post-plant holds and retakes.
- **Perception Model**: Line-of-sight checks, sound propagation, flash reaction, and target memory that decays over time.
- **38 Named Bots**: A stable roster of personality names keeps scoreboards readable across matches.

### Dust II World

- **Complete Callout Set**: T Spawn, Outside Long, Long Doors, Pit, A Site, CT Spawn, Catwalk, Mid, Xbox, B Tunnels, B Site, and the rest of the map.
- **Baked Map Data**: Pre-baked geometry, props, ramps, and navigation data ship as compact static artifacts.
- **BVH-Accelerated Raycasts**: Bullets, grenades, line-of-sight, and movement all query an accelerated bounding-volume hierarchy.
- **Clip Ramps**: Invisible movement-only ramps make staircases smooth without blocking bullets or grenade traces.

### HUD And Presentation

- **CS2-Style HUD**: Rotating radar, buy menu, scoreboard, kill feed, round timer, money, armor, and ammo.
- **Procedural Models**: Weapons and characters are assembled from primitives at load time, so no external model files are required.
- **First-Person Viewmodel**: Draw, idle, inspect, reload, and fire animations driven by weapon state.
- **Synthesized Audio**: Positional gunfire, footsteps, reloads, radio lines, and bomb beeps.
- **Bilingual Interface**: English and Simplified Chinese labels on the loading screen, buy menu, and prompts.

---

## 🕹️ Controls

| Action | Binding |
| :--- | :--- |
| Move | `W` `A` `S` `D` |
| Look | Mouse |
| Jump | `Space` |
| Crouch | `Ctrl` |
| Walk | `Shift` |
| Fire | Left mouse button |
| Aim Down Sights | Right mouse button |
| Buy Menu | `B` |
| Pick Up Or Defuse | `E` |
| Reload | `R` |
| Inspect Weapon | `F` |
| Drop Weapon | `G` |
| Last Weapon | `Q` |
| Primary / Secondary / Knife / Grenade / C4 | `1` `2` `3` `4` `5` |
| Scoreboard | `Tab` |
| Radio Commands | `Z` `X` `C` |
| Pause | `Esc` |

---

## 🚀 Getting Started

### Requirements

- A modern desktop browser with WebGL 2 and ES module support.
- A local static file server. Opening `index.html` directly from disk will not work because the game uses ES modules and an import map.
- Network access to the pinned jsDelivr CDN modules on first load.

### Serve The Game Locally

```bash
git clone https://github.com/AMFI-Disable/DustIII.git
cd DustIII
python3 -m http.server 8000
```

Open `http://localhost:8000` in your browser and click the canvas to capture the mouse.

### Static Hosting

Because the build is a plain static bundle, any static host works: GitHub Pages, Cloudflare Pages, Netlify, or `nginx`. Point the host at the repository root and serve `index.html` as the entry document.

> [!NOTE]
> The runtime imports `three`, `three/addons/`, and `three-mesh-bvh` from jsDelivr through the import map in `index.html`. For a fully offline deployment, vendor those three packages under `js/vendor/` and rewrite the import map entries.

---

## 🧱 Architecture And Design

The game is a flat ES module application with no build step. `index.html` owns the DOM shell, HUD styles, and the import map; `js/` owns simulation and presentation.

```text
DustIII/
├── index.html                  # Shell, HUD styles, loading screen, import map
├── js/
│   ├── main.js                 # Boot, input, camera, render loop, spectating
│   ├── game.js                 # Rounds, economy, buying, shooting, damage, bomb
│   ├── player.js               # Player movement, collision, stance, stamina
│   ├── bots.js                 # Bot brains and team directors
│   ├── weapon_data.js          # Weapon stats, slots, rules, hitgroups
│   ├── weapon_models.js        # Procedural weapon meshes and animation rigs
│   ├── characters.js           # Procedural character meshes and skins
│   ├── viewmodel.js            # First-person weapon animation state
│   ├── hud.js                  # Radar, buy menu, scoreboard, kill feed
│   ├── audio.js                # Positional and synthesized audio engine
│   ├── world.js                # Map assembly, materials, BVH, lighting
│   ├── world_data.js           # Callouts, spawns, sites, nav anchors
│   ├── world_nav.js            # Navigation grid and pathfinding
│   ├── world_props.js          # Prop placement and dressing
│   ├── world_materials.js      # PBR surface blending
│   └── fx*.js                  # Particles, smoke, fire, decals, post effects
└── assets/
    ├── chars/                  # Character textures
    ├── fx/                     # Sprites, decals, muzzle flashes, smoke sheets
    ├── tex/                    # PBR albedo, normal, and ORM texture sets
    ├── weapons/                # Weapon art references
    ├── world/                  # Baked map, props, ramps, navigation data
    └── ui/                     # Fonts, icons, radar image, UI manifest
```

### Design Notes

- **Data-Driven World**: Static map payloads live in `assets/world/` and are fetched once at load, keeping the simulation code free of hard-coded geometry.
- **Single Source Of Rules**: `RULES` in `js/weapon_data.js` is the only authority for round timing, economy, and match length.
- **Procedural Art**: Weapons and characters are generated from code, which keeps the repository free of large binary model files.
- **Client-Only Authority**: Bots, damage, and economy are deterministic local simulations. There is no server to trust and no network synchronization.

---

## 🧪 Diagnostics And Verification

- **Headless Render Skip**: Append `?norender` to the URL to skip the expensive render loop while keeping the simulation alive. This is useful for automated smoke loads and profiling.
- **Browser Console**: All systems log through the console. Load failures name the missing asset or module.
- **Manual Smoke Test**: Load the page, confirm the loading bar reaches 100 percent, click to lock the pointer, buy a pistol, and complete one round.
- **Asset Integrity**: Every texture, icon, font, and baked payload referenced by `js/` ships in `assets/`; the loader reports any missing path immediately.

There is no automated unit test suite in this repository. Contributions that add headless engine probes are welcome.

---

## 🔒 Privacy And Security First

- **Zero Telemetry**: No analytics, no tracking pixels, no crash reporting, and no identifiers.
- **Zero Backend**: The game is fully static. No account, matchmaking, or database service exists.
- **Local-Only State**: Settings, match state, and preferences stay in the browser tab or local storage.
- **Auditable Dependencies**: The only runtime dependencies are pinned jsDelivr packages declared in the `index.html` import map. Review or vendor them before deploying in a sensitive environment.
- **No Binary Downloads**: Distribution happens through source checkouts and static hosting. No installers or executables are published from this repository.

---

## ⚖️ Educational And Fair-Play Disclaimer

> [!CAUTION]
> **IMPORTANT NOTICE & DISCLAIMER**:
> This project is an unofficial, fan-made educational recreation built to study real-time 3D rendering, game-state simulation, and bot decision-making in the browser.
> It is not affiliated with, endorsed by, or sponsored by Valve Corporation. Counter-Strike, Dust II, and related marks are the property of their respective owners.
> All geometry, models, textures, audio, and code in this repository are original or procedurally generated. If you believe a piece of art infringes your rights, open a private security report so it can be reviewed and replaced.

---

## 📄 License And Terms

Licensed under the [MIT License](license). Copyright (c) 2026 AMFI-Disable.
