/* ─── Данные для сторис ──────────────────────────────────────────
   Отдельный файл, потому что правила отбора окон — это продуктовое
   решение, а не вёрстка. Их должны одинаково применять и кабинет
   (мастер нажал «Сделать сторис»), и бот (сам предложил после
   отмены). Один источник правил — один результат.

   Модуль получает db и пару помощников из index.js, чтобы не
   тянуть за собой половину бота.                                 */

const fs = require("fs");
const path = require("path");

const MINSK_OFFSET_MS = 3 * 60 * 60 * 1000;
const STEP_MIN = 30;                 // сетка начал, как в freeSlotsFor
const MAX_TIMES = 6;                 // больше шести — это уже расписание, а не сторис
const OPEN_DAY_TIMES = 4;            // день почти пустой — показываем меньше
const OPEN_DAY_DENSITY = 0.6;        // с какой доли свободного день считается пустым

const minutesOf = (t) => { const [h, m] = String(t || "0:0").split(":").map(Number); return h * 60 + (m || 0); };
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

const RU_MAP = {"а":"a","б":"b","в":"v","г":"g","д":"d","е":"e","ё":"yo","ж":"zh","з":"z","и":"i","й":"y","к":"k","л":"l","м":"m","н":"n","о":"o","п":"p","р":"r","с":"s","т":"t","у":"u","ф":"f","х":"kh","ц":"ts","ч":"ch","ш":"sh","щ":"shch","ъ":"","ы":"y","ь":"","э":"e","ю":"yu","я":"ya"," ":"_","-":"_"};
const toSlug = (s = "") => String(s).toLowerCase().split("").map((c) => RU_MAP[c] ?? c).join("")
  .replace(/[^a-z0-9_]/g, "").replace(/_+/g, "_").replace(/^_|_$/g, "");

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const ruWeekdayRaw = (iso) => new Intl.DateTimeFormat("ru-RU", { weekday: "long", timeZone: "Europe/Minsk" })
  .format(new Date(iso + "T12:00:00"));
const ruWeekday = (iso) => cap(ruWeekdayRaw(iso));
const ruDayMonth = (iso) => new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: "Europe/Minsk" })
  .format(new Date(iso + "T12:00:00"));

const { suggestTitles, defaultTitle } = require("./phrases");

/* Как назвать день внутри фразы: «на сегодня», «на завтра», «на
   понедельник». Для первых двух — наречия, дальше — название дня. */
const dayWordOf = (iso, offset) => offset === 0 ? "сегодня"
  : offset === 1 ? "завтра"
  : String(ruWeekdayRaw(iso)).toLowerCase();

const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  return b === 1 ? one : many;
};

/* Аватары меняются редко, а тянуть их на каждый рендер — это лишние
   полсекунды и лишний трафик у Supabase. Держим небольшой кэш. */
const imgCache = new Map();
const IMG_TTL = 30 * 60 * 1000;
const dataUri = async (url) => {
  if (!url) return null;
  const hit = imgCache.get(url);
  if (hit && Date.now() - hit.at < IMG_TTL) return hit.uri;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 6 * 1024 * 1024) return null;          // чужой файл, не доверяем размеру
    const uri = `data:${r.headers.get("content-type") || "image/jpeg"};base64,${buf.toString("base64")}`;
    imgCache.set(url, { uri, at: Date.now() });
    return uri;
  } catch (e) { return null; }
};

let logoUri = null;
const logo = () => {
  if (logoUri !== null) return logoUri || null;
  try {
    const f = path.join(__dirname, "..", "vendor", "img", "logo.png");
    logoUri = `data:image/png;base64,${fs.readFileSync(f).toString("base64")}`;
  } catch (e) { logoUri = ""; }
  return logoUri || null;
};

