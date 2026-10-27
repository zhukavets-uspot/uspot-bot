/* ─── Общие блоки: шапка, подвал, QR, звёзды ──────────────────── */
const QRCode = require("qrcode");
const { W, H, SAFE_TOP, SAFE_BOTTOM, PAD, CW, n, text, rect, circle, chip, measure, wrap } = require("./draw");
const { uMark } = require("./theme");
const WORD = require("./wordmark");

/* QR рисуем сами из модулей, а не берём готовый svg от библиотеки:
   нужен свой цвет, свой радиус подложки и гарантированное «тихое
   поле» вокруг — без него код не читается с чужого экрана.      */
const qrPath = (data) => {
  const qr = QRCode.create(data, { errorCorrectionLevel: "M" });
  const size = qr.modules.size;
  let d = "";
  for (let y = 0; y < size; y++) {
    let x = 0;
    while (x < size) {
      if (!qr.modules.get(x, y)) { x++; continue; }
      let len = 0;
      while (x + len < size && qr.modules.get(x + len, y)) len++;
      d += `M${x} ${y}h${len}v1h-${len}z`;
      x += len;
    }
  }
  return { d, size };
};

/* Тихое поле вокруг кода — ровно четыре модуля, как требует
   стандарт. С меньшим полем код формально валиден, но камера с
   чужого экрана его не ловит. Поэтому поле считаем от размера
   модуля, а не берём круглым числом пикселей.                   */
const qrBlock = ({ x, y, box, data, fg = "#111111" }) => {
  const { d, size } = qrPath(data);
  const scale = box / (size + 8);
  const pad = scale * 4;
  return rect({ x, y, w: box, h: box, r: 18, fill: "#FFFFFF" }) +
    `<g transform="translate(${n(x + pad)} ${n(y + pad)}) scale(${n(scale)})">` +
    `<path d="${d}" fill="${fg}"/></g>`;
};

/* Подпись площадки в углу: надпись «Uspot» и строка под ней.
   Надпись — обведённый контур из презентации, а не набранный шрифт:
   шрифт там другой (у «t» хвост, овалы геометрические), и Inter выдал
   бы «почти логотип». Знак рядом не ставим — в углу он мельчает и
   превращается в кляксу, а имя работает и без него.              */
const LOCK_CAP = 29;                       // высота капители надписи
const TAG_SIZE = 17, TAG_LS = 1.3;

const lockupWidth = (tagline = "", cap = LOCK_CAP) => {
  const wordW = WORD.width * (cap / WORD.baseline);
  const tagW = tagline ? measure(tagline, TAG_SIZE, 700, TAG_LS) : 0;
  return Math.max(wordW, tagW);
};

const brandLockup = ({ t, right, cy, cap = LOCK_CAP, tagline = "" }) => {
  const sc = cap / WORD.baseline;
  const wordW = WORD.width * sc;
  /* Две строки центрируем по блоку целиком, иначе подпись перевешивает
     и угол выглядит съехавшим вниз. */
  const blockH = tagline ? cap + 14 + TAG_SIZE : cap;
  const top = cy - blockH / 2;
  let out = `<g transform="translate(${n(right - wordW)} ${n(top)}) scale(${sc.toFixed(4)})">` +
    `<path d="${WORD.d}" fill="${t.ink}" fill-opacity="0.92"/></g>`;
  if (tagline) {
    out += text({ x: right, y: top + cap + 14 + TAG_SIZE * 0.8, s: TAG_SIZE, w: 700,
      ls: TAG_LS, fill: t.muted, anchor: "end", str: tagline });
  }
  return out;
};

/* Шапка: кто это. Фото — кружком, если его нет — буква на градиенте.
   Имя в одну строку: мы его обмеряем и при нужде ужимаем кегль,
   потому что «Анастасия Борисенко» длиннее, чем «Женя С».        */
