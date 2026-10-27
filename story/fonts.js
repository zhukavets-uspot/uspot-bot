/* ─── Шрифты и обмер строк ────────────────────────────────────────
   resvg подставляет шрифт по имени семейства и весу, но ширину
   строки заранее не скажет. А ширина нужна: от неё зависит ширина
   плашки под временем, перенос отзыва по строкам и решение, влезло
   имя мастера в одну строку или нет. Поэтому тот же ttf читаем
   через opentype и меряем сами — измеряем ровно тем файлом,
   которым потом рисуем, иначе плашки поедут.                     */
const fs = require("fs");
const path = require("path");
const opentype = require("opentype.js");

const DIR = path.join(__dirname, "fonts");
const WEIGHTS = [400, 500, 600, 700, 800];

const faces = {};
for (const w of WEIGHTS) {
  const file = path.join(DIR, `Inter-${w}.ttf`);
  faces[w] = { path: file, font: opentype.parse(fs.readFileSync(file).buffer.slice(0)) };
}

const fontFiles = WEIGHTS.map((w) => faces[w].path);

/* Ближайший доступный вес: просят 650 — дадим 600, а не упадём. */
const faceFor = (weight = 400) =>
  faces[WEIGHTS.reduce((a, b) => (Math.abs(b - weight) < Math.abs(a - weight) ? b : a))];

/* Ширина строки в пикселях.
   Считаем по cmap, складывая ширины глифов, и намеренно не зовём
   getAdvanceWidth: он поднимает весь движок OpenType-фич, а Inter
   содержит ccmp-подстановки, которые opentype.js не умеет и падает.
   Кернинг при этом не учитывается — он у Inter порядка процента,
   и ошибка идёт в плюс, то есть плашка выйдет чуть шире, а не уже.
   letterSpacing в SVG добавляется после каждого символа.          */
const measure = (text, size, weight = 400, letterSpacing = 0) => {
  if (!text) return 0;
  const font = faceFor(weight).font;
  const scale = size / font.unitsPerEm;
  let w = 0;
  for (const ch of String(text)) {
    const g = font.charToGlyph(ch);
    w += (g && g.advanceWidth ? g.advanceWidth : font.unitsPerEm * 0.5) * scale;
  }
  return w + letterSpacing * String(text).length;
};

/* Перенос по словам под заданную ширину. Длинное слово не режем:
   лучше вылезти на пару пикселей, чем разорвать «комбинированный». */
const wrap = (text, size, weight, maxWidth, maxLines = 99) => {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const word of words) {
    const next = cur ? `${cur} ${word}` : word;
    if (measure(next, size, weight) <= maxWidth || !cur) cur = next;
    else { lines.push(cur); cur = word; }
    if (lines.length === maxLines) break;
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  /* Обрезали на середине — ставим многоточие в конец последней строки. */
  if (lines.length === maxLines) {
    const used = lines.join(" ").split(/\s+/).length;
    if (used < words.length) {
      let last = lines[maxLines - 1];
      while (last && measure(last + "…", size, weight) > maxWidth) {
        last = last.replace(/\s*\S+$/, "");
      }
      lines[maxLines - 1] = (last || "") + "…";
    }
  }
  return lines;
};

module.exports = { fontFiles, measure, wrap };
