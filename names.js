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

module.exports = { generateName, colorForName };
