# AURORA POST

[![make.fun · best-flight-game-20261126-0057](https://make.fun/badge/best-flight-game-20261126-0057.svg)](https://make.fun/bounty/best-flight-game-20261126-0057?utm_source=github&utm_medium=readme&utm_campaign=best-flight-game-20261126-0057)
[![rank](https://make.fun/badge/best-flight-game-20261126-0057/Poorya0128/aurora-post-flight-game/rank.svg)](https://make.fun/bounty/best-flight-game-20261126-0057/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=best-flight-game-20261126-0057)
[![reward](https://make.fun/badge/best-flight-game-20261126-0057/Poorya0128/aurora-post-flight-game/reward.svg)](https://make.fun/bounty/best-flight-game-20261126-0057?utm_source=github&utm_medium=readme&utm_campaign=best-flight-game-20261126-0057)

Entered in the make.fun bounty **Make the best flight game**:
https://make.fun/bounty/best-flight-game-20261126-0057

Dawn mail runs over a small island archipelago in a single-engine bush
plane. You fly the morning round from Aurora Field: thread glowing rings
in order, drop parcels onto marked beaches, land on other islands to
unload the mail and come home, and grease the touchdown on the
centreline — while fuel burns with the throttle and every hard arrival
bends the aeroplane. Twelve sorties of rising difficulty (calm dawn,
fresh breeze, squall line), medals, a debrief after every flight, and
free flight whenever you just want to watch the sun come up. Original
name, art and sounds; no real aircraft, airline or place names.

## Play

Open `game/index.html` in a desktop browser — or serve the folder:

```sh
node serve.ts          # then open http://127.0.0.1:8080
```

The game is plain static files and plays fully offline: no network
request, no build step.

## How to fly

Throttle is up/down; stick back is nose up (and slower). Keep speed
above 20 m/s, approach at 24–27, touch down at 22–26, slow, flat and on
the centreline. First flight: full throttle → release the brake → pull
gently at 22 m/s → climb to 200 m → turn with bank → throttle back →
descend → flare → brakes.

| Keys | Action |
|---|---|
| ArrowDown / S · ArrowUp / W | Pull stick (nose up) · push stick (nose down) |
| ArrowLeft / ArrowRight | Bank left / right (turn) |
| A / D (Q = left too) | Rudder left / right, ground steering |
| Shift / Ctrl (hold), + / −, PageUp / PageDown | Throttle up / down |
| 0 / 9 or Home / End (1–8 = 10–80%) | Throttle idle / full |
| Space (hold) · V | Brakes · parking brake |
| F | Flaps: up → approach → full |
| B | Release parcel (cargo sorties) |
| E | Engine start / stop |
| C | Camera: chase → cockpit → tower |
| P / Esc · R · M · H | Pause · restart sortie · mute · help |
| Mouse drag / wheel / right-mouse hold | Look around / chase distance / mouse-as-stick |

## Missions — "The Morning Round"

Four sortie types across three weather tiers, twelve sorties in all,
plus free flight:

- **Ring Course** — thread 8–12 glowing rings in order against par;
  centred crossings score more.
- **Cargo Drop** — release parcels over marked drop zones; altitude,
  speed and wind drift decide where they land.
- **Island Delivery** — land at another island's strip, stop in the
  parking box to unload, then fly home. The fuel-economy sortie.
- **Precision Landing** — one graded touchdown: sink rate, centreline
  and speed. Go-arounds allowed (small penalty); a bent plane is not.

Fuel burns faster the harder you push the throttle, and damage from
hard landings, terrain strikes and overspeed degrades power and
controls — land at any strip to refuel and repair. Every sortie ends
at a debrief with a score breakdown, a medal (bronze/silver/gold) and a
plain-words verdict on what happened. Progress is kept in
localStorage.

## Tech notes

- Three.js r170 vendored as `game/vendor/three.module.min.js` (MIT),
  loaded through an import map; everything else is hand-written
  ES modules under `game/src/`, one job per file (flight model, world,
  aircraft/cockpit, renderer/cameras, HUD, missions/scoring, input,
  audio, screenshot scenes).
- Real lift/thrust/drag flight model at a fixed 120 Hz substep:
  stall is a mush with a nose drop, never a spin; control authority is
  floored at 40% so the stick always answers.
- All sound is synthesized with WebAudio (engine, wind, alarms,
  chimes) — no audio files. Terrain, islands, strips, rings, boats
  and landmarks are procedural Three.js primitives with
  canvas-generated textures. No external assets, no `eval`, no
  cookies, no service worker.
- `main.ts` (Node 22, standard library only) is the make.fun hand-in
  program: it copies `game/` and `screenshots/` to the output and
  writes `dossier.json` via `buildDossier` from
  `vendor/makefun-game.ts`.

## Licence

MIT — see [LICENSE](LICENSE). The vendored Three.js build keeps its
own MIT licence notice in `game/vendor/three.module.min.js`.
