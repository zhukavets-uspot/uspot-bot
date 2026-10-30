/* ─── Карточка ссылки (Open Graph) ────────────────────────────────
   Сторис — вертикальная, 1080×1920: её человек публикует. Эта —
   горизонтальная, 1200×630: её никто не публикует, её показывает
   Telegram, WhatsApp и всё остальное, когда ссылку uspot.by/m/…
   просто вставили в переписку или в шапку профиля. Превью кликабельно
   целиком — именно поэтому носитель и нужен: по сторис нажать нельзя,
   по карточке можно.

   Холст другой, но примитивы, шрифт и палитра те же, что у сторис, —
   иначе два наших изображения выглядели бы из разных сервисов.    */
const { Resvg } = require("@resvg/resvg-js");
const { n, text, rect, circle, chip, measure, wrap } = require("./draw");
const { defs, uMark, VIOLET, SKY } = require("./theme");
const { brandLockup } = require("./parts");

const CW_ = 1200, CH = 630;
const PAD = 72;
const INNER = CW_ - PAD * 2;

/* Тема карточки — тёмная: в ленте переписки превью стоит среди белых
   пузырей, и тёмный прямоугольник там заметнее светлого. Значения
   повторяют тёмную тему сторис, чтобы цвета не разъезжались. */
const T = {
  ink: "#FFFFFF", muted: "#9B96B5", faint: "#6E6A86",
  slotFill: "#1B1930", slotStroke: "rgba(255,255,255,0.10)",
  markColor: "#FFFFFF", markOpacity: 0.07,
  lockGlossy: true,
};

const background = () =>
  rect({ x: 0, y: 0, w: CW_, h: CH, fill: "#0B0A12" }) +
  `<ellipse cx="${CW_ * 0.82}" cy="${CH * 0.08}" rx="${CW_ * 0.52}" ry="${CH * 0.52}" fill="url(#glowA)" opacity="0.85"/>` +
  `<ellipse cx="${CW_ * 0.04}" cy="${CH * 0.86}" rx="${CW_ * 0.42}" ry="${CH * 0.46}" fill="url(#glowB)" opacity="0.5"/>` +
  /* Знак уходит за правый край, как на сторис: фирменный элемент, а не
     картинка, забытая посреди холста. */
  uMark({ cx: CW_ - 40, cy: CH * 0.54, size: 430, color: T.markColor, opacity: T.markOpacity });

/* Аватар: фото, если есть, иначе кружок с первой буквой имени. */
const avatar = ({ cx, cy, r, href, letter }) => href
  ? `<g><clipPath id="avaC"><circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}"/></clipPath>` +
    `<image href="${href}" x="${n(cx - r)}" y="${n(cy - r)}" width="${n(r * 2)}" height="${n(r * 2)}"` +
    ` preserveAspectRatio="xMidYMid slice" clip-path="url(#avaC)"/>` +
    circle({ cx, cy, r, stroke: "rgba(255,255,255,0.18)", sw: 2 }) + `</g>`
  : circle({ cx, cy, r, fill: "url(#accent)" }) +
    text({ x: cx, y: cy + r * 0.36, s: r * 1.02, w: 700, fill: "#FFFFFF",
           anchor: "middle", str: (letter || "U").toUpperCase() });

const SLOT_H = 64, SLOT_GAP = 12, SLOT_S = 28, OFF_S = 20, OFF_GAP = 9;
const offLabel = (p) => `−${p}%`;

/* Ряд окошек. Помещается столько, сколько влезает в ширину: обрезать
   время на полуслове хуже, чем показать на одно меньше. */
const slotRow = ({ x, y, items }) => {
  const widthOf = (it) => 2 * 26 + measure(it.t, SLOT_S, 700) +
    (it.off ? OFF_GAP + measure(offLabel(it.off), OFF_S, 800) : 0);
  const fit = [];
  let used = 0;
  for (const it of items) {
    const w = widthOf(it);
    if (used + w > INNER) break;
    fit.push({ it, x: x + used, w });
    used += w + SLOT_GAP;
  }
  return fit.map(({ it, x: sx, w }) => {
    const tw = measure(it.t, SLOT_S, 700);
    const ow = it.off ? OFF_GAP + measure(offLabel(it.off), OFF_S, 800) : 0;
    const tx = sx + (w - tw - ow) / 2;
    const by = y + SLOT_H / 2 + SLOT_S * 0.35;
    return rect({ x: sx, y, w, h: SLOT_H, r: SLOT_H / 2, fill: T.slotFill,
                  stroke: it.off ? VIOLET : T.slotStroke, sw: it.off ? 2 : 1 }) +
      text({ x: tx, y: by, s: SLOT_S, w: 700, fill: T.ink, str: it.t }) +
      (it.off ? text({ x: tx + tw + OFF_GAP, y: by, s: OFF_S, w: 800, fill: VIOLET,
                       str: offLabel(it.off) }) : "");
  }).join("");
};

