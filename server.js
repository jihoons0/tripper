const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

app.use(express.json());
app.use(express.static(__dirname));

function readData() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}
function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

app.get('/api/data', (req, res) => res.json(readData()));

app.put('/api/days', (req, res) => {
  const data = readData();
  data.days = req.body;
  writeData(data);
  res.json({ ok: true });
});

app.put('/api/wishlist', (req, res) => {
  const data = readData();
  data.wishlist = req.body;
  writeData(data);
  res.json({ ok: true });
});

// Expand Google Maps short URLs (maps.app.goo.gl) server-side to get the full URL
app.get('/api/expand-url', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'no url' });
  try {
    const r = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
    });
    res.json({ url: r.url });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`http://localhost:${PORT}`));