const header = ({ t, name, role, photoHref, tagline = "", y = SAFE_TOP }) => {
  const R = 54, cx = PAD + R, cy = y + R;
  const avatar = photoHref
    ? `<clipPath id="avClip"><circle cx="${n(cx)}" cy="${n(cy)}" r="${R}"/></clipPath>` +
      `<image href="${photoHref}" x="${n(cx - R)}" y="${n(cy - R)}" width="${R * 2}" height="${R * 2}"` +
      ` preserveAspectRatio="xMidYMid slice" clip-path="url(#avClip)"/>` +
      circle({ cx, cy, r: R, fill: "none", stroke: t.ink, sw: 2, extra: 'stroke-opacity="0.18"' })
    : circle({ cx, cy, r: R, fill: "url(#accent)" }) +
      text({ x: cx, y: cy + 17, s: 48, w: 700, fill: "#FFFFFF", anchor: "middle", str: (name || "U").trim()[0].toUpperCase() });

  const tx = PAD + R * 2 + 26;
  const maxW = W - PAD - tx - lockupWidth(tagline) - 32;
  let ns = 40;
  while (ns > 28 && measure(name, ns, 700) > maxW) ns -= 1;

  /* Имя площадки — в правом верхнем углу, на одной линии с именем
     мастера. Угол во всех макетах пустой, лок туда ложится
     естественно и не спорит с заголовком. */
  const word = brandLockup({ t, right: W - PAD, cy, tagline });

  return avatar + word +
    text({ x: tx, y: cy - 6, s: ns, w: 700, fill: t.ink, str: name }) +
    text({ x: tx, y: cy + 34, s: 27, w: 500, fill: t.muted, str: (role || "").trim() });
};

/* Подвал прибит к низу безопасной зоны и одинаков во всех макетах:
   человек, увидевший вторую сторис мастера, уже знает, куда смотреть.

   Внутри плашки две строки: кнопка и под ней адрес со знаком. Код
   лежит на той же плашке — на светлой теме она белая, и собственная
   подложка кода с ней сливается, поэтому лишней рамки не видно.
   Кнопку рисуем настоящей кнопкой, хотя нажать её в сторис нельзя:
   она объясняет, что делать дальше, а адрес под ней и ведёт человека,
   и работает как имя площадки.                                    */
const FOOTER_H = 206;

const footer = ({ t, link, logoHref, brand = "mark" }) => {
  const h = FOOTER_H, y = SAFE_BOTTOM - h, box = 164;
  const bold = brand === "bold";
  const qrX = W - PAD - 24 - box, qrY = y + (h - box) / 2;
  const tx = PAD + 34;

  /* В «ярком» варианте плашка сама становится фирменным пятном.
     Градиент берём горизонтальный: слева он фиолетовый, и белая
     кнопка на нём читается лучше, чем на голубом конце. */
  const cardFill  = bold ? "url(#accentFlat)" : t.footerFill;
  const linkColor = bold ? "rgba(255,255,255,0.86)" : t.footerSub;
  const btnFill   = bold ? "#FFFFFF" : "url(#accentFlat)";
  const btnText   = bold ? "#111111" : "#FFFFFF";

  const btn = chip({
    x: tx, y: y + 30, h: 78, padX: 34, s: 31, w: 700,
    str: "Записаться  →", fill: btnFill, color: btnText, minW: 430,
  });

  return rect({ x: PAD, y, w: CW, h, r: 40, fill: cardFill }) +
    btn.svg +
    /* На градиентной плашке цветной глянцевый знак тонет — там белая
       векторная скоба. На белой и чёрной остаётся сам логотип. */
    (bold
      ? uMark({ cx: tx + 20, cy: y + 152, size: 40, color: "#FFFFFF", opacity: 1 })
      : logoHref
        ? `<image href="${logoHref}" x="${n(tx)}" y="${n(y + 132)}" width="40" height="40" preserveAspectRatio="xMidYMid meet"/>`
        : "") +
    text({ x: tx + 54, y: y + 162, s: 30, w: 600, fill: linkColor, str: link }) +
    qrBlock({ x: qrX, y: qrY, box, data: link, fg: "#111111" });
};

/* Пятиконечная звезда — для формата «Отзыв». */
const star = (cx, cy, r, fill) => {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 ? r * 0.44 : r;
    const a = (Math.PI / 5) * i - Math.PI / 2;
    pts.push(`${n(cx + rad * Math.cos(a))},${n(cy + rad * Math.sin(a))}`);
  }
  return `<polygon points="${pts.join(" ")}" fill="${fill}"/>`;
};

module.exports = { header, footer, qrBlock, star, brandLockup, lockupWidth, FOOTER_H };
