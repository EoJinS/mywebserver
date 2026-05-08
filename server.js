const http = require('http');
function buildWeekSummary(weekId, entries) {
  const scores = people.map((person) => ({
    id: person.id,
    name: person.name,
    score: getWeeklyScore(entries, person.id, weekId),
  }));
  const maxScore = Math.max(...scores.map((person) => person.score), 0);
  const winners = maxScore > 0 ? scores.filter((person) => person.score === maxScore) : [];
  const days = getWeekDays(weekId);

  return {
    weekId,
    label: `${formatShortDate(days[0])} - ${formatShortDate(days[6])}`,
    archivedAt: new Date().toISOString(),
    scores,
    winners,
    total: scores.reduce((sum, person) => sum + person.score, 0),
  };
}

function defaultStore() {
  return { data: createWeekData(), archive: [] };
}

function readStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath, "utf8"));
    return {
      data: parsed.data?.weekId ? parsed.data : createWeekData(),
      archive: Array.isArray(parsed.archive) ? parsed.archive : [],
    };
  } catch {
    return defaultStore();
  }
}

function writeStore(store) {
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
}

function upsertArchive(store, summary) {
  store.archive = store.archive.filter((week) => week.weekId !== summary.weekId);
  store.archive.unshift(summary);
  store.archive.sort((a, b) => b.weekId.localeCompare(a.weekId));
}

function refreshWeekIfNeeded(store) {
  const currentWeekId = getCurrentWeekId();
  if (store.data.weekId !== currentWeekId) {
    upsertArchive(store, buildWeekSummary(store.data.weekId, store.data.entries ?? {}));
    store.data = createWeekData(currentWeekId);
    writeStore(store);
  }
  return store;
}

function getSharedState() {
  const store = refreshWeekIfNeeded(readStore());
  return {
    archive: store.archive,
    data: store.data,
    todayKey: toKey(getKoreanNow()),
  };
}

function broadcastState() {
  const payload = `event: state\ndata: ${JSON.stringify(getSharedState())}\n\n`;
  clients.forEach((client) => client.write(payload));
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) request.destroy();
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const requestPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = path.normalize(decodeURIComponent(requestPath)).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(root, safePath);

  if (!filePath.startsWith(root)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    const ext = path.extname(filePath);
    const types = {
      ".css": "text/css; charset=utf-8",
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
    };
    response.writeHead(200, {
      "Content-Type": types[ext] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(content);
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === "GET" && url.pathname === "/api/state") {
    sendJson(response, 200, getSharedState());
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/events") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    clients.add(response);
    response.write(`event: state\ndata: ${JSON.stringify(getSharedState())}\n\n`);
    request.on("close", () => clients.delete(response));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/activity") {
    try {
      const body = await readJson(request);
      const store = refreshWeekIfNeeded(readStore());
      const personIds = new Set(people.map((person) => person.id));
      const activityIds = new Set(activities.map((activity) => activity.id));
      const weekKeys = new Set(getWeekDays(store.data.weekId).map(toKey));

      if (
        !personIds.has(body.personId) ||
        !activityIds.has(body.activityId) ||
        !weekKeys.has(body.dateKey)
      ) {
        sendJson(response, 400, { error: "Invalid activity request" });
        return;
      }

      const change = Number(body.change);
      const entry = ensureEntry(store.data, body.personId, body.dateKey);
      entry[body.activityId] = Math.max(0, (entry[body.activityId] ?? 0) + change);
      writeStore(store);
      const state = getSharedState();
      sendJson(response, 200, state);
      broadcastState();
    } catch {
      sendJson(response, 400, { error: "Invalid JSON" });
    }
    return;
  }

  if (request.method === "GET") {
    serveStatic(request, response);
    return;
  }

  response.writeHead(405);
  response.end("Method not allowed");
});

server.listen(port, host, () => {
  console.log(`Shared study tracker running at http://${host}:${port}/`);
});
