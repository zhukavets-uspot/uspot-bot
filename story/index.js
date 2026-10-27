/* ─── Сборка и растеризация сторис ───────────────────────────────
   Один источник — SVG. Им же рисуем превью в мини-аппе, им же
   растеризуем PNG на сервере, поэтому превью физически не может
   соврать мастеру о том, что уйдёт в инстаграм.                  */
const { Resvg } = require("@resvg/resvg-js");
const { W, H } = require("./draw");
const { THEMES, defs } = require("./theme");
const { slotsLayout, hotLayout, reviewLayout, weekLayout, header, footer } = require("./layouts");

const LAYOUTS = { slots: slotsLayout, hot: hotLayout, review: reviewLayout, week: weekLayout };

/* brand — насколько громко звучит площадка на картинке:
   "sign" — только подпись в подвале,
   "mark" — плюс знак в фоне,
   "bold" — плюс фирменный градиент на подвале.                     */
const BRANDS = ["sign", "mark", "bold"];

const buildSvg = ({ format, theme, data, brand = "mark", tagline = "" }) => {
  const t = THEMES[theme] || THEMES.light;
  const layout = LAYOUTS[format];
  if (!layout) throw new Error(`неизвестный формат: ${format}`);
  const b = BRANDS.includes(brand) ? brand : "mark";
  const ctx = { photoHref: data.master.photoHref, brand: b };

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    defs({ blurPhoto: t.id === "photo" }) +
    t.background(ctx, t) +
    header({ t, name: data.master.name, role: data.master.role,
             photoHref: data.master.photoHref, tagline }) +
    layout(data, t) +
    footer({ t, link: data.master.link, logoHref: data.master.logoHref, brand: b }) +
    `</svg>`;
};

const render = (opts) => {
  const svg = buildSvg(opts);
  const png = new Resvg(svg, {
    fitTo: { mode: "width", value: W },
    font: { fontFiles: require("./fonts").fontFiles, loadSystemFonts: false, defaultFontFamily: "Inter" },
  }).render().asPng();
  return { png, svg };
};

module.exports = { render, buildSvg, THEMES, LAYOUTS, BRANDS };
