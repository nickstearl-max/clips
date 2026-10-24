// Renders icon.html to build/icon.png (run: npx electron build/icon-src/render.js)
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 512, height: 512, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  await w.loadFile(path.join(__dirname, 'icon.html'));
  await new Promise((r) => setTimeout(r, 500));
  const img = await w.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  fs.writeFileSync(path.join(__dirname, '..', 'icon.png'), img.resize({ width: 512, height: 512 }).toPNG());
  app.quit();
});
