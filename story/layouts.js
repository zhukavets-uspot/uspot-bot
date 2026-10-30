/* ─── Три макета: окошки, горящее, отзыв ─────────────────────────
   Общая схема у всех одна: шапка прибита к верху безопасной зоны,
   подвал — к низу, между ними «шапочный» блок (заголовок, чип) и
   смысловой блок. Смысловой центрируем в оставшемся просвете: при
   коротком отзыве и при трёх группах окон картинка должна выглядеть
   одинаково собранной, а не проваливаться дырой посередине.      */
const { W, H, SAFE_TOP, SAFE_BOTTOM, PAD, CW, n, text, rect, chip, flowChips, measure, wrap } = require("./draw");
const { header, footer, star, FOOTER_H } = require("./parts");

const GAP = 40;                       // минимальный зазор между блоками
const footerTop = () => SAFE_BOTTOM - FOOTER_H;

/* Заголовок в две строки с автоподбором кегля: мастер может задать
   свой, до 24 символов, и «Горящие окна на выходные» не должно
   вылезти за поля. Трекинг отрицательный — на таком кегле Inter
   без него рассыпается.                                          */
/* Подбор кегля. Тонкость: wrap с ограничением в две строки сам
   дописывает многоточие, и обрезанный заголовок проходит проверку по
   ширине наравне с целым. Из-за этого крупный огрызок побеждал
   умещающуюся целиком строку помельче — «На понедельник много…»
   вместо «На понедельник много свободного времени». Поэтому сначала
   ищем кегль, при котором текст влезает ЦЕЛИКОМ, и только если такого
   нет во всём диапазоне — обрезаем, на самом мелком. */
const bigTitle = ({ str, yTop, max = 104, min = 44, color, maxH = Infinity }) => {
  const widthOk = (ls, sz) => ls.every((l) => measure(l, sz, 800, -sz * 0.02) <= CW);
  let s = min, lines = wrap(str, min, 800, CW, 2);
  for (let t = max; t >= min; t -= 2) {
    const whole = wrap(str, t, 800, CW, 99);
    if (whole.length <= 2 && widthOk(whole, t) && whole.length * t * 1.02 <= maxH) {
      s = t; lines = whole; break;
    }
  }
  const lh = s * 1.02;
  let out = "";
  lines.forEach((l, i) => {
    out += text({ x: PAD, y: yTop + s * 0.78 + i * lh, s, w: 800, fill: color, ls: -s * 0.02, str: l });
  });
  return { svg: out, height: lines.length * lh, size: s };
};

const accentChip = ({ x, y, str, s = 29, h = 72, padX = 32 }) =>
  chip({ x, y, h, padX, s, w: 700, str, fill: "url(#accentFlat)", color: "#FFFFFF" });

const money = (v, from = false) => `${from ? "от " : ""}${v} руб`;

/* Центрируем смысловой блок в просвете и не даём ему наехать на
   «шапочный»: если места не хватило, прижимаем к подвалу и
   сообщаем вызывающему, сколько не влезло.                       */
const place = (topEnd, blockH) => {
  const from = topEnd + GAP, to = footerTop() - GAP;
  let y = from + Math.max(0, (to - from - blockH) / 2);
  if (y + blockH > to) y = to - blockH;
  return { y, overflow: Math.max(0, from + blockH - to) };
};

/* Цвета внутри белой карточки темы «с фото» всегда тёмные —
   иначе белый текст лёг бы на белое.                             */
const inkOf = (t) => (t.onCard ? { ink: "#111111", muted: "#6B7280", slot: "#F4F2FF", stroke: "rgba(17,17,17,0.06)" }
                               : { ink: t.ink, muted: t.muted, slot: t.slotFill, stroke: t.slotStroke });

const cardWrap = (t, y, h) => (t.onCard ? rect({ x: PAD, y, w: CW, h, r: 40, fill: t.card }) : "");

/* ── Макет 1. Свободные окошки ──────────────────────────────
   Окно со скидкой рисуем отдельной плашкой: акцентная обводка плюс
   процент цветом. Без этого скидка была просто длинной подписью
   внутри такой же плашки и терялась в ряду одинаковых времён.   */
const SLOT_H = 104, SLOT_GAP = 16, SLOT_PAD = 32, SLOT_S = 44, OFF_S = 30, OFF_GAP = 11;
const VIOLET_TEXT = "#7B61FF";

const slotItem = (v) => (typeof v === "string" ? { t: v, off: 0 } : { t: v.t, off: +v.off || 0 });
const offLabel = (off) => `−${off}%`;
const slotWidth = (it) =>
  measure(it.t, SLOT_S, 700) + (it.off ? OFF_GAP + measure(offLabel(it.off), OFF_S, 800) : 0) + SLOT_PAD * 2;

