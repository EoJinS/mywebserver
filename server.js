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
