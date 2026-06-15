// --- yt-dlp search ---
const { execFile } = require('child_process');

function ytSearch(query) {
  return new Promise((resolve) => {
    execFile('yt-dlp', [
      '--flat-playlist', '--dump-json', '--no-warnings',
      '--default-search', 'ytsearch5',
      `ytsearch5:${query}`
    ], { maxBuffer: 1024*1024*8, timeout: 15000 }, (err, stdout) => {
      if (err) { console.error('yt-dlp search err', err.message); return resolve([]); }
      const lines = stdout.split('\n').filter(l => l.trim());
      const out = [];
      for (const l of lines) {
        try {
          const j = JSON.parse(l);
          out.push({
            videoId: j.id,
            title: j.title,
            thumbnail: j.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${j.id}/mqdefault.jpg`,
            duration: j.duration,
            channel: j.channel || j.uploader,
          });
        } catch(e) {}
      }
      resolve(out);
    });
  });
}

module.exports = { ytSearch };