const slotChip = (it, x, y, c) => {
  const w = slotWidth(it);
  const tw = measure(it.t, SLOT_S, 700);
  const ow = it.off ? OFF_GAP + measure(offLabel(it.off), OFF_S, 800) : 0;
  const sx = x + (w - tw - ow) / 2, by = y + SLOT_H / 2 + SLOT_S * 0.35;
  return rect({ x, y, w, h: SLOT_H, r: SLOT_H / 2, fill: c.slot,
                stroke: it.off ? VIOLET_TEXT : c.stroke, sw: it.off ? 3 : 1 }) +
    text({ x: sx, y: by, s: SLOT_S, w: 700, fill: c.ink, str: it.t }) +
    (it.off ? text({ x: sx + tw + OFF_GAP, y: by, s: OFF_S, w: 800, fill: VIOLET_TEXT, str: offLabel(it.off) }) : "");
};

/* Раскладка плашек по рядам. Считаем отдельно от рисования: высота
   блока нужна раньше, чем известно, куда его класть. */
const slotRows = (items, maxW) => {
  const rows = [[]];
  let w = 0;
  for (const raw of items) {
    const it = slotItem(raw), iw = slotWidth(it);
    if (rows[rows.length - 1].length && w + SLOT_GAP + iw > maxW) { rows.push([]); w = 0; }
    else if (rows[rows.length - 1].length) w += SLOT_GAP;
    rows[rows.length - 1].push(it); w += iw;
  }
  return rows;
};

const slotsLayout = (d, t) => {
  const c = inkOf(t);
  const pad = t.onCard ? 46 : 0;
  const innerW = CW - pad * 2;
  const LABEL_H = 30, LABEL_GAP = 18, GROUP_GAP = 34;

  const measured = d.groups.map((g) => {
    const rows = slotRows(g.times, innerW);
    return { g, rows, h: LABEL_H + LABEL_GAP + rows.length * SLOT_H + (rows.length - 1) * SLOT_GAP };
  });
  const blockH = measured.reduce((a, m) => a + m.h, 0) + GROUP_GAP * (measured.length - 1);

  /* Верх. Сколько места под заголовок — считаем от уже известной
     высоты блока с окнами, иначе при трёх группах и теме «с фото»
     карточка наезжала на чип с датой.                            */
  let cy = SAFE_TOP + 150;
  const roomTop = footerTop() - GAP - (blockH + pad * 2) - GAP - cy;
  const title = bigTitle({ str: d.title, yTop: cy, color: t.ink, maxH: roomTop - (d.priceLine ? 56 : 0) - 102 });
  let top = title.svg;
  cy += title.height + 22;
  if (d.priceLine) { top += text({ x: PAD, y: cy + 26, s: 30, w: 600, fill: t.muted, str: d.priceLine }); cy += 56; }
  top += accentChip({ x: PAD, y: cy + 8, str: d.dateLabel }).svg;
  const topEnd = cy + 8 + 72;

  const { y: blockY } = place(topEnd, blockH + pad * 2);
  let y = blockY + pad;
  let body = cardWrap(t, blockY, blockH + pad * 2);
  for (const m of measured) {
    body += text({ x: PAD + pad, y: y + 24, s: 23, w: 800, fill: c.muted, ls: 3.4, str: m.g.label.toUpperCase() });
    y += LABEL_H + LABEL_GAP;
    for (const row of m.rows) {
      let x = PAD + pad;
      for (const it of row) { body += slotChip(it, x, y, c); x += slotWidth(it) + SLOT_GAP; }
      y += SLOT_H + SLOT_GAP;
    }
    y += GROUP_GAP - SLOT_GAP;
  }
  return top + body;
};

/* ── Макет 2. Горящее окно ──────────────────────────────────── */
const hotLayout = (d, t) => {
  const c = inkOf(t);
  const pad = t.onCard ? 48 : 0;
  const x = PAD + pad;

  const TIME_S = 210;
  const blockH = 34 + TIME_S * 0.78 + 66 + 96 + 52;

  let cy = SAFE_TOP + 150;
  const roomTop = footerTop() - GAP - (blockH + pad * 2) - GAP - cy;
  let top = accentChip({ x: PAD, y: cy, str: d.badge }).svg;
  cy += 72 + 30;
  const title = bigTitle({ str: d.title, yTop: cy, color: t.ink, maxH: roomTop - 102 });
  top += title.svg;
  const topEnd = cy + title.height;

  const { y: blockY } = place(topEnd, blockH + pad * 2);
  let y = blockY + pad;
  let body = cardWrap(t, blockY, blockH + pad * 2);

  body += text({ x, y: y + 24, s: 25, w: 800, fill: c.muted, ls: 4, str: d.when.toUpperCase() });
  y += 34;
  body += text({ x, y: y + TIME_S * 0.78, s: TIME_S, w: 800, fill: c.ink, ls: -TIME_S * 0.03, str: d.time });
  y += TIME_S * 0.78 + 48;
  body += text({ x, y: y + 12, s: 36, w: 600, fill: c.ink, str: d.service });
  y += 78;

  /* Цена по акции крупно, старая рядом зачёркнутой: скидка и есть
     причина, по которой это окно заберут за десять минут.        */
  if (d.oldPrice) {
    body += text({ x, y: y + 48, s: 66, w: 800, fill: c.ink, str: money(d.price) });
    const ox = x + measure(money(d.price), 66, 800) + 26;
    const oldStr = money(d.oldPrice), oldW = measure(oldStr, 38, 500);
    body += text({ x: ox, y: y + 42, s: 38, w: 500, fill: c.muted, str: oldStr });
    body += rect({ x: ox - 2, y: y + 28, w: oldW + 4, h: 3, fill: c.muted, op: 0.85 });
    body += accentChip({ x: ox + oldW + 26, y: y + 2, str: `−${d.pct}%`, s: 30, h: 58, padX: 24 }).svg;
  } else {
    body += text({ x, y: y + 48, s: 66, w: 800, fill: c.ink, str: money(d.price, d.priceFrom) });
  }
  y += 96;
  body += text({ x, y: y + 36, s: 27, w: 500, fill: c.muted, str: d.note });
  return top + body;
};