module.exports = ({ db, BOOK_LEAD_MIN = 60 }) => {

  const minskNow = () => new Date(Date.now() + MINSK_OFFSET_MS);
  const minskDateStr = (offsetDays = 0) =>
    new Date(Date.now() + MINSK_OFFSET_MS + offsetDays * 86400000).toISOString().split("T")[0];
  const minskMinutes = () => { const d = minskNow(); return d.getUTCHours() * 60 + d.getUTCMinutes(); };

  /* Рабочее окно даты: переопределение на дату важнее недельного
     шаблона — мастер мог открыть субботу или закрыть вторник.     */
  const windowOn = (weekMap, ovMap, iso) => {
    const jsDay = new Date(iso + "T12:00:00").getDay();
    const dow = jsDay === 0 ? 6 : jsDay - 1;                // 0 = понедельник
    const row = ovMap[iso] || weekMap[dow];
    if (!row || row.is_working === false) return null;
    return { from: minutesOf(row.start_time || "09:00"), to: minutesOf(row.end_time || "18:00") };
  };

  /* Свободные начала на дату. notBefore — для «сегодня»: записаться
     можно не позже чем за час, и показывать 14:30 в 14:25 значит
     обмануть и клиента, и мастера.                                */
  const freeStartsOn = (win, busy, durMin, notBefore = null) => {
    if (!win) return { times: [], capacity: 0 };
    const out = [];
    let capacity = 0;
    for (let t = win.from; t + durMin <= win.to; t += STEP_MIN) {
      capacity++;
      if (notBefore !== null && t < notBefore) continue;
      if (busy.some((b) => b.s < t + durMin && b.e > t)) continue;
      out.push(t);
    }
    return { times: out, capacity };
  };

  /* Сколько окон показать. Полностью пустой день в сторис читается
     как «ко мне никто не ходит», поэтому чем свободнее день, тем
     меньше времён выкладываем — и берём их вразброс по дню, а не
     шесть подряд с утра.                                          */
  const pickTimes = (starts, density) => {
    const open = density > OPEN_DAY_DENSITY;
    const want = Math.min(open ? OPEN_DAY_TIMES : MAX_TIMES, starts.length);
    if (!want) return { times: [], open };
    const picked = [];
    for (let k = 0; k < want; k++) {
      const idx = want === 1 ? 0 : Math.round((k * (starts.length - 1)) / (want - 1));
      picked.push(starts[idx]);
    }
    return { times: [...new Set(picked)], open };
  };

  /* Скидку на окно подписываем прямо к времени. Без этого мастер
     вешает её в кабинете, а на картинке — обычное окно, и никто про
     скидку не узнаёт. */
  const groupTimes = (mins, off = {}) => {
    const g = { "Утро": [], "День": [], "Вечер": [] };
    for (const m of mins) {
      const t = hhmm(m);
      (m < 12 * 60 ? g["Утро"] : m < 17 * 60 ? g["День"] : g["Вечер"]).push({ t, off: +off[t] || 0 });
    }
    return Object.entries(g).filter(([, v]) => v.length).map(([label, times]) => ({ label, times }));
  };

  /* Кабинет может быть мастером или салоном. У салона своего графика
     нет — его окна складываются из окон мастеров, которые в нём
     работают. Поэтому всё ниже работает не с одним мастером, а со
     списком участников: у соло-мастера в списке он один.          */
  const loadEntity = async (entityId) => {
    const { data: rows } = await db.from("masters")
      .select("id, name, role, photo_url, salon_id, kind, rating").eq("id", entityId).limit(1);
    const entity = (rows || [])[0];
    if (!entity) return null;
    if (entity.kind !== "salon") return { entity, memberIds: [entity.id] };
    const { data: staff } = await db.from("masters")
      .select("id, works_until").eq("salon_id", entity.id).eq("is_active", true);
    const today = minskDateStr(0);
    const ids = (staff || [])
      .filter((m) => !m.works_until || m.works_until >= today)
      .map((m) => m.id);
    return { entity, memberIds: ids };
  };

  /* Шаг сетки: самая короткая активная услуга участника. Дырка в
     45 минут годится под маникюр и не годится под наращивание, а
     выбирать услугу руками на первом экране мы не просим.        */
  const gridDuration = (services) =>
    Math.max(30, Math.min(...(services.length ? services.map((s) => +s.duration_min || 60) : [60])));

  /* Расписание, записи и услуги всех участников — одним заходом. */
  const loadBundle = async (memberIds, fromIso, toIso) => {
    if (!memberIds.length) return { members: [], services: [] };
    const [{ data: week }, { data: ov }, { data: booked }, { data: svcs }] = await Promise.all([
      db.from("master_schedule").select("master_id, day_of_week, is_working, start_time, end_time").in("master_id", memberIds),
      db.from("master_schedule_dates").select("master_id, date, is_working, start_time, end_time").in("master_id", memberIds),
      db.from("bookings").select("master_id, booked_date, booked_time, duration_min")
        .in("master_id", memberIds).gte("booked_date", fromIso).lte("booked_date", toIso)
        .not("status", "in", "(cancelled,declined)"),
      db.from("services").select("master_id, name, price, duration_min").in("master_id", memberIds).eq("is_active", true),
    ]);
    const members = memberIds.map((id) => {
      const weekMap = {}; (week || []).filter((r) => r.master_id === id).forEach((r) => { weekMap[r.day_of_week] = r; });
      const ovMap   = {}; (ov   || []).filter((r) => r.master_id === id).forEach((r) => { ovMap[r.date] = r; });
      const busyBy  = {};
      (booked || []).filter((r) => r.master_id === id).forEach((b) => {
        (busyBy[b.booked_date] ||= []).push({ s: minutesOf(b.booked_time), e: minutesOf(b.booked_time) + (+b.duration_min || 60) });
      });
      const own = (svcs || []).filter((r) => r.master_id === id);
      return { id, weekMap, ovMap, busyBy, services: own, durMin: gridDuration(own) };
    });
    const services = (svcs || []).slice().sort((a, b) => (+a.price || 0) - (+b.price || 0));
    return { members, services };
  };

  /* Свободные начала на дату по всем участникам. Для салона это
     объединение: окно в 14:00 есть, если оно свободно хоть у кого-то.
     Ёмкость считаем суммой — по ней решаем, не пустой ли день.     */
  const freeOnDate = (members, iso, notBefore = null) => {
    const union = new Set();
    let capacity = 0, free = 0;
    for (const m of members) {
      const win = windowOn(m.weekMap, m.ovMap, iso);
      if (!win) continue;
      const r = freeStartsOn(win, m.busyBy[iso] || [], m.durMin, notBefore);
      capacity += r.capacity;
      free += r.times.length;
      r.times.forEach((t) => union.add(t));
    }
    return { starts: [...union].sort((a, b) => a - b), capacity, free, working: capacity > 0 };
  };

  const cardOf = async (entity) => ({
    name: String(entity.name || "").trim(),
    role: String(entity.role || "").trim(),
    link: `uspot.by/m/${toSlug(entity.name)}`,
    photoHref: await dataUri(entity.photo_url),
    logoHref: logo(),
  });

  const gridDurationOf = (members) =>
    members.length ? Math.min(...members.map((m) => m.durMin)) : 60;

  /* Окна считаются под длительность услуги: дырка в 45 минут годится
     под маникюр и не годится под наращивание. Без выбора берём самую
     короткую услугу — тогда окон больше всего, но часть из них под
     длинную процедуру не подойдёт, и это надо было как-то сказать.
     Теперь мастер может назвать услугу прямо, и сетка считается под
     неё, а мастера, которые её не делают, из расчёта выпадают. */
  const forService = (members, name) => {
    if (!name) return members;
    const fit = members
      .map((m) => {
        const svc = m.services.find((s) => s.name === name);
        return svc ? { ...m, durMin: Math.max(30, +svc.duration_min || 60) } : null;
      })
      .filter(Boolean);
    return fit.length ? fit : members;        // услугу убрали из прайса — считаем как раньше
  };

  const serviceLine = (services, name, durMin) => {
    const own = name ? services.filter((s) => s.name === name) : [];
    if (!own.length) return priceLineOf(services, durMin);
    const min = Math.min(...own.map((s) => +s.price || 0));
    return `${name} · ${durMin} мин` + (min > 0 ? ` · от ${min} руб` : "");
  };

  const priceLineOf = (services, durMin) => {
    if (!services.length) return `${durMin} минут`;
    const min = Math.min(...services.map((s) => +s.price || 0));
    return min > 0 ? `${durMin} минут · от ${min} руб` : `${durMin} минут`;
  };

  /* Какой день просят. Понимаем три записи: слова «today»/«tomorrow»,
     число дней вперёд и прямую дату «2026-11-02».

     Прямая дата появилась после случая, который описал Ilya: вечер
     пятницы, сегодня записывать уже поздно, суббота выходная — и
     сделать картинку на понедельник было нечем. «Сегодня, завтра,
     неделя» покрывают не все дни недели, а мастер планирует не по
     этим трём словам. */
  const DAY_HORIZON = 14;
  const dayOffsetOf = (scope) => {
    if (typeof scope === "number") return Math.max(0, Math.min(DAY_HORIZON, scope));
    const str = String(scope || "");
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
      for (let d = 0; d <= DAY_HORIZON; d++) if (minskDateStr(d) === str) return d;
      return null;                      // дата вне горизонта — не наше дело
    }
    return str === "today" ? 0 : 1;
  };

  /* ── Формат «Окошки» на выбранный день ─────────────────────── */
  const slotsStory = async (entityId, scope = "tomorrow", opts = {}) => {
    const e = await loadEntity(entityId);
    if (!e) return { error: "master_not_found" };
    if (!e.memberIds.length) return { error: "no_masters" };
    const dayOff = dayOffsetOf(scope);
    if (dayOff === null) return { error: "bad_date" };
    const iso = minskDateStr(dayOff);
    const all = await loadBundle(e.memberIds, iso, iso);
    const services = all.services;
    const members = forService(all.members, opts.service);
    const notBefore = dayOff === 0 ? minskMinutes() + BOOK_LEAD_MIN : null;
    const { starts, capacity, free, working } = freeOnDate(members, iso, notBefore);
    if (!working) return { error: "day_off" };
    if (!starts.length) return { error: "no_slots" };
    const { times, open } = pickTimes(starts, capacity > 0 ? free / capacity : 0);
    const dur = gridDurationOf(members);
    const off = typeof opts.findSlotDiscounts === "function"
      ? await opts.findSlotDiscounts(e.memberIds, iso) : {};

    return {
      format: "slots",
      data: {
        /* Заголовок — из набора фраз, а не одна строка навсегда:
           подписчики у мастера одни и те же, и неизменная подпись им
           приедается быстрее, чем кончаются клиенты. */
        title: opts.title || defaultTitle({ format: "slots", day: dayWordOf(iso, dayOff),
                                            free: starts.length, open }),
        dateLabel: dayOff <= 1
          ? `${dayOff === 0 ? "Сегодня" : "Завтра"}, ${ruWeekday(iso)} · ${ruDayMonth(iso)}`
          : `${ruWeekday(iso)} · ${ruDayMonth(iso)}`,
        priceLine: opts.showPrice === false ? "" : serviceLine(services, opts.service, dur),
        groups: groupTimes(times, off),
        master: await cardOf(e.entity),
      },
      /* times отдаём наружу: кабинет по ним предлагает повесить скидку
         ровно на те окна, которые попали на картинку. */
      meta: { date: iso, dayOffset: dayOff, free: starts.length, capacity, shown: times.length, open,
              times: times.map(hhmm), masters: members.length, service: opts.service || null },
    };
  };

  /* ── Формат «Окошки» на неделю ─────────────────────────────
     Семь дней по шесть времён в сторис не влезают физически,
     поэтому неделя показывает дни, а точное время — по ссылке. */
  const weekStory = async (entityId, opts = {}) => {
    const e = await loadEntity(entityId);
    if (!e) return { error: "master_not_found" };
    if (!e.memberIds.length) return { error: "no_masters" };
    const from = minskDateStr(0), to = minskDateStr(7);
    const allW = await loadBundle(e.memberIds, from, to);
    const services = allW.services;
    const members = forService(allW.members, opts.service);
    const nowMin = minskMinutes();
    const days = [];
    for (let d = 0; d <= 7 && days.length < 5; d++) {
      const iso = minskDateStr(d);
      const { starts, capacity, free } = freeOnDate(members, iso, d === 0 ? nowMin + BOOK_LEAD_MIN : null);
      if (!starts.length) continue;
      /* То же правило, что и на дневной сторис, только в масштабе
         недели: «17 окон» четыре дня подряд — это не предложение,
         а признание, что к мастеру не ходят. Пустой день говорит
         «есть окна», занятый наполовину — называет число.        */
      const open = capacity > 0 && free / capacity > OPEN_DAY_DENSITY;
      const span = starts.length > 1
        ? `с ${hhmm(starts[0])} до ${hhmm(starts[starts.length - 1])}`
        : `в ${hhmm(starts[0])}`;
      days.push({ label: `${ruWeekday(iso)}, ${ruDayMonth(iso)}`, count: starts.length, open, span });
    }
    if (!days.length) return { error: "no_slots" };
    return {
      format: "week",
      data: {
        title: opts.title || defaultTitle({ format: "week" }),
        dateLabel: "На ближайшую неделю",
        priceLine: opts.showPrice === false ? "" : serviceLine(services, opts.service, gridDurationOf(members)),
        days,
        master: await cardOf(e.entity),
      },
      meta: { days: days.length, masters: members.length },
    };
  };

  /* ── Формат «Горящее» ──────────────────────────────────────
     Ближайшее свободное окно сегодня плюс акция, если она на эту
     услугу есть: скидка и есть причина забрать окно сейчас.
     У салона цена идёт «от» — у разных мастеров она разная.     */
  /* scope — "today" или "tomorrow". Горящим бывает и завтрашнее окно:
     мастер узнаёт об отмене вечером, и продавать его надо тогда же, а
     не ждать утра. Раньше формат молча считал только сегодняшний день,
     и вечером после закрытия отвечал «окон нет» — хотя назавтра их
     полный день. */
  const hotStory = async (entityId, scope = "today", opts = {}) => {
    const e = await loadEntity(entityId);
    if (!e) return { error: "master_not_found" };
    if (!e.memberIds.length) return { error: "no_masters" };
    const dayOff = scope === "tomorrow" ? 1 : dayOffsetOf(scope === "today" ? "today" : scope);
    if (dayOff === null) return { error: "bad_date" };
    const todayHot = dayOff === 0;
    const iso = minskDateStr(dayOff);
    const { members, services } = await loadBundle(e.memberIds, iso, iso);
    /* Запас в час — правило сегодняшнего дня: на завтрашнее утро он
       ничего не отсекает, и применять его там незачем. */
    const { starts, working } = freeOnDate(members, iso, todayHot ? minskMinutes() + BOOK_LEAD_MIN : null);
    if (!working) return { error: "day_off" };
    if (!starts.length) return { error: "no_slots" };
    if (!services.length) return { error: "no_services" };

    const isSalon = e.entity.kind === "salon";
    const time = hhmm(starts[0]);

    /* Порядок поиска скидки: сначала акция на само окно — мастер
       повесил её именно на это время, чтобы его забрали; потом акция
       на услугу. Без скидки берём самую дорогую услугу: горящее окно
       продаёт верх прайса, а у салона цена всё равно пойдёт «от».  */
    let svc = null, promo = null;
    if (typeof opts.findSlotPromo === "function") {
      promo = await opts.findSlotPromo(e.entity, iso, time);
    }
    if (!promo && typeof opts.findPromo === "function") {
      const names = [...new Set(services.map((s) => s.name))];
      for (const name of names) {
        const p = await opts.findPromo(e.entity, name, iso);
        if (p) { promo = p; svc = services.filter((s) => s.name === name)
          .sort((a, b) => (+a.price || 0) - (+b.price || 0))[0]; break; }
      }
    }
    if (!svc) svc = opts.service
      ? services.find((s) => s.name === opts.service) || services[services.length - 1]
      : services[services.length - 1];

    const base = +svc.price || 0;
    const promoPrice = promo && typeof opts.promoPrice === "function" ? opts.promoPrice(base, promo) : null;
    const price = promoPrice != null ? promoPrice : base;

    return {
      format: "hot",
      data: {
        badge: "Горящее окно",
        title: opts.title || defaultTitle({ format: "hot", day: dayWordOf(iso, dayOff) }),
        when: `${dayOff === 0 ? "Сегодня" : dayOff === 1 ? "Завтра" : cap(ruWeekday(iso))}, ${ruDayMonth(iso)}`,
        time,
        service: svc.name,
        price, priceFrom: isSalon && promoPrice == null,
        oldPrice: promoPrice != null && promoPrice < base ? base : null,
        pct: promoPrice != null && base > 0 ? Math.round((1 - promoPrice / base) * 100) : 0,
        note: `Запись закроется за ${BOOK_LEAD_MIN === 60 ? "час" : BOOK_LEAD_MIN + " минут"} до начала`,
        master: await cardOf(e.entity),
      },
      meta: { date: iso, time, dayOffset: dayOff, scope: todayHot ? "today" : "tomorrow", promo: !!promo,
              slotPromo: !!(promo && promo.slot_date), masters: members.length },
    };
  };

  /* ── Формат «Отзыв» ───────────────────────────────────────
     Только одобренные модерацией и только с текстом. Имя берём то,
     что уже опубликовано в каталоге, и только первое слово: сторис
     уходит шире, чем карточка мастера.                          */
  const reviewStory = async (entityId, opts = {}) => {
    const e = await loadEntity(entityId);
    if (!e) return { error: "master_not_found" };
    const ids = e.memberIds.length ? e.memberIds : [entityId];
    const { data: rows } = await db.from("reviews")
      .select("id, master_id, rating, review_text, text, client_name, created_at, status")
      .in("master_id", ids).eq("status", "approved").order("created_at", { ascending: false }).limit(50);
    const all = rows || [];
    const withText = all.filter((r) => String(r.review_text || r.text || "").trim().length > 10);
    /* Какой отзыв показать — решает мастер, а не порядок в базе. Без
       выбора на картинку всегда уезжал самый свежий, и выглядело это
       как случайный: свежий не значит лучший. Не нашли по id (отзыв
       сняли с публикации, пока экран был открыт) — берём свежий, но
       молча не подменяем выбранный на соседний. */
    const pick = opts.reviewId
      ? withText.find((r) => String(r.id) === String(opts.reviewId))
      : opts.index != null ? withText[opts.index] : withText[0];
    if (!pick) return { error: opts.reviewId ? "review_gone" : "no_reviews" };
    const avg = all.length ? all.reduce((a, r) => a + (+r.rating || 0), 0) / all.length : (+e.entity.rating || 5);

    return {
      format: "review",
      data: {
        title: opts.title || defaultTitle({ format: "review" }),
        summary: `${avg.toFixed(1).replace(".", ",")} из 5 · ${all.length} ${plural(all.length, "отзыв", "отзыва", "отзывов")}`,
        rating: Math.round(+pick.rating || 5),
        text: String(pick.review_text || pick.text).trim().replace(/\s+/g, " ").slice(0, 400),
        author: String(pick.client_name || "Клиент").trim().split(/\s+/)[0],
        master: await cardOf(e.entity),
      },
      meta: { total: all.length, withText: withText.length, reviewId: pick.id },
    };
  };

  /* Отзывы, из которых есть что выбрать: одобренные и с текстом. Тем же
     фильтром, что и у сборки картинки, — иначе кабинет предложит отзыв,
     который картинкой не станет. */
  const pickableReviews = async (entityId) => {
    const e = await loadEntity(entityId);
    if (!e) return { error: "master_not_found" };
    const ids = e.memberIds.length ? e.memberIds : [entityId];
    const { data: rows } = await db.from("reviews")
      .select("id, master_id, rating, review_text, text, client_name, created_at")
      .in("master_id", ids).eq("status", "approved").order("created_at", { ascending: false }).limit(50);
    const names = {};
    if (e.entity.kind === "salon" && ids.length > 1) {
      const { data: ms } = await db.from("masters").select("id, name").in("id", ids);
      for (const m of ms || []) names[m.id] = m.name;
    }
    const list = (rows || [])
      .filter((r) => String(r.review_text || r.text || "").trim().length > 10)
      .map((r) => ({
        id: r.id,
        rating: Math.round(+r.rating || 5),
        text: String(r.review_text || r.text).trim().replace(/\s+/g, " ").slice(0, 400),
        author: String(r.client_name || "Клиент").trim().split(/\s+/)[0],
        date: r.created_at ? String(r.created_at).slice(0, 10) : null,
        master: names[r.master_id] || null,
      }));
    return { reviews: list };
  };

  /* Карточка без привязки ко дню — запасной вариант для публичной
     страницы мастера. Нужна, когда окон нет ни сегодня, ни завтра:
     ссылка висит в шапке профиля неделями, и выходной у мастера не
     повод показать пустой прямоугольник. */
  const loadPublicCard = async (entityId) => {
    const e = await loadEntity(entityId);
    if (!e) return null;
    const today = minskDateStr(0);
    const all = e.memberIds.length ? await loadBundle(e.memberIds, today, today) : { services: [] };
    const card = await cardOf(e.entity);
    return { ...card, meta: priceLineOf(all.services, 60) };
  };

  /* Ближайшие дни со свободным временем. Кабинет рисует по этому
     списку выбор дня: мастер сразу видит, где окна есть, и не тычется
     в выходные наугад. Нерабочие дни и забитые просто не попадают. */
  const freeDays = async (entityId, opts = {}) => {
    const e = await loadEntity(entityId);
    if (!e) return { error: "master_not_found" };
    if (!e.memberIds.length) return { error: "no_masters" };
    const from = minskDateStr(0), to = minskDateStr(DAY_HORIZON);
    const all = await loadBundle(e.memberIds, from, to);
    const members = forService(all.members, opts.service);
    const nowMin = minskMinutes();
    const days = [];
    for (let d = 0; d <= DAY_HORIZON; d++) {
      const iso = minskDateStr(d);
      const { starts, working } = freeOnDate(members, iso, d === 0 ? nowMin + BOOK_LEAD_MIN : null);
      if (!working || !starts.length) continue;
      days.push({ date: iso, offset: d, free: starts.length,
                  weekday: ruWeekday(iso), dayMonth: ruDayMonth(iso) });
    }
    return { days };
  };

  /* Что предложить мастеру в качестве заголовка. Обстановку считаем
     сами: по числу окон того дня, который он выбрал. */
  const titleOptions = async (entityId, { format = "slots", scope, service } = {}) => {
    if (format === "review" || format === "week") return { titles: suggestTitles({ format }) };
    const dayOff = dayOffsetOf(scope);
    if (dayOff === null) return { titles: suggestTitles({ format }) };
    const iso = minskDateStr(dayOff);
    const e = await loadEntity(entityId);
    if (!e || !e.memberIds.length) return { error: "master_not_found" };
    const all = await loadBundle(e.memberIds, iso, iso);
    const members = forService(all.members, service);
    const { starts, capacity } = freeOnDate(members, iso,
      dayOff === 0 ? minskMinutes() + BOOK_LEAD_MIN : null);
    const open = capacity > 0 && starts.length / capacity > OPEN_DAY_DENSITY;
    return { titles: suggestTitles({ format, day: dayWordOf(iso, dayOff),
                                     free: starts.length, open }) };
  };

  return { slotsStory, weekStory, hotStory, reviewStory, pickableReviews, loadPublicCard,
           freeDays, titleOptions, toSlug, minskDateStr };
};
