# 🎯 DustIII

<div align="center">

**Dust II Defusal — 5v5 Bombenentschärfung Im Browser**  
*Ein CS2-treues Regelset auf Basis von Three.js: echte Wirtschaft, Kaufmenü, Rückstoßmuster, Wanddurchschlag, Utility, Bombenstellen und vier Bot-Stufen — als statische Seite ohne Backend.*

[![Plattform: WebGL 2 / ES-Module](https://img.shields.io/badge/Plattform-WebGL%202%20%2F%20ES-Module-blue.svg?style=flat-square&logo=googlechrome)](https://developer.mozilla.org/de/docs/Web/API/WebGL_API)
[![Engine: Three.js 0.170](https://img.shields.io/badge/Engine-Three.js%200.170-black.svg?style=flat-square)](https://threejs.org)
[![Regeln: CS2 Kompetitiv](https://img.shields.io/badge/Regeln-CS2%20Kompetitiv-orange.svg?style=flat-square)](#rules)
[![Status: Spielbar](https://img.shields.io/badge/Status-Spielbar-success.svg?style=flat-square)](#overview)
[![Spielen: Live-Demo](https://img.shields.io/badge/Spielen-Live--Demo-success.svg?style=flat-square&logo=githubpages)](https://amfi-disable.github.io/DustIII/)
[![Lizenz: MIT](https://img.shields.io/badge/Lizenz-MIT-blue.svg?style=flat-square)](license)
[![Preis: 100% Kostenlos & Open Source](https://img.shields.io/badge/Preis-100%25%20Kostenlos%20%26%20Open%20Source-success.svg?style=flat-square)](#overview)
[![Datenschutz: Keine Telemetrie / 100% Lokal](https://img.shields.io/badge/Datenschutz-Keine%20Telemetrie%20%2F%20100%25%20Lokal-purple.svg?style=flat-square)](#privacy)

</div>

---

## 🌐 Sprache Auswählen / Select Language / 选择语言 / 言語を選択 / Idioma / Langue / Sprache

**[English](readme.md)** •
**[简体中文](readme.zh-cn.md)** •
**[繁體中文](readme.zh-tw.md)** •
**[日本語](readme.ja.md)** •
**[Español](readme.es.md)** •
**[Français](readme.fr.md)** •
**[Deutsch](readme.de.md)**

---

## 🧭 Inhaltsverzeichnis

- [Überblick Und Kernwert](#overview)
- [Hauptfunktionen](#features)
- [Steuerung](#controls)
- [Erste Schritte](#start)
- [Architektur Und Design](#architecture)
- [Diagnose Und Verifikation](#diagnostics)
- [Datenschutz Und Sicherheit](#privacy)
- [Bildungs- Und Fair-Play-Haftungsausschluss](#disclaimer)
- [Lizenz Und Bedingungen](#license)

---

## ⚡ Überblick Und Kernwert <a id="overview"></a>

DustIII ist eine browser-native Nachbildung des klassischen 5v5-Bombenentschärfungszyklus auf de_dust2. Du hältst ein Gewehr, vier Bot-Teamkollegen sichern mit dir Winkel ab, und fünf gegnerische Bots kaufen, rotieren, führen aus und nehmen Positionen zurück wie ein koordiniertes Team. Jede Runde wird lokal in einer einzigen Seite simuliert — kein Konto, kein Matchmaking-Dienst, kein Download und keine Telemetrie.

Das Projekt richtet sich an Desktop-Chrome, Firefox und Safari mit WebGL 2. Ein Kaltstart lädt die statische Karte und das Art-Paket von derselben Origin und führt dann das gesamte Match mit über 60 FPS auf einer modernen GPU aus.

---

## 🎮 Hauptfunktionen <a id="features"></a>

### Wettbewerbsregeln Und Wirtschaft <a id="rules"></a>

- **MR12-Format**: Wer zuerst 13 Runden gewinnt, siegt; nach Runde 12 werden die Seiten getauscht, und das Match endet spätestens in Runde 24.
- **Authentische Wirtschaft**: 800 $ Startgeld, 16.000 $ Obergrenze, eine Niederlagenbonus-Leiter von 1.400 $ bis 3.400 $ sowie Belohnungen für Kills, Pflanzungen und Entschärfungen.
- **Freeze- Und Kaufzeit**: 15 Sekunden Freeze-Time und ein 20-sekündiges Kaufenster pro Runde.
- **Vollständiger Bombenablauf**: 3,2 Sekunden pflanzen, 40 Sekunden C4-Countdown, 10 Sekunden entschärfen und 5 Sekunden mit Defuse-Kit.

### Waffen-Sandbox

- **34 Schusswaffen**: Pistolen, MPs, Schrotflinten, Gewehre und Maschinengewehre, dazu Messer, Zeus x27, C4 und sechs Granaten.
- **Ballistikmodell**: Streuung pro Waffe, Rückstoßerholung, Rüstungsdurchschlag, Trefferzonen-Multiplikatoren, Entfernungsabfall und Wanddurchschlag.
- **Rückstoßmuster**: handabgestimmte Muster für AK-47 und M4A4 sowie deterministische prozedurale Muster für den Rest des Arsenals.
- **Ziele, Schalldämpfer Und Feuerstöße**: AWP- und SSG-08-Optiken, M4A1-S- und USP-S-Dämpfung sowie Feuerstoßmodus für Glock-18 und FAMAS.

### Utility Und Bombenspiel

- **Granaten**: HE, Flashbang, Rauch, Molotow, Brandgranate und Köder, mit teamabhängiger Verfügbarkeit.
- **Rüstung Und Defuse-Kits**: Rüstung absorbiert Schaden je Trefferzone, und CT-Defuse-Kits halbieren die Entschärfungszeit.
- **Fallengelassene Waffen**: Gefallene Spieler lassen Primär- und Sekundärwaffe fallen, die aufgehoben werden können.

### Taktische Bot-Director-KI

- **Vier Schwierigkeitsstufen**: Leicht, Normal, Schwer und Experte justieren Reaktionszeit, Drehgeschwindigkeit, Zielfehler, Rückstoßkontrolle, Sichtfeld und Gehör.
- **Team-Directors**: Jede Seite hat einen Ausführungs-Director, der Rollen zuweist, Rotationen ansagt und Verteidigung sowie Retakes nach der Pflanzung koordiniert.
- **Wahrnehmungsmodell**: Sichtlinienprüfung, Schallausbreitung, Blendreaktion und ein mit der Zeit abklingendes Zielgedächtnis.
- **38 Benannte Bots**: Ein stabiles Roster hält die Scoreboards über Matches hinweg lesbar.

### Dust II Welt

- **Vollständige Callouts**: T Spawn, Outside Long, Long Doors, Pit, A Site, CT Spawn, Catwalk, Mid, Xbox, B Tunnels, B Site und der Rest der Karte.
- **Gebackene Kartendaten**: Geometrie, Props, Rampen und Navigation werden vorab gebacken und als kompakte statische Artefakte ausgeliefert.
- **BVH-beschleunigte Raycasts**: Kugeln, Granaten, Sichtlinien und Bewegung fragen eine beschleunigte Bounding-Volume-Hierarchie ab.
- **Clip-Rampen**: Unsichtbare, nur für Bewegung geltende Rampen glätten Treppen, ohne Kugeln oder Granaten zu blockieren.

### HUD Und Präsentation

- **HUD Im CS2-Stil**: Drehendes Radar, Kaufmenü, Scoreboard, Kill-Feed, Runden-Timer, Geld, Rüstung und Munition.
- **Prozedurale Modelle**: Waffen und Charaktere werden beim Laden aus Primitiven zusammengesetzt, daher sind keine externen Modelldateien nötig.
- **First-Person-ViewModel**: Zieh-, Idle-, Inspektions-, Nachlade- und Schussanimationen, gesteuert durch den Waffenzustand.
- **Synthetisiertes Audio**: Positionale Schüsse, Schritte, Nachladen, Funkstimmen und Bomben-Pieptöne.
- **Zweisprachige Oberfläche**: Englische und vereinfacht-chinesische Beschriftungen auf Ladebildschirm, Kaufmenü und Hinweisen.

---

## 🕹 Steuerung <a id="controls"></a>

| Aktion | Taste |
| :--- | :--- |
| Bewegen | `W` `A` `S` `D` |
| Umsehen | Maus |
| Springen | `Space` |
| Ducken | `Ctrl` |
| Gehen | `Shift` |
| Schießen | Linke Maustaste |
| Zielen | Rechte Maustaste |
| Kaufmenü | `B` |
| Aufheben Oder Entschärfen | `E` |
| Nachladen | `R` |
| Waffe Inspizieren | `F` |
| Waffe Fallen Lassen | `G` |
| Vorherige Waffe | `Q` |
| Primär / Sekundär / Messer / Granate / C4 | `1` `2` `3` `4` `5` |
| Scoreboard | `Tab` |
| Funkbefehle | `Z` `X` `C` |
| Pause | `Esc` |

---

## 🚀 Erste Schritte <a id="start"></a>

### Voraussetzungen

- Ein moderner Desktop-Browser mit WebGL 2 und ES-Modul-Unterstützung.
- Ein lokaler Server für statische Dateien. Das direkte Öffnen von `index.html` von der Festplatte funktioniert nicht, da das Spiel ES-Module und eine Import-Map verwendet.
- Netzwerkzugriff auf die fest versionierten jsDelivr-Module beim ersten Laden.

### Spiel Lokal Starten

```bash
git clone https://github.com/AMFI-Disable/DustIII.git
cd DustIII
python3 -m http.server 8000
```

Öffne `http://localhost:8000` im Browser und klicke auf die Leinwand, um die Maus zu erfassen.

### Statisches Hosting

Da das Paket vollständig statisch ist, funktioniert jedes Static-Hosting: GitHub Pages, Cloudflare Pages, Netlify oder `nginx`. Richte den Host auf das Repository-Stammverzeichnis und liefere `index.html` als Einstiegsdokument.

> [!NOTE]
> Die Laufzeit importiert `three`, `three/addons/` und `three-mesh-bvh` über die Import-Map in `index.html` von jsDelivr. Für einen vollständig offline Betrieb kopiere diese drei Pakete nach `js/vendor/` und schreibe die Import-Map-Einträge um.

---

## 🧱 Architektur Und Design <a id="architecture"></a>

Das Spiel ist eine flache ES-Modul-Anwendung ohne Build-Schritt. `index.html` besitzt die DOM-Hülle, die HUD-Stile und die Import-Map; `js/` besitzt Simulation und Darstellung.

```text
DustIII/
├── index.html                  # Hülle, HUD-Stile, Ladebildschirm, Import-Map
├── js/
│   ├── main.js                 # Start, Eingabe, Kamera, Rendering-Schleife, Zuschauen
│   ├── game.js                 # Runden, Wirtschaft, Kaufen, Schießen, Schaden, Bombe
│   ├── player.js               # Bewegung, Kollision und Haltung des Spielers
│   ├── bots.js                 # Bot-Denken und Team-Directors
│   ├── weapon_data.js          # Waffenwerte, Slots, Regeln, Trefferzonen
│   ├── weapon_models.js        # Prozedurale Waffenmeshes und Animations-Rigs
│   ├── characters.js           # Prozedurale Charakter-Meshes und Skins
│   ├── viewmodel.js            # Animationszustand der Waffe in erster Person
│   ├── hud.js                  # Radar, Kaufmenü, Scoreboard, Kill-Feed
│   ├── audio.js                # Positionales und synthetisiertes Audio-Engine
│   ├── world.js                # Kartenaufbau, Materialien, BVH, Beleuchtung
│   ├── world_data.js           # Callouts, Spawns, Sites, Navigationsanker
│   ├── world_nav.js            # Navigationsgitter und Pfadfindung
│   ├── world_props.js          # Prop-Platzierung und Dekoration
│   ├── world_materials.js      # PBR-Oberflächenmischung
│   └── fx*.js                  # Partikel, Rauch, Feuer, Decals, Postprocessing
└── assets/
    ├── chars/                  # Charakter-Texturen
    ├── fx/                     # Sprites, Decals, Mündungsfeuer, Rauch-Sheets
    ├── tex/                    # PBR-Albedo-, Normal- und ORM-Textursets
    ├── weapons/                # Kunst-Referenzen für Waffen
    ├── world/                  # Gebackene Karte, Props, Rampen, Navigationsdaten
    └── ui/                     # Schriften, Icons, Radar-Bild, UI-Manifest
```

### Designhinweise

- **Datengetriebene Welt**: Die statischen Kartenlasten liegen in `assets/world/` und werden einmal beim Laden abgerufen, sodass der Simulationscode keine hartcodierte Geometrie enthält.
- **Einzige Regelquelle**: `RULES` in `js/weapon_data.js` ist die alleinige Autorität für Rundenzeiten, Wirtschaft und Matchlänge.
- **Prozedurale Kunst**: Waffen und Charaktere werden aus Code erzeugt, wodurch große binäre Modelldateien im Repository entfallen.
- **Client-Autorität**: Bots, Schaden und Wirtschaft sind deterministische lokale Simulationen. Es gibt keinen Server, dem man vertrauen müsste, und keine Netzwerksynchronisation.

---

## 🧪 Diagnose Und Verifikation <a id="diagnostics"></a>

- **Rendering Überspringen**: Hänge `?norender` an die URL, um die teure Rendering-Schleife zu überspringen und die Simulation weiterlaufen zu lassen. Nützlich für automatisierte Smoke-Loads und Profiling.
- **Browser-Konsole**: Alle Systeme protokollieren in die Konsole; Ladefehler benennen die fehlende Ressource oder das fehlende Modul.
- **Manueller Smoke-Test**: Lade die Seite, prüfe, dass die Ladeleiste 100 Prozent erreicht, klicke zum Sperren des Zeigers, kaufe eine Pistole und spiele eine Runde zu Ende.
- **Asset-Integrität**: Jede von `js/` referenzierte Textur, jedes Icon, jede Schrift und jede gebackene Last wird in `assets/` mitgeliefert; der Loader meldet fehlende Pfade sofort.

Dieses Repository enthält keine automatisierte Unit-Test-Suite. Beiträge, die Headless-Engine-Probes ergänzen, sind willkommen.

---

## 🔒 Datenschutz Und Sicherheit <a id="privacy"></a>

- **Keine Telemetrie**: Keine Analytik, keine Tracking-Pixel, keine Absturzberichte und keine Identifikatoren.
- **Kein Backend**: Das Spiel ist vollständig statisch. Es gibt kein Konto, kein Matchmaking und keinen Datenbankdienst.
- **Nur Lokaler Zustand**: Einstellungen, Matchzustand und Präferenzen bleiben im Browser-Tab oder im lokalen Speicher.
- **Prüfbare Abhängigkeiten**: Die einzigen Laufzeitabhängigkeiten sind die fest versionierten jsDelivr-Pakete aus der Import-Map in `index.html`. Prüfe oder vendore sie vor einem Einsatz in sensiblen Umgebungen.
- **Keine Binär-Downloads**: Die Verteilung erfolgt über Quellcode-Checkouts und statisches Hosting. Es werden keine Installer oder ausführbaren Dateien veröffentlicht.

---

## ⚖ Bildungs- Und Fair-Play-Haftungsausschluss <a id="disclaimer"></a>

> [!CAUTION]
> **WICHTIGER HINWEIS UND HAFTUNGSAUSSCHLUSS**:
> Dieses Projekt ist eine inoffizielle, von Fans erstellte Bildungs-Nachbildung, um Echtzeit-3D-Rendering, Spielzustandssimulation und Bot-Entscheidungsfindung im Browser zu untersuchen.
> Es ist nicht mit Valve Corporation verbunden, von ihr unterstützt oder gesponsert. Counter-Strike, Dust II und zugehörige Marken sind Eigentum ihrer jeweiligen Inhaber.
> Sämtliche Geometrie, Modelle, Texturen, Audioinhalte und Code in diesem Repository sind original oder prozedural erzeugt. Wenn du der Ansicht bist, dass ein Kunst-Asset deine Rechte verletzt, eröffne einen vertraulichen Sicherheitsbericht, damit es geprüft und ersetzt werden kann.

---

## 📄 Lizenz Und Bedingungen <a id="license"></a>

Veröffentlicht unter der [MIT-Lizenz](license). Copyright (c) 2026 AMFI-Disable.
