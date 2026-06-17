// --- name generator (Dreamfinder handles) ---
// Two pure functions, no shared state. Only built-in dependency is crypto
// (kept here so the module stands alone without reaching into server.js).
const crypto = require('crypto');

const ADJECTIVES = ['Indigo','Velvet','Crimson','Silver','Golden','Cobalt','Amber','Jade','Coral','Ivory','Onyx','Ruby','Saffron','Azure','Verdant','Lilac','Russet','Ochre','Pearl','Obsidian'];
const ANIMALS   = ['Heron','Fox','Otter','Lynx','Owl','Stag','Hare','Falcon','Wolf','Mantis','Wren','Lark','Magpie','Raven','Badger','Marten','Swift','Kestrel','Ibis','Crane'];

function generateName() {
  const a = ADJECTIVES[Math.floor(Math.random()*ADJECTIVES.length)];
  const b = ANIMALS[Math.floor(Math.random()*ANIMALS.length)];
  return `${a} ${b}`;
}

function colorForName(name) {
  // Deterministic pleasing hue from the name; saturation/lightness fixed.
  const h = crypto.createHash('md5').update(name).digest();
  const hue = h[0] * 360 / 256;
  return `hsl(${hue.toFixed(0)}, 60%, 55%)`;
}

// --- no-repo facilitation quips (M3) ---
// When an admitted presenter did NOT opt into a readable public repo (no handle,
// no research consent, or the repo yielded no source), Dreamfinder has nothing to
// ground a question in — so he produces a warm, self-deprecating QUIP instead of
// going silent. The joke is ALWAYS on Dreamfinder's own blindness, never the
// presenter (he can't see the code, so any "criticism" is plainly a guess).
//
// This is a CURATED, hand-written pool BY DESIGN. An LLM asked to "be funny about
// closed source" produces wet cardboard; these lines stay funny because a human
// wrote them. `{name}` is interpolated with the presenter's display handle.
// Picked at random at runtime (pickNoRepoQuip) — Math.random is fine here: this is
// product surface (a quip), not a workflow harness where determinism matters.
const NO_REPO_QUIPS = [
  "I can't see {name}'s code, so I'm flying entirely blind here — but in my experience the bug is always hiding in the part you're proudest of. Was I close? I can't tell. That's the whole problem.",
  "No repo to peer into, so I'll dead-reckon it: somewhere in there is a function that does six things and is named handleData. I will not be taking questions, because I have no evidence.",
  "{name}'s repo is private, so this isn't a code review — it's a horoscope. I foresee a config file no one fully understands, and a test marked skip 'just for now', months ago. Push it public and I'll trade the crystal ball for facts.",
  "Working purely from vibes, since the source is sealed to me. Vibes report: the demo works, and you don't entirely know why. Open it up and I'll bring receipts instead of vibes.",
  "I have zero visibility into this codebase, which has never once stopped me from having opinions. My guess: there's a // TODO: fix later from a while back that is now quietly load-bearing.",
];

// Pick one quip and interpolate the presenter's display name. Pure aside from the
// random pick (intentional — see the pool comment).
function pickNoRepoQuip(name) {
  const line = NO_REPO_QUIPS[Math.floor(Math.random() * NO_REPO_QUIPS.length)];
  return line.replace(/\{name\}/g, name || 'this builder');
}

module.exports = { generateName, colorForName, NO_REPO_QUIPS, pickNoRepoQuip };
