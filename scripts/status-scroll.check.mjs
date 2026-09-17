// node scripts/status-scroll.check.mjs
// TU-09: the Shielded pool status card comes into view once per action. Later progress messages update it in place, an
// error brings it back if the user scrolled away, and nothing scrolls while the card is already on screen.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const src = readFileSync(new URL("../public/shielded.js", import.meta.url), "utf8");
const grab = (name, re) => {
  const m = src.match(re);
  if (!m) throw new Error(`could not find ${name} in public/shielded.js`);
  return m[0];
};

let scrolls = 0;
let onScreen = false; // where the card is relative to the viewport
const part = () => ({ textContent: "" });
const card = { hidden: true, dataset: {}, style: {}, offsetWidth: 0, querySelector: part, getBoundingClientRect: () => (onScreen ? { top: 100, bottom: 200 } : { top: 1500, bottom: 1600 }), scrollIntoView: () => scrolls++ };
const run = new Function(
  "card",
  `const $ = () => card; const tickTime = () => {}; const innerHeight = 900; const matchMedia = () => ({ matches: false });
   let busy = false;
   ${grab("STATE_LABEL", /const STATE_LABEL = .*/)}
   ${grab("started", /let started = .*/)}
   ${grab("inView", /let inView = .*/)}
   ${grab("say", /function say\([\s\S]*?\n\}/)}
   const begin = () => { busy = true; ${grab("act reset", /inView = false;/)} };
   const end = () => { busy = false; };
   return { say, begin, end };`,
)(card);

// an action far below the fold: one scroll for the whole run, however many messages it posts
run.begin();
for (const m of ["Getting ready…", "Proving the transaction in your browser…", "Submitting…"]) run.say(m);
run.say("Done", "done");
run.end();
assert.equal(scrolls, 1, "one scroll per action");

// the user scrolls away during the next action: progress stays put, an error comes back into view
scrolls = 0;
run.begin();
run.say("Getting ready…");
run.say("Proving…");
run.say("The proof did not verify.", "error");
run.end();
assert.equal(scrolls, 2, "the start and the error");

// card already visible: no scroll at all
scrolls = 0;
onScreen = true;
run.begin();
run.say("Getting ready…");
run.say("Proving…");
run.end();
run.say("Unlock first.");
assert.equal(scrolls, 0, "nothing moves when the card is on screen");

// a one-off note outside an action still scrolls to it when it is off screen
onScreen = false;
run.say("Unlock first.");
assert.equal(scrolls, 1);

console.log("status-scroll.check: ok");