/* Заголовок в одну-две строки. Размер подбираем под длину: «Свободные
   окошки» и «Записываю на приём» не должны ломать одну и ту же вёрстку. */
const bigTitle = ({ str, yTop, maxW, maxH }) => {
  for (const s of [60, 54, 48, 42]) {
    const lines = wrap(str, maxW, s, 800);
    const h = lines.length * s * 1.1;
    if (lines.length <= 2 && h <= maxH) {
      return {
        svg: lines.map((l, i) => text({ x: PAD, y: yTop + s * 0.86 + i * s * 1.1,
                                        s, w: 800, ls: -1.2, fill: T.ink, str: l })).join(""),
        height: h,
      };
    }
  }
  const s = 42, lines = wrap(str, maxW, s, 800).slice(0, 2);
  return {
    svg: lines.map((l, i) => text({ x: PAD, y: yTop + s * 0.86 + i * s * 1.1,
                                    s, w: 800, ls: -1.2, fill: T.ink, str: l })).join(""),
    height: lines.length * s * 1.1,
  };
};

/* story — то, что вернул slotsStory, либо null, если окон нет совсем.
   Карточка обязана получиться в любом случае: ссылка живёт в шапке
   профиля неделями, и выходной у мастера не повод отдать пустоту. */
const buildCardSvg = ({ master, title, dateLabel, priceLine, times = [], tagline = "" }) => {
  const nameS = 40, roleS = 24;
  const avR = 44, avCx = PAD + avR, avCy = 76 + avR;
  const nameX = avCx + avR + 22;

  const head =
    avatar({ cx: avCx, cy: avCy, r: avR, href: master.photoHref,
             letter: (master.name || "U").trim()[0] }) +
    text({ x: nameX, y: avCy - 4, s: nameS, w: 800, ls: -0.8, fill: T.ink, str: master.name }) +
    (master.role ? text({ x: nameX, y: avCy + 30, s: roleS, w: 500, fill: T.muted, str: master.role }) : "") +
    brandLockup({ t: T, right: CW_ - PAD, cy: avCy, cap: 26, tagline });

  let y = 206;
  const t = bigTitle({ str: title, yTop: y, maxW: INNER * 0.72, maxH: 136 });
  y += t.height + 14;

  const meta = [dateLabel, priceLine].filter(Boolean).join("  ·  ");
  const metaSvg = meta ? text({ x: PAD, y: y + 22, s: 25, w: 600, fill: T.muted, str: meta }) : "";
  if (meta) y += 44;

  const slots = times.length ? slotRow({ x: PAD, y: y + 16, items: times }) : "";

  /* Призыв внизу — тот же, что в подвале сторис: надпись и адрес, без
     плашки. Нажимается всё превью целиком, поэтому рисовать кнопку
     значило бы обещать второе нажатие, которого нет. */
  const ctaY = CH - 108;
  const cta =
    text({ x: PAD, y: ctaY, s: 34, w: 800, ls: -0.6, fill: T.ink, str: "Записаться  →" }) +
    uMark({ cx: PAD + 13, cy: ctaY + 30, size: 28, color: T.ink, opacity: 0.95 }) +
    text({ x: PAD + 38, y: ctaY + 39, s: 25, w: 600, fill: T.muted, str: master.link });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CW_}" height="${CH}" viewBox="0 0 ${CW_} ${CH}">` +
    defs() + background() + head + t.svg + metaSvg + slots + cta + `</svg>`;
};

const renderCard = (opts) => {
  const svg = buildCardSvg(opts);
  const png = new Resvg(svg, {
    fitTo: { mode: "width", value: CW_ },
    font: { fontFiles: require("./fonts").fontFiles, loadSystemFonts: false, defaultFontFamily: "Inter" },
  }).render().asPng();
  return { png, svg };
};

module.exports = { buildCardSvg, renderCard, CARD_W: CW_, CARD_H: CH };
