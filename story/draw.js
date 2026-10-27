/* ─── Примитивы SVG ───────────────────────────────────────────────
   Холст сторис — 1080×1920. Инстаграм рисует поверх картинки свою
   обвязку: сверху аватар и прогресс-полоски, снизу строка ответа.
   Поэтому содержимое держим в безопасной зоне: 260 сверху и 340
   снизу. Всё, что окажется за этими границами, у части людей
   просто не будет видно.                                         */
const { measure, wrap } = require("./fonts");

const W = 1080, H = 1920;
const SAFE_TOP = 260, SAFE_BOTTOM = H - 340;   // 260 … 1580
const PAD = 80;                                 // боковые поля
const CW = W - PAD * 2;                         // 920 — рабочая ширина

const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

const n = (v) => Math.round(v * 100) / 100;

const text = ({ x, y, s, w = 400, fill = "#111111", anchor = "start", ls = 0, op = 1, str }) =>
  `<text x="${n(x)}" y="${n(y)}" font-family="Inter" font-size="${n(s)}" font-weight="${w}"` +
  ` fill="${fill}"${op !== 1 ? ` fill-opacity="${op}"` : ""}` +
  `${anchor !== "start" ? ` text-anchor="${anchor}"` : ""}` +
  `${ls ? ` letter-spacing="${n(ls)}"` : ""}>${esc(str)}</text>`;

const rect = ({ x, y, w, h, r = 0, fill = "none", stroke = null, sw = 1, op = 1, extra = "" }) =>
  `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${n(r)}" ry="${n(r)}"` +
  ` fill="${fill}"${op !== 1 ? ` fill-opacity="${op}"` : ""}` +
  `${stroke ? ` stroke="${stroke}" stroke-width="${sw}"` : ""}${extra ? " " + extra : ""}/>`;

const circle = ({ cx, cy, r, fill = "none", stroke = null, sw = 1, op = 1, extra = "" }) =>
  `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="${fill}"` +
  `${op !== 1 ? ` fill-opacity="${op}"` : ""}` +
  `${stroke ? ` stroke="${stroke}" stroke-width="${sw}"` : ""}${extra ? " " + extra : ""}/>`;

/* Плашка с текстом по центру: ширина считается от самого текста,
   поэтому «9:00» и «18:30» не растягиваются до одинаковой ширины
   искусственно — ряд выглядит живым, а не таблицей.              */
const chip = ({ x, y, h, padX, s, w, str, fill, color, stroke = null, sw = 1, ls = 0, minW = 0 }) => {
  const tw = measure(str, s, w, ls);
  const cw = Math.max(minW, tw + padX * 2);
  return {
    width: cw,
    svg: rect({ x, y, w: cw, h, r: h / 2, fill, stroke, sw }) +
         text({ x: x + cw / 2, y: y + h / 2 + s * 0.35, s, w, fill: color, anchor: "middle", ls, str }),
  };
};

/* Раскладка плашек в ряды по ширине контейнера. */
const flowChips = ({ x, y, maxW, gap, items, h, padX, s, w, fill, color, stroke, ls = 0 }) => {
  let cx = x, cy = y, out = "", rows = 1;
  for (const str of items) {
    const tw = measure(str, s, w, ls) + padX * 2;
    if (cx > x && cx + tw > x + maxW) { cx = x; cy += h + gap; rows++; }
    out += chip({ x: cx, y: cy, h, padX, s, w, str, fill, color, stroke, ls }).svg;
    cx += tw + gap;
  }
  return { svg: out, height: cy + h - y, rows };
};

module.exports = { W, H, SAFE_TOP, SAFE_BOTTOM, PAD, CW, esc, n, text, rect, circle, chip, flowChips, measure, wrap };