/* ── Макет 3. Отзыв ─────────────────────────────────────────── */
const reviewLayout = (d, t) => {
  const c = inkOf(t);
  const pad = t.onCard ? 48 : 0;
  const innerW = CW - pad * 2, x = PAD + pad;

  /* Кегль под длину: «Было шикарно!» должно смотреться плакатом,
     длинный отзыв — остаться читаемым.                           */
  let s = 64, lines = [];
  for (; s >= 36; s -= 2) {
    lines = wrap(`«${d.text}»`, s, 700, innerW, 6);
    if (lines.length <= (s > 52 ? 4 : 6)) break;
  }
  const lh = s * 1.26, STARS_H = 80, AUTHOR_H = 76;
  const blockH = STARS_H + lines.length * lh + AUTHOR_H;

  let cy = SAFE_TOP + 150;
  const roomTop = footerTop() - GAP - (blockH + pad * 2) - GAP - cy;
  const title = bigTitle({ str: d.title, yTop: cy, max: 100, color: t.ink, maxH: roomTop - 96 });
  let top = title.svg;
  cy += title.height + 24;
  top += accentChip({ x: PAD, y: cy, str: d.summary }).svg;
  const topEnd = cy + 72;

  const { y: blockY } = place(topEnd, blockH + pad * 2);
  let y = blockY + pad;
  let body = cardWrap(t, blockY, blockH + pad * 2);

  for (let i = 0; i < 5; i++) body += star(x + 25 + i * 64, y + 26, 27, i < d.rating ? "#F59E0B" : c.muted);
  y += STARS_H;
  lines.forEach((l, i) => { body += text({ x, y: y + s * 0.8 + i * lh, s, w: 700, fill: c.ink, str: l }); });
  y += lines.length * lh + 22;
  body += text({ x, y: y + 32, s: 30, w: 600, fill: c.muted, str: `— ${d.author}` });
  return top + body;
};


/* ── Макет 4. Неделя ────────────────────────────────────────
   Семь дней по шесть времён в сторис не влезают, поэтому неделя
   показывает дни и количество окон, а точное время — по ссылке.
   Это заодно честнее: за сутки половину времён всё равно займут. */
const weekLayout = (d, t) => {
  const c = inkOf(t);
  const pad = t.onCard ? 42 : 0;
  const x = PAD + pad;
  const ROW = 112;
  const blockH = d.days.length * ROW;

  let cy = SAFE_TOP + 150;
  const roomTop = footerTop() - GAP - (blockH + pad * 2) - GAP - cy;
  const title = bigTitle({ str: d.title, yTop: cy, color: t.ink, maxH: roomTop - (d.priceLine ? 56 : 0) - 102 });
  let top = title.svg;
  cy += title.height + 22;
  if (d.priceLine) { top += text({ x: PAD, y: cy + 26, s: 30, w: 600, fill: t.muted, str: d.priceLine }); cy += 56; }
  top += accentChip({ x: PAD, y: cy + 8, str: d.dateLabel }).svg;
  const topEnd = cy + 8 + 72;

  const { y: blockY } = place(topEnd, blockH + pad * 2);
  let y = blockY + pad;
  let body = cardWrap(t, blockY, blockH + pad * 2);

  d.days.forEach((day, i) => {
    if (i) body += rect({ x, y: y - 1, w: CW - pad * 2, h: 2, fill: c.muted, op: 0.18 });
    const cnt = day.open
      ? "есть окна"
      : `${day.count} ${day.count % 10 === 1 && day.count % 100 !== 11 ? "окно" : (day.count % 10 >= 2 && day.count % 10 <= 4 && (day.count % 100 < 10 || day.count % 100 >= 20)) ? "окна" : "окон"}`;
    const pill = chip({ x: 0, y: 0, h: 60, padX: 26, s: 28, w: 700, str: cnt, fill: c.slot, color: c.ink, stroke: c.stroke });
    body += text({ x, y: y + 52, s: 36, w: 700, fill: c.ink, str: day.label });
    body += text({ x, y: y + 92, s: 26, w: 500, fill: c.muted, str: day.span });
    body += chip({ x: W - PAD - pad - pill.width, y: y + 26, h: 60, padX: 26, s: 28, w: 700, str: cnt,
                   fill: c.slot, color: c.ink, stroke: c.stroke }).svg;
    y += ROW;
  });
  return top + body;
};

module.exports = { slotsLayout, hotLayout, reviewLayout, weekLayout, header, footer };
