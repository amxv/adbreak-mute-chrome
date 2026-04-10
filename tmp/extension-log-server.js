const fs = require("fs");
const http = require("http");
const path = require("path");

const port = 38241;
const logDir = path.join(process.cwd(), "tmp");
const logFile = path.join(logDir, "extension-debug.log");

fs.mkdirSync(logDir, { recursive: true });

function appendLine(line) {
  fs.appendFileSync(logFile, `${line}\n`, "utf8");
}

appendLine(`\n=== log server started ${new Date().toISOString()} ===`);

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/log") {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
    });

    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        appendLine(payload.line || "[missing line]");
        res.writeHead(204);
        res.end();
      } catch (error) {
        appendLine(`parse-error ${error.message}`);
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("bad json");
      }
    });

    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(port, "127.0.0.1", () => {
  appendLine(`listening on http://127.0.0.1:${port}`);
});
