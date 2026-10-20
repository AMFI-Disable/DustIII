# Changelog

All notable changes, gameplay systems, and architectural capabilities of DustIII are documented in this file.

The format follows Keep a Changelog, and this project uses Semantic Versioning.

---

## [Unreleased]

### Added

- Standardized repository scaffolding: `readme.md`, `changelog.md`, `license`, `security.md`, and GitHub issue and pull request templates.
- Browser-game README covering controls, local serving, architecture, diagnostics, privacy, and licensing.

### Changed

- Lowercased marker texture assets to `mark_a.png` and `mark_b.png`, and updated the `js/world.js` references.

---

## [1.0.0] - 2026-10-20

Inaugural import of the Dust II Defusal browser game.

### Added

- **Competitive Ruleset**: MR12 match flow, halftime side swap, freeze time, buy window, and the full C4 plant and defuse loop.
- **Economy Model**: Starting money, round cap, loss-bonus ladder, kill awards, and plant or defuse bonuses.
- **Weapon Sandbox**: 34 firearms across pistols, SMGs, shotguns, rifles, and machine guns, plus knives, the Zeus x27, C4, and six grenades.
- **Ballistics**: Per-weapon spray patterns, recoil recovery, armor penetration, hitgroup multipliers, distance falloff, and wall penetration.
- **Bot Director AI**: Four difficulty tiers, team-level execute directors, vision and hearing perception, flash reaction, and post-plant behavior.
- **Dust II World**: Full callout coverage, baked map and navigation data, BVH-accelerated raycasts, and movement-only clip ramps.
- **HUD And Presentation**: Radar, buy menu, scoreboard, kill feed, procedural weapon and character models, first-person viewmodel, and postprocessing.
- **Synthesized Audio**: Positional gunfire, footsteps, reloads, radio lines, and bomb cues.
- **Static Delivery**: Zero-backend ES module application with a pinned import map.

### Security

- Fully client-side simulation with zero telemetry, zero analytics, and zero backend services.
