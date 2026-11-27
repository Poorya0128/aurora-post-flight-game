// AURORA POST — hand-in program for make.fun best-flight-game-20261126-0057.
// Node 22, standard library only. The game itself is the game/ folder beside
// this file: plain static files a desktop browser plays offline. This program
// copies game/ and screenshots/ into the grader's /output (MAKEFUN_OUTPUT_DIR
// stands in for it locally) and writes /output/dossier.json with buildDossier
// from the vendored make.fun library — the summary the judge reads.
// Run locally:  mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-game.ts';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

mkdirSync(outputDir, { recursive: true });
cpSync(join(repoRoot, 'game'), join(outputDir, 'game'), { recursive: true });
mkdirSync(join(outputDir, 'screenshots'), { recursive: true });
if (existsSync(join(repoRoot, 'screenshots'))) {
  cpSync(join(repoRoot, 'screenshots'), join(outputDir, 'screenshots'), { recursive: true });
}

// The scorer's caps, mirrored so the dossier this writes is the one it expects:
// at most 4 screenshots of 256 KiB, at most 993 entries / 48 MiB under game/,
// paths under game/ at most 1000 bytes, dossier text capped at 160 KiB.
writeFileSync(
  join(outputDir, 'dossier.json'),
  buildDossier(outputDir, {
    text_max_bytes: 163840,
    screenshots: { max: 4, max_bytes: 262144 },
    game_max_files: 993,
    game_max_bytes: 50331648,
    game_path_max_bytes: 1000,
  }),
);
