/* ─── Темы ────────────────────────────────────────────────────────
   Три штуки, как договорились: светлая, тёмная и по фото мастера.
   Цвета берём из DESIGN.md приложения — чернила #111111 и градиент
   #7B61FF → #5AC8FA. Сторис должна читаться как наш экран, а не
   как сторонний шаблон.                                           */
const { W, H, rect, circle } = require("./draw");

const VIOLET = "#7B61FF", SKY = "#5AC8FA", INK = "#111111";

/* Знак «U» вектором, а не картинкой: логотип у нас растровый 256×256,
   и в фоне на половину холста он бы замылился. Пропорции сняты с него —
   толстая скоба со скруглёнными торцами. Рисуется обводкой, поэтому
   масштабируется без потерь и красится в любой цвет.                */
const uMark = ({ cx, cy, size, color, opacity = 1 }) => {
  const k = size / 100;
  const x1 = cx - size / 2 + 19 * k, x2 = cx - size / 2 + 81 * k;
  const top = cy - size / 2 + 16 * k, arc = cy - size / 2 + 56 * k;
  const r = (x2 - x1) / 2;
  return `<path d="M${x1.toFixed(1)} ${top.toFixed(1)} V${arc.toFixed(1)}` +
    ` A${r.toFixed(1)} ${r.toFixed(1)} 0 0 0 ${x2.toFixed(1)} ${arc.toFixed(1)}` +
    ` V${top.toFixed(1)}" fill="none" stroke="${color}" stroke-width="${(26 * k).toFixed(1)}"` +
    ` stroke-linecap="round" opacity="${opacity}"/>`;
};

/* Водяной знак уходит за правый край — так он читается как фирменный
   элемент, а не как забытая посреди холста картинка. Лежит в фоне,
   под всем содержимым, и никогда не спорит с текстом.              */
const watermark = (t) => uMark({
  cx: W - 20, cy: 1010, size: 620,
  color: t.markColor, opacity: t.markOpacity,
});

/* Общие определения: градиенты, свечения, маска под аватар. */
const defs = ({ blurPhoto = false } = {}) => `
<defs>
  <linearGradient id="accent" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${VIOLET}"/><stop offset="1" stop-color="${SKY}"/>
  </linearGradient>
  <linearGradient id="accentFlat" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="${VIOLET}"/><stop offset="1" stop-color="${SKY}"/>
  </linearGradient>
  <radialGradient id="glowA" cx="0.5" cy="0.5" r="0.5">
    <stop offset="0" stop-color="${VIOLET}" stop-opacity="0.55"/>
    <stop offset="1" stop-color="${VIOLET}" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="glowB" cx="0.5" cy="0.5" r="0.5">
    <stop offset="0" stop-color="${SKY}" stop-opacity="0.45"/>
    <stop offset="1" stop-color="${SKY}" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0"    stop-color="#0B0A12" stop-opacity="0.58"/>
    <stop offset="0.30" stop-color="#0B0A12" stop-opacity="0.26"/>
    <stop offset="0.62" stop-color="#0B0A12" stop-opacity="0.46"/>
    <stop offset="1"    stop-color="#0B0A12" stop-opacity="0.88"/>
  </linearGradient>
  <clipPath id="avatarClip"><circle cx="0" cy="0" r="1"/></clipPath>
  ${blurPhoto ? `<filter id="bgBlur" x="-10%" y="-10%" width="120%" height="120%">
    <feGaussianBlur stdDeviation="13"/></filter>` : ""}
</defs>`;

const THEMES = {
  light: {
    id: "light", name: "Светлая",
    ink: INK, muted: "#6B7280", faint: "#9CA3AF",
    card: "#FFFFFF", cardStroke: "rgba(17,17,17,0.07)",
    slotFill: "#FFFFFF", slotStroke: "rgba(17,17,17,0.08)", slotText: INK,
    footerFill: INK, footerText: "#FFFFFF", footerSub: "rgba(255,255,255,0.62)",
    qrFg: "#FFFFFF", qrBg: "transparent",
    markColor: VIOLET, markOpacity: 0.13,
    /* На светлом фоне пастельный глянцевый знак выцветает. В локе
       берём монохромную скобу в цвет надписи — так делают все, у кого
       логотип светлый, и читается это чище. */
    lockGlossy: false,
    background: (ctx, t) =>
      rect({ x: 0, y: 0, w: W, h: H, fill: "#EDE9FB" }) +
      `<ellipse cx="${W * 0.86}" cy="${H * 0.08}" rx="${W * 0.78}" ry="${H * 0.26}" fill="url(#glowA)" opacity="0.5"/>` +
      `<ellipse cx="${W * 0.08}" cy="${H * 0.52}" rx="${W * 0.66}" ry="${H * 0.24}" fill="url(#glowB)" opacity="0.4"/>` +
      rect({ x: 0, y: H * 0.58, w: W, h: H * 0.42, fill: "#FFFFFF", op: 0.28 }) +
      (ctx.brand === "sign" ? "" : watermark(t)),
  },
  dark: {
    id: "dark", name: "Тёмная",
    ink: "#FFFFFF", muted: "#9B96B5", faint: "#6E6A86",
    card: "#171523", cardStroke: "rgba(255,255,255,0.09)",
    slotFill: "#1B1930", slotStroke: "rgba(255,255,255,0.10)", slotText: "#FFFFFF",
    footerFill: "#FFFFFF", footerText: INK, footerSub: "rgba(17,17,17,0.55)",
    qrFg: INK, qrBg: "transparent",
    markColor: "#FFFFFF", markOpacity: 0.07,
    lockGlossy: true,
    background: (ctx, t) =>
      rect({ x: 0, y: 0, w: W, h: H, fill: "#0B0A12" }) +
      `<ellipse cx="${W * 0.84}" cy="${H * 0.10}" rx="${W * 0.72}" ry="${H * 0.24}" fill="url(#glowA)" opacity="0.85"/>` +
      `<ellipse cx="${W * 0.06}" cy="${H * 0.60}" rx="${W * 0.62}" ry="${H * 0.22}" fill="url(#glowB)" opacity="0.6"/>` +
      (ctx.brand === "sign" ? "" : watermark(t)),
  },
  photo: {
    id: "photo", name: "С фото",
    ink: "#FFFFFF", muted: "rgba(255,255,255,0.74)", faint: "rgba(255,255,255,0.55)",
    card: "#FFFFFF", cardStroke: "rgba(17,17,17,0.06)",
    slotFill: "#FFFFFF", slotStroke: "rgba(17,17,17,0.08)", slotText: INK,
    footerFill: INK, footerText: "#FFFFFF", footerSub: "rgba(255,255,255,0.62)",
    qrFg: "#FFFFFF", qrBg: "transparent",
    markColor: "#FFFFFF", markOpacity: 0.12,
    lockGlossy: true,
    onCard: true,                       // слоты живут на белой карточке
    background: (ctx, t) =>
      (ctx.photoHref
        ? `<image href="${ctx.photoHref}" x="0" y="0" width="${W}" height="${H}"` +
          ` preserveAspectRatio="xMidYMid slice" filter="url(#bgBlur)"/>`
        : rect({ x: 0, y: 0, w: W, h: H, fill: "#241F3A" })) +
      rect({ x: 0, y: 0, w: W, h: H, fill: "url(#scrim)" }) +
      (ctx.brand === "sign" ? "" : watermark(t)),
  },
};

module.exports = { THEMES, defs, uMark, VIOLET, SKY, INK };
