const http = require("http");
const fs = require("fs");
const path = require("path");

const port = Number(process.env.PORT || 4174);
const host = process.env.HOST || "127.0.0.1";
const root = __dirname;
const storePath = path.join(root, "tracker-store.json");
const clients = new Set();

const people = [
  { id: "ejin", name: "어진" },
  { id: "minu", name: "민우" },
];

const activities = [
  { id: "focus", label: "1시간 집중", points: 1 },
  { id: "todo", label: "투두리스트 완료", points: 1 },
  { id: "paper", label: "논문 읽기", points: 2 },
  { id: "lab", label: "실험/코드 구현", points: 3 },
  { id: "mini", label: "미니 발표", points: 3 },
];

function getKoreanNow() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
}

function getWeekStart(date) {
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() + diff);
  return start;
}

function toKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function fromKey(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function getCurrentWeekId() {
  return toKey(getWeekStart(getKoreanNow()));
}

function getWeekDays(weekId) {
  const start = fromKey(weekId);
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(start);
    day.setDate(start.getDate() + index);
    return day;
  });
}

function formatShortDate(date) {
  const weekday = new Intl.DateTimeFormat("ko-KR", { weekday: "short" }).format(date);
  return `${date.getMonth() + 1}/${date.getDate()} ${weekday}`;
}

function createWeekData(weekId = getCurrentWeekId()) {
  return { weekId, entries: {} };
}

function createEmptyRecord() {
  return activities.reduce((record, activity) => {
    record[activity.id] = 0;
    return record;
  }, {});
}

function ensureEntry(data, personId, dateKey) {
  data.entries[dateKey] ??= {};
  data.entries[dateKey][personId] ??= createEmptyRecord();
  return data.entries[dateKey][personId];
}

function getRecordScore(entry) {
  return activities.reduce(
    (sum, activity) => sum + (entry[activity.id] ?? 0) * activity.points,
    0,
  );
}

function getDailyScore(entries, personId, dateKey) {
  return getRecordScore(entries[dateKey]?.[personId] ?? createEmptyRecord());
}

function getWeeklyScore(entries, personId, weekId) {
  return getWeekDays(weekId).reduce(
    (sum, day) => sum + getDailyScore(entries, personId, toKey(day)),
    0,
  );
}

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
