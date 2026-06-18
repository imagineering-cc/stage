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
//
// VOICE (see PERSONA.md): the joke is ALWAYS on Dreamfinder's own blindness, never
// the builder. Warm, self-deprecating, a wink — not analysis. Each lands on a
// universal coding truth (the recognition laugh) and ends in a gentle nudge toward
// open source ("open it and I'll bring proof"). His register: the Victorian familiar
// who reads the grimoire of your code and collects its sparks.
const NO_REPO_QUIPS = [
  "Alas, {name} keeps their workshop locked, so I'm dreaming blind — but my instincts say there's a `// TODO` in there, older than it admits, quietly holding the roof up. Open the doors sometime and I'll bring proof instead of poetry.",
  "{name}'s repo stays sealed to me, so this is a horoscope, not a reading: I foresee a config nobody fully understands, and a test marked skip 'just for now' — a now that was months ago. Unlock the grimoire and I'll trade omens for facts.",
  "The source is shut to me, so I'm running on pure vibes, and the vibes are clear: it works, and {name} is not entirely sure why. Show me the code and I'll turn that mystery into a question worth asking.",
  "I can't see a single line of {name}'s, so I'm dreaming blind — but a familiar learns one thing early: the bug always hides in the part you're proudest of. Am I right? Neither of us can tell. That is the tragedy of a locked door.",
  "No visibility into {name}'s work, which has never once stopped me from having opinions. Open it up and I'll upgrade the opinion to an insight — I do my best work with the lights on.",
  "Blind as I am to {name}'s repo, I'll still wager there's one function in there doing the work of six, with a name that admits to none of it. Prove me wrong — truly, I would love to be proven wrong.",
  "Every locked repo is a spark I can see glowing but can't quite catch, and {name}'s is glowing rather brightly. A pity. Crack it open sometime and it goes in the jar with the rest.",
];

// Pick one quip and interpolate the presenter's display name. Pure aside from the
// random pick (intentional — see the pool comment).
function pickNoRepoQuip(name) {
  const line = NO_REPO_QUIPS[Math.floor(Math.random() * NO_REPO_QUIPS.length)];
  return line.replace(/\{name\}/g, name || 'this builder');
}

module.exports = { generateName, colorForName, NO_REPO_QUIPS, pickNoRepoQuip };
