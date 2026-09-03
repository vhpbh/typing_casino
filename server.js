/*
 * server.js — a tiny local HTTPS static file server for testing the add-in
 * while sideloaded in Word. Word requires the taskpane to be served over
 * HTTPS even on localhost, so this uses office-addin-dev-certs to get a
 * certificate your machine already trusts (installed once below).
 *
 * Usage:
 *   npx office-addin-dev-certs install
 *   node server.js
 *   -> serves the project root at https://localhost:3000/
 *      (manifest.xml should point at https://localhost:3000/taskpane/taskpane.html
 *       and https://localhost:3000/admin/admin.html while testing locally)
 */
const https = require("https");
const fs = require("fs");
const path = require("path");
const getCerts = require("office-addin-dev-certs");

const ROOT = __dirname;
const PORT = 3000;

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".xml": "application/xml",
  ".png": "image/png",
  ".aff": "text/plain",
  ".dic": "text/plain",
  ".json": "application/json",
};

getCerts.getHttpsServerOptions().then((options) => {
  https
    .createServer(options, (req, res) => {
      let filePath = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
      if (filePath.endsWith("/")) filePath = path.join(filePath, "index.html");

      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end("Not found: " + req.url);
          return;
        }
        const ext = path.extname(filePath);
        res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
        res.end(data);
      });
    })
    .listen(PORT, () => {
      console.log(`Typing Casino dev server running at https://localhost:${PORT}/`);
    });
});
