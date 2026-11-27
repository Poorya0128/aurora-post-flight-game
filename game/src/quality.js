// quality.js — visual quality toggle (LOW / HIGH) for the visual upgrade.
// Display-only: nothing in flight/mission logic reads this. Modules that
// spend GPU budget (post bloom, grass density, shadow resolution) read
// getQuality() at build time; setQuality() flips the level for the next
// build and is also exposed on window for manual tuning in devtools.
// Default HIGH; ?quality=low in the URL forces LOW (headless captures).

let level = 'high';
try {
  const param = new URLSearchParams(window.location.search).get('quality');
  if (param === 'low' || param === 'high') level = param;
} catch (error) { /* non-browser context — stay HIGH */ }

export function getQuality() { return level; }
export function isLow() { return level === 'low'; }
export function setQuality(next) {
  if (next === 'low' || next === 'high') level = next;
  return level;
}

try { window.__auroraQuality = { getQuality, setQuality, isLow }; } catch (error) { /* ignore */ }
