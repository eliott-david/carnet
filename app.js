"use strict";
/* Coach Claude — suivi de séances, hors ligne.
   Les données restent dans IndexedDB sous le nom d'origine "carnet", pour ne rien perdre. */

/* ---------- Stockage ---------- */
const DB = (() => {
  let p;
  const open = () => p || (p = new Promise((res, rej) => {
    const r = indexedDB.open("carnet", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction("kv", mode); const r = fn(t.objectStore("kv"));
      t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error);
    });
  };
  return {
    get: k => tx("readonly", s => s.get(k)),
    set: (k, v) => tx("readwrite", s => s.put(v, k)),
    del: k => tx("readwrite", s => s.delete(k)),
    keys: () => tx("readonly", s => s.getAllKeys()),
  };
})();

const S = { exercises: [], sessions: [], models: [], draft: null, settings: { shortcut: false } };
const save = k => DB.set(k, S[k]).catch(e => toast("Sauvegarde impossible : " + e.message));
const photos = {}; // id -> dataURL
const SHORTCUT = "Minuteur Coach";
const APP_VERSION = "2.0.4";
let pendingReload = false; // nouvelle version prête, rechargement à la fermeture de la fenêtre ouverte

/* ---------- Icônes ---------- */
const ic = (d, cls = "") => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const I = {
  plus: ic('<path d="M12 5v14M5 12h14"/>'),
  check: ic('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  more: ic('<circle cx="5.5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="18.5" cy="12" r="1.7"/>', "fill"),
  pencil: ic('<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>'),
  x: ic('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
  timer: ic('<circle cx="12" cy="13.5" r="7.5"/><path d="M12 13.5V10M9.5 3h5M18.5 6.5l1.2-1.2"/>'),
  chev: ic('<path d="M9.5 5.5L16 12l-6.5 6.5"/>', "chev"),
  play: ic('<path d="M8 5.8v12.4a.8.8 0 0 0 1.2.7l10-6.2a.8.8 0 0 0 0-1.4l-10-6.2A.8.8 0 0 0 8 5.8z"/>', "fill"),
  search: ic('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>'),
  chevDown: ic('<path d="M6 9.5l6 6 6-6"/>', "chev-down"),
  sparkle: ic('<path d="M12 3l2 5.6 5.6 2-5.6 2L12 18.2l-2-5.6-5.6-2 5.6-2z"/>', "fill"),
  dumbbell: ic('<path d="M7 7v10M17 7v10M4 9.5v5M20 9.5v5M7 12h10"/>'),
};

/* ---------- Outils ---------- */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const fmtDate = d => new Date(d + "T12:00").toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" });
const fmtLong = d => new Date(d + "T12:00").toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
const fmtTime = s => Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
const plural = (n, w) => `${n} ${w}${n > 1 ? "s" : ""}`;
const BANDS = ["Aucun", "Léger", "Moyen", "Fort", "Très fort"];
/* Types de séance proposés (les types créés par l'utilisateur s'ajoutent avant « Autre ») */
const TYPES = [["Push", "#ff9500"], ["Pull", "#0a84ff"], ["Jambes", "#34c759"], ["Haut du corps", "#5e5ce6"], ["Full-body", "#ff2d55"], ["Skills", "#af52de"], ["Gainage / abdos", "#30b0c7"], ["Mobilité / étirements", "#00c7be"]];
const typeColor = t => (TYPES.find(x => x[0] === t) || [null, "#8e8e93"])[1];
const allTypes = () => [...TYPES.map(t => t[0]), ...(S.settings.types || []), "Autre"];
const tag = t => t ? `<span class="tag" style="--c:${typeColor(t)}">${esc(t)}</span>` : "";
const num =v => (v === "" || v == null) ? 0 : +String(v).replace(",", ".") || 0;
let toastT;
function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 2400); }
const exById = id => S.exercises.find(e => e.id === id);
const meta = e => (e.mode === "time" ? "Durée" : "Répétitions") + (e.kg ? " · charge" : "") + (e.band ? " · élastique" : "");
function thumb(lib, mode, zoom) {
  const ph = lib && lib.photo && photos[lib.photo];
  if (ph) return `<img class="thumb" src="${ph}" alt=""${zoom ? ` data-act="photo" data-id="${lib.photo}"` : ""}>`;
  return `<span class="thumb ph">${mode === "time" ? I.timer : I.dumbbell}</span>`;
}

/* Valeur principale d'une série : reps ou secondes */
const val = (set, ex) => num(ex.mode === "time" ? set.sec : set.reps);
const fmtSet = (set, ex) => {
  const v = ex.mode === "time" ? (set.sec ? set.sec + " s" : "?") : (set.reps || "?");
  return v + (ex.kg && num(set.kg) ? " × " + set.kg + " kg" : "") + (ex.band && set.band && set.band !== "Aucun" ? " (" + set.band.toLowerCase() + ")" : "");
};
/* Score comparable : moins d'élastique > plus de charge > plus de reps/secondes */
const score = (set, ex) => [-(ex.band ? Math.max(0, BANDS.indexOf(set.band || "Aucun")) : 0), ex.kg ? num(set.kg) : 0, val(set, ex)];
const cmp = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
function bestSet(ex) {
  let best = null;
  for (const s of ex.sets) if (val(s, ex) > 0 && (!best || cmp(score(s, ex), score(best, ex)) > 0)) best = s;
  return best;
}
const total = ex => ex.sets.reduce((a, s) => a + val(s, ex), 0);
const sortSessions = () => S.sessions.sort((a, b) => (b.date + String(b.createdAt).padStart(15, "0")).localeCompare(a.date + String(a.createdAt).padStart(15, "0")));
const keyOf = ex => ex.exId || ex.name.trim().toLowerCase();
const before = s => S.sessions.filter(o => o.id !== s.id && (o.date < s.date || (o.date === s.date && o.createdAt < s.createdAt)));
function lastOccurrence(key, list) {
  for (const s of list) { const e = s.exos.find(x => keyOf(x) === key); if (e) return { s, e }; }
  return null;
}

/* ---------- Commentaires automatiques ----------
   Un futur commentaire IA pourra compléter ou remplacer buildComments(). */
function buildComments(s) {
  const prior = before(s), out = [];
  for (const ex of s.exos) {
    const best = bestSet(ex); if (!best) continue;
    const key = keyOf(ex), last = lastOccurrence(key, prior);
    if (!last) { out.push({ t: `${ex.name} : première fois, référence posée à ${fmtSet(best, ex)}.` }); continue; }
    let allBest = null;
    for (const p of prior) for (const e of p.exos) if (keyOf(e) === key) { const b = bestSet(e); if (b && (!allBest || cmp(score(b, e), score(allBest, e)) > 0)) allBest = b; }
    const lastBest = bestSet(last.e);
    if (allBest && cmp(score(best, ex), score(allBest, ex)) > 0) out.push({ rec: true, t: `Record sur ${ex.name} : ${fmtSet(best, ex)} (avant : ${fmtSet(allBest, ex)}).` });
    else if (lastBest && cmp(score(best, ex), score(lastBest, ex)) > 0) out.push({ t: `${ex.name} : mieux que la dernière fois (${fmtSet(best, ex)} contre ${fmtSet(lastBest, ex)}).` });
    else if (total(ex) > total(last.e)) out.push({ t: `${ex.name} : plus de volume que la dernière fois (${total(ex)}${ex.mode === "time" ? " s" : " reps"} contre ${total(last.e)}).` });
    else if (lastBest && cmp(score(best, ex), score(lastBest, ex)) < 0) out.push({ t: `${ex.name} : un peu en dessous de la dernière fois (${fmtSet(best, ex)} contre ${fmtSet(lastBest, ex)}). La fatigue joue, rien d'inquiétant sur une séance.` });
    else out.push({ t: `${ex.name} : même niveau que la dernière fois, c'est stable.` });
  }
  const d = new Date(s.date + "T12:00");
  const inWeek = o => { const k = (d - new Date(o.date + "T12:00")) / 864e5; return o.id !== s.id && k >= 0 && k < 7; };
  const week = S.sessions.filter(inWeek).length + 1;
  const weekType = s.type ? S.sessions.filter(o => inWeek(o) && o.type === s.type).length + 1 : 0;
  if (prior[0]) {
    const gap = Math.round((d - new Date(prior[0].date + "T12:00")) / 864e5);
    if (gap >= 8) out.push({ t: `Reprise après ${gap} jours sans séance enregistrée. Bien joué d'être revenu.` });
    else if (weekType >= 2) out.push({ t: `${weekType}e séance ${s.type} sur les 7 derniers jours.` });
    else if (week >= 2) out.push({ t: `${week}e séance sur les 7 derniers jours.` });
  }
  const rpes = s.exos.flatMap(e => e.sets.map(x => num(x.rpe))).filter(Boolean);
  if (rpes.length) {
    const avg = rpes.reduce((a, b) => a + b, 0) / rpes.length;
    if (avg >= 8.5) out.push({ t: `Séance très intense (ressenti moyen ${avg.toFixed(1)}/10). Pense à bien récupérer avant la prochaine.` });
    else if (avg <= 5) out.push({ t: `Ressenti moyen ${avg.toFixed(1)}/10 : tu as de la marge pour augmenter la difficulté.` });
  }
  if (!out.length) out.push({ t: "Séance enregistrée. Remplis tes séries pour avoir des comparaisons la prochaine fois." });
  return out;
}

/* ---------- Brouillon de séance ---------- */
const newDraft = () => ({ id: null, name: "", type: "", date: today(), note: "", exos: [] });
const blankSet = (rest, ph = {}) => ({ reps: "", sec: "", kg: "", band: "", rest, rpe: "", note: "", done: false, ph });
function draftExo(ex, template) {
  const last = lastOccurrence(ex.id, S.sessions);
  const ref = template || (last && last.e.sets) || [{}];
  return {
    exId: ex.id, name: ex.name, mode: ex.mode, band: ex.band, kg: ex.kg, note: "",
    sets: ref.map(r => blankSet(r.rest || ex.rest || 90, { reps: r.reps || "", sec: r.sec || "", kg: r.kg || "", band: r.band || "" })),
  };
}
const saveDraft = () => save("draft");

/* ---------- Composants : feuille et menu de confirmation ---------- */
function openSheet(html) { $("modal-box").innerHTML = html; $("modal").hidden = false; $("modal-box").scrollTop = 0; syncLock(); }
function closeSheet() { $("modal").hidden = true; $("modal-box").innerHTML = ""; syncLock(); if (pendingReload) location.reload(); }
$("modal").addEventListener("click", e => { if (e.target === $("modal")) closeSheet(); });

function ask({ title, message, actions, cancel = "Annuler" }) {
  return new Promise(res => {
    const d = $("dialog");
    d.innerHTML = `<div class="as" role="alertdialog" aria-modal="true">
      <div class="as-group">
        ${title || message ? `<div class="as-head">${title ? `<p class="as-title">${esc(title)}</p>` : ""}${message ? `<p class="as-msg">${esc(message)}</p>` : ""}</div>` : ""}
        ${actions.map((a, k) => `<button class="as-btn ${a.destructive ? "danger" : ""}" data-k="${k}">${esc(a.label)}</button>`).join("")}
      </div>
      <button class="as-btn as-cancel" data-k="-1">${esc(cancel)}</button></div>`;
    d.hidden = false; syncLock();
    const done = v => { d.hidden = true; d.innerHTML = ""; d.onclick = null; syncLock(); res(v); };
    d.onclick = e => {
      const b = e.target.closest("[data-k]");
      if (b) { const k = +b.dataset.k; done(k < 0 ? null : actions[k].value); }
      else if (e.target === d) done(null);
    };
  });
}

/* ---------- Titres ---------- */
const TITLES = { seance: "Séance", hist: "Historique", prog: "Progrès", exos: "Exercices" };
function largeTitle(tab, side = "") {
  const n = S.sessions.length, e = S.exercises.length;
  const eyebrow = {
    seance: S.draft.id ? "Modification" : fmtLong(today()),
    hist: n ? plural(n, "séance") : "Aucune séance",
    prog: "Tes records",
    exos: e ? plural(e, "exercice") : "Ta bibliothèque",
  }[tab];
  return `<header class="lt"><p class="eyebrow">${esc(eyebrow)}</p><div class="lt-row"><h1>${TITLES[tab]}</h1>${side}</div></header>`;
}

/* ---------- Rendu : Séance ---------- */
function renderSeance() {
  const d = S.draft, v = $("v-seance");
  const orig = d.id && S.sessions.find(s => s.id === d.id);
  const editing = d.id ? `<div class="banner"><div><b>Modification en cours</b><span>Séance du ${fmtDate(orig?.date || d.date)}</span></div><button class="btn-text" data-act="cancel-edit">Annuler</button></div>` : "";
  // Modèles : ceux du type choisi d'abord
  const ms = [...S.models].sort((a, b) => (b.type === d.type && !!d.type) - (a.type === d.type && !!d.type));
  const models = !d.exos.length && ms.length ? `<h2 class="sh">Démarrer depuis un modèle</h2>
    <div class="group">${ms.map(m => `<button class="row row-btn" data-act="use-model" data-id="${m.id}">
      <span class="row-main"><span class="row-title">${esc(m.name)}</span><span class="row-sub">${esc(m.exos.map(e => e.name).join(", "))}</span></span>${tag(m.type)}${I.chev}</button>`).join("")}</div>` : "";
  v.innerHTML = `${largeTitle("seance")}
    ${editing}
    <div class="group">
      <label class="row"><span class="row-label">Nom</span><input class="row-input" id="d-name" placeholder="Séance du soir…" value="${esc(d.name)}" autocomplete="off"></label>
      <button class="row row-btn" data-act="type-open"><span class="row-label">Type</span><span class="row-value">${d.type ? tag(d.type) : "Choisir"}</span>${I.chev}</button>
      <label class="row"><span class="row-label">Date</span><input class="row-input" id="d-date" type="date" value="${esc(d.date)}"></label>
      <div class="row"><textarea class="row-area" id="d-note" rows="2" placeholder="Commentaire sur la séance (forme, sommeil…)">${esc(d.note)}</textarea></div>
    </div>
    ${models}
    ${d.exos.map(renderExo).join("")}
    <button class="btn btn-tinted" data-act="pick-ex">${I.plus}Ajouter un exercice</button>
    ${d.exos.length ? `<button class="btn btn-primary" data-act="save">${d.id ? "Mettre à jour la séance" : "Enregistrer la séance"}</button>
      <div class="text-actions"><button class="btn-text" data-act="save-model">Enregistrer comme modèle</button><button class="btn-text danger" data-act="clear">Vider la séance</button></div>`
      : `<p class="empty">Ajoute un premier exercice pour commencer. Les exercices que tu crées restent dans l'onglet Exercices.</p>`}`;
}

function renderExo(x, i) {
  const lib = exById(x.exId) || x;
  const last = lastOccurrence(keyOf(x), S.sessions.filter(s => s.id !== S.draft.id));
  const cols = ["34px", "1fr"]; if (x.kg) cols.push("1fr"); if (x.band) cols.push("1.3fr"); cols.push("1fr", "28px");
  const head = `<span></span><span class="h">${x.mode === "time" ? "Sec" : "Reps"}</span>${x.kg ? '<span class="h">Kg</span>' : ""}${x.band ? '<span class="h">Élastique</span>' : ""}<span class="h">Récup</span><span></span>`;
  const rows = x.sets.map((s, j) => {
    const at = `data-i="${i}" data-j="${j}"`, f = x.mode === "time" ? "sec" : "reps";
    return `<button class="set-num ${s.done ? "on" : ""}" data-act="done" ${at} aria-label="${s.done ? "Annuler la validation" : "Valider"} de la série ${j + 1}">${s.done ? I.check : j + 1}</button>
      <input class="cell" inputmode="numeric" data-f="${f}" ${at} value="${esc(s[f])}" placeholder="${esc(s.ph?.[f])}" aria-label="${x.mode === "time" ? "Secondes" : "Répétitions"}, série ${j + 1}">
      ${x.kg ? `<input class="cell" inputmode="decimal" data-f="kg" ${at} value="${esc(s.kg)}" placeholder="${esc(s.ph?.kg || "0")}" aria-label="Charge en kg, série ${j + 1}">` : ""}
      ${x.band ? `<select class="cell" data-f="band" ${at} aria-label="Élastique, série ${j + 1}"><option value="">${esc(s.ph?.band || "—")}</option>${BANDS.map(b => `<option ${s.band === b ? "selected" : ""}>${b}</option>`).join("")}</select>` : ""}
      <input class="cell" inputmode="numeric" data-f="rest" ${at} value="${esc(s.rest)}" aria-label="Récup en secondes, série ${j + 1}">
      <button class="set-more ${s.open ? "open" : ""} ${s.note || s.rpe ? "has" : ""}" data-act="more" ${at} aria-label="Options de la série ${j + 1}" aria-expanded="${!!s.open}">${I.more}</button>
      ${s.open ? `<div class="set-extra">
        <select class="cell" data-f="rpe" ${at} aria-label="Ressenti sur 10"><option value="">Ressenti</option>${[5, 6, 7, 8, 9, 10].map(n => `<option value="${n}" ${+s.rpe === n ? "selected" : ""}>${n}/10</option>`).join("")}</select>
        <input class="cell note-cell" data-f="note" ${at} value="${esc(s.note)}" placeholder="Note sur la série">
        <button class="set-del" data-act="del-set" ${at} aria-label="Supprimer la série ${j + 1}">${I.x}</button></div>` : ""}`;
  }).join("");
  return `<article class="card">
    <div class="ex-head">
      ${thumb(lib, x.mode, true)}
      <div class="ex-title"><h3>${esc(x.name)}</h3><p>${meta(x)}</p></div>
      <button class="icon-btn" data-act="ex-menu" data-i="${i}" aria-label="Options de l'exercice">${I.more}</button>
    </div>
    ${lib.notes ? `<p class="hint">${esc(lib.notes)}</p>` : ""}
    ${last ? `<p class="last"><span>Dernière fois · ${fmtDate(last.s.date)}</span>${esc(last.e.sets.map(s => fmtSet(s, last.e)).join("  ·  "))}</p>` : ""}
    <div class="sets" style="grid-template-columns:${cols.join(" ")}">${head}${rows}</div>
    <input class="ex-note" data-xnote="${i}" value="${esc(x.note)}" placeholder="Ajouter un commentaire sur l'exercice">
    <div class="ex-actions">
      <button class="btn-text" data-act="add-set" data-i="${i}">${I.plus}Série</button>
      ${x.mode === "time" ? `<button class="btn-text" data-act="hold" data-i="${i}">${I.play}Chrono de série</button>` : ""}
      <button class="btn-text" data-act="rest" data-i="${i}">${I.timer}Récup</button>
    </div>
  </article>`;
}

/* ---------- Rendu : Historique ---------- */
let HIST_FILTER = "";
function renderHist() {
  const used = [...new Set(S.sessions.map(s => s.type).filter(Boolean))];
  const order = allTypes(); used.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  if (HIST_FILTER && !used.includes(HIST_FILTER)) HIST_FILTER = "";
  const list = HIST_FILTER ? S.sessions.filter(s => s.type === HIST_FILTER) : S.sessions;
  const filters = used.length ? `<div class="filters" role="group" aria-label="Filtrer par type">
    <button class="chip ${HIST_FILTER ? "" : "on"}" data-act="hist-filter" data-v="">Toutes</button>
    ${used.map(t => `<button class="chip ${HIST_FILTER === t ? "on" : ""}" data-act="hist-filter" data-v="${esc(t)}">${esc(t)}</button>`).join("")}</div>` : "";
  const shut = new Set(S.settings.collapsed || []);
  const allShut = list.length > 0 && list.every(s => shut.has(s.id));
  const side = list.length ? `<button class="btn-text" data-act="sess-all">${allShut ? "Tout afficher" : "Tout réduire"}</button>` : "";
  $("v-hist").innerHTML = largeTitle("hist", side) + filters + (list.length ? list.map(s => shut.has(s.id) ? `<article class="card sess-card collapsed">
    <div class="sess-head"><button class="sess-toggle" data-act="sess-toggle" data-id="${s.id}" aria-expanded="false" aria-label="Afficher le détail de ${esc(s.name)}">
      <span class="sess-titles"><span class="eyebrow">${fmtLong(s.date)}</span><span class="sess-name">${esc(s.name)}</span></span>${I.chevDown}</button></div>
  </article>` : `<article class="card sess-card">
    <div class="sess-head"><button class="sess-toggle" data-act="sess-toggle" data-id="${s.id}" aria-expanded="true" aria-label="Réduire ${esc(s.name)}">
      <span class="sess-titles"><span class="eyebrow">${fmtLong(s.date)}</span><span class="sess-name">${esc(s.name)}</span>${s.type ? `<span class="tag-line">${tag(s.type)}</span>` : ""}</span>${I.chevDown}</button>
      <button class="icon-btn lg" data-act="edit" data-id="${s.id}" aria-label="Modifier la séance">${I.pencil}</button></div>
    ${s.note ? `<p class="hint">${esc(s.note)}</p>` : ""}
    <div class="sess-list">${s.exos.map(e => `<div class="sess-ex">
      <div class="sess-line"><span>${esc(e.name)}</span><span class="num">${esc(e.sets.map(x => fmtSet(x, e)).join(" · "))}</span></div>
      ${e.note ? `<span class="sub-note">${esc(e.note)}</span>` : ""}
      ${e.sets.map((x, k) => x.note ? `<span class="sub-note">Série ${k + 1} : ${esc(x.note)}</span>` : "").join("")}</div>`).join("")}</div>
    ${s.comments?.length ? `<div class="insights"><p class="insights-title">${I.sparkle}Analyse</p><ul>${s.comments.map(c => `<li class="${c.rec ? "rec" : ""}">${esc(c.t)}</li>`).join("")}</ul></div>` : ""}
    <div class="text-actions"><button class="btn-text" data-act="redo" data-id="${s.id}">Refaire cette séance</button><button class="btn-text danger" data-act="del-session" data-id="${s.id}">Supprimer</button></div>
  </article>`).join("") : `<p class="empty">Tes séances enregistrées apparaîtront ici, avec leur analyse.</p>`);
}

/* ---------- Rendu : Progrès ---------- */
function renderProg() {
  const map = new Map();
  [...S.sessions].reverse().forEach(s => s.exos.forEach(e => {
    const b = bestSet(e); if (!b) return;
    const k = keyOf(e); if (!map.has(k)) map.set(k, { ex: e, pts: [] });
    map.get(k).pts.push({ date: s.date, best: b, ex: e });
  }));
  if (!map.size) { $("v-prog").innerHTML = largeTitle("prog") + `<p class="empty">Tes records et l'évolution de chaque exercice s'afficheront ici après quelques séances.</p>`; return; }
  $("v-prog").innerHTML = largeTitle("prog") + [...map.entries()].map(([key, { ex, pts }]) => {
    const rec = pts.reduce((a, p) => cmp(score(p.best, p.ex), score(a.best, a.ex)) > 0 ? p : a);
    const lastP = pts[pts.length - 1], isRec = rec === lastP && pts.length > 1;
    const name = (exById(ex.exId) || ex).name;
    const hasKg = pts.some(p => p.ex.kg && p.ex.sets.some(s => num(s.kg) > 0));
    const modes = [["best", "Meilleure série"], ["vol", "Volume"]]; if (hasKg) modes.push(["kg", "Charge"]);
    const mode = modes.some(m => m[0] === CH_MODE[key]) ? CH_MODE[key] : "best";
    return `<article class="card">
      <div class="metric-head"><h3>${esc(name)}</h3>${isRec ? `<span class="badge">Nouveau record</span>` : `<span class="muted">${plural(pts.length, "séance")}</span>`}</div>
      <div class="metric-row">
        <div><p class="label">Record</p><p class="value rec">${esc(fmtSet(rec.best, rec.ex))}</p><p class="muted">${fmtDate(rec.date)}</p></div>
        <div><p class="label">Dernière fois</p><p class="value">${esc(fmtSet(lastP.best, lastP.ex))}</p><p class="muted">${fmtDate(lastP.date)}</p></div>
      </div>
      ${pts.length > 1 ? `<div class="seg seg-sm" style="grid-template-columns:repeat(${modes.length},1fr)">${modes.map(([m, l]) => `<button data-act="chart-mode" data-key="${esc(key)}" data-m="${m}" aria-pressed="${m === mode}">${l}</button>`).join("")}</div>` : ""}
      ${chart(key, pts, ex, mode, rec)}
    </article>`;
  }).join("");
}

/* ---------- Courbes ---------- */
const CH_MODE = {};   // vue choisie par exercice
const CH_DATA = {};   // points tracés, pour l'affichage au toucher
function niceTicks(lo, hi, integer) {
  if (hi === lo) { hi = hi + Math.max(1, Math.abs(hi) * .2); lo = Math.max(0, lo - Math.max(1, Math.abs(lo) * .2)); }
  const raw = (hi - lo) / 3, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
  let step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  if (integer) step = Math.max(1, Math.round(step));
  const start = Math.floor(lo / step) * step, end = Math.ceil(hi / step) * step, out = [];
  for (let v = start; v <= end + step / 2; v += step) out.push(+v.toFixed(6));
  return out;
}
function chart(key, pts, ex, mode, rec) {
  if (pts.length < 2) return `<p class="muted">La courbe apparaîtra dès ta 2e séance avec cet exercice.</p>`;
  const u = ex.mode === "time" ? "s" : "reps";
  const series = pts.map(p => {
    if (mode === "vol") { const t = total(p.ex); return { date: p.date, v: t, label: `${t} ${u} au total` }; }
    if (mode === "kg") { const k = Math.max(0, ...p.ex.sets.filter(s => val(s, p.ex) > 0).map(s => num(s.kg))); return { date: p.date, v: k, label: k ? `${k} kg` : "Sans charge" }; }
    return { date: p.date, v: val(p.best, p.ex), label: fmtSet(p.best, p.ex) };
  });
  const vals = series.map(s => s.v), ticks = niceTicks(Math.min(...vals), Math.max(...vals), mode !== "kg");
  const lo = ticks[0], hi = ticks[ticks.length - 1];
  const W = 320, H = 168, L = 6, R = 34, T = 40, B = 24, n = series.length;
  const xs = series.map((_, i) => L + 6 + i * (W - L - R - 12) / (n - 1));
  const ys = series.map(s => T + (hi - s.v) / (hi - lo || 1) * (H - T - B));
  const top = mode === "best" ? pts.indexOf(rec) : vals.indexOf(Math.max(...vals));
  const line = xs.map((x, i) => `${x.toFixed(1)},${ys[i].toFixed(1)}`).join(" ");
  const fmtTick = v => Number.isInteger(v) ? v : v.toFixed(1).replace(".", ",");
  const short = d => new Date(d + "T12:00").toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
  const dateIdx = [...new Set([0, Math.round((n - 1) / 2), n - 1])];
  CH_DATA[key] = { series, xs, ys, W };
  const unitName = { best: ex.mode === "time" ? "secondes" : "répétitions", vol: ex.mode === "time" ? "secondes au total" : "répétitions au total", kg: "kg" }[mode];
  const caption = {
    best: `Meilleure série de chaque séance${ex.band ? ". Le niveau d'élastique compte aussi dans le record" : ""}.`,
    vol: `Total des ${ex.mode === "time" ? "secondes" : "répétitions"} de chaque séance.`,
    kg: "Charge la plus lourde utilisée à chaque séance.",
  }[mode];
  return `<div class="chart" data-key="${esc(key)}">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(caption)} Dernière valeur : ${esc(series[n - 1].label)}.">
      <defs><linearGradient id="g-${esc(key).replace(/\W/g, "")}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".22"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
      ${ticks.map(t => { const y = T + (hi - t) / (hi - lo || 1) * (H - T - B); return `<line class="grid" x1="${L}" x2="${W - R + 4}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/><text class="axis" x="${W - R + 8}" y="${(y + 3.5).toFixed(1)}">${fmtTick(t)}</text>`; }).join("")}
      ${dateIdx.map(i => `<text class="axis" x="${xs[i].toFixed(1)}" y="${H - 6}" text-anchor="${i === 0 ? "start" : i === n - 1 ? "end" : "middle"}">${short(series[i].date)}</text>`).join("")}
      <polygon points="${xs[0].toFixed(1)},${H - B} ${line} ${xs[n - 1].toFixed(1)},${H - B}" fill="url(#g-${esc(key).replace(/\W/g, "")})"/>
      <polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
      ${xs.map((x, i) => `<circle cx="${x.toFixed(1)}" cy="${ys[i].toFixed(1)}" r="${i === n - 1 || i === top ? 4.5 : 3}" fill="${i === top ? "var(--orange)" : "var(--accent)"}" stroke="var(--card)" stroke-width="2"/>`).join("")}
      <line class="chart-cursor" x1="0" x2="0" y1="${T - 6}" y2="${H - B}"/>
      <circle class="chart-sel" cx="0" cy="0" r="6"/>
    </svg>
    <div class="chart-tip" hidden></div>
  </div>
  <p class="muted chart-cap">${caption} Touche la courbe pour voir le détail.</p>`;
}
function chartPick(el, clientX) {
  const d = CH_DATA[el.dataset.key]; if (!d) return;
  const r = el.querySelector("svg").getBoundingClientRect(), vx = (clientX - r.left) / r.width * d.W;
  let k = 0; d.xs.forEach((x, i) => { if (Math.abs(x - vx) < Math.abs(d.xs[k] - vx)) k = i; });
  const cur = el.querySelector(".chart-cursor"), sel = el.querySelector(".chart-sel"), tip = el.querySelector(".chart-tip");
  cur.setAttribute("x1", d.xs[k]); cur.setAttribute("x2", d.xs[k]); sel.setAttribute("cx", d.xs[k]); sel.setAttribute("cy", d.ys[k]);
  el.classList.add("picked");
  tip.innerHTML = `<b>${esc(d.series[k].label)}</b><span>${esc(fmtLong(d.series[k].date))}</span>`;
  tip.hidden = false;
  const w = el.clientWidth, half = tip.offsetWidth / 2, x = d.xs[k] / d.W * w;
  tip.style.left = `${Math.min(w - half, Math.max(half, x)).toFixed(1)}px`;
}
function chartClear(el) { el.classList.remove("picked"); el.querySelector(".chart-tip").hidden = true; }
document.addEventListener("pointerdown", e => {
  const el = e.target.closest(".chart");
  document.querySelectorAll(".chart.picked").forEach(c => c !== el && chartClear(c));
  if (el) chartPick(el, e.clientX);
});
document.addEventListener("pointermove", e => {
  const el = e.target.closest(".chart");
  if (el && (e.pointerType === "mouse" || e.buttons || e.pointerType === "touch")) chartPick(el, e.clientX);
});

/* ---------- Rendu : Exercices, modèles, réglages ---------- */
function renderExos() {
  const list = [...S.exercises].sort((a, b) => a.name.localeCompare(b.name, "fr"));
  $("v-exos").innerHTML = largeTitle("exos", `<button class="icon-btn lg" data-act="new-ex" aria-label="Nouvel exercice">${I.plus}</button>`) + `
    ${list.length ? `<div class="group thumbs">${list.map(e => `<button class="row row-btn" data-act="edit-ex" data-id="${e.id}">
        ${thumb(e, e.mode, false)}<span class="row-main"><span class="row-title">${esc(e.name)}</span><span class="row-sub">${meta(e)} · récup ${e.rest} s</span></span>${I.chev}</button>`).join("")}</div>`
      : `<div class="group"><button class="row row-btn" data-act="new-ex"><span class="row-title accent">Créer un premier exercice</span></button></div>`}

    <h2 class="sh">Modèles de séance</h2>
    ${S.models.length ? `<div class="group">${S.models.map(m => `<button class="row row-btn" data-act="model-menu" data-id="${m.id}">
        <span class="row-main"><span class="row-title">${esc(m.name)}</span><span class="row-sub">${plural(m.exos.length, "exercice")} · ${esc(m.exos.map(e => e.name).join(", "))}</span></span>${tag(m.type)}${I.chev}</button>`).join("")}</div>`
      : `<p class="footnote" style="margin-top:8px">Pendant une séance, « Enregistrer comme modèle » garde la liste d'exercices pour la relancer en un geste.</p>`}

    <h2 class="sh">Minuteur sur l'écran verrouillé</h2>
    <div class="group">
      <label class="row"><span class="row-main"><span class="row-title">Utiliser le minuteur de l'iPhone</span><span class="row-sub">Via le raccourci « ${SHORTCUT} »</span></span><input type="checkbox" class="switch" id="set-shortcut" ${S.settings.shortcut ? "checked" : ""}></label>
      <button class="row row-btn" data-act="shortcut-help"><span class="row-title">Configurer le raccourci</span>${I.chev}</button>
    </div>
    <p class="footnote">Le décompte s'affiche sur l'écran verrouillé et dans la Dynamic Island, et la sonnerie fonctionne même téléphone verrouillé. L'app Raccourcis s'ouvre une seconde à chaque récup.</p>

    <h2 class="sh">Sauvegarde</h2>
    <div class="group">
      <button class="row row-btn" data-act="export"><span class="row-title accent">Exporter mes données</span></button>
      <label class="row row-btn" for="import-file"><span class="row-title accent">Importer une sauvegarde</span></label>
    </div>
    <input type="file" id="import-file" accept="application/json,.json" hidden>
    <p class="footnote">Tes données restent sur ce téléphone. Exporte régulièrement une sauvegarde dans Fichiers ou iCloud Drive.</p>
    <p class="footnote center version">Coach Claude · version ${APP_VERSION}</p>`;
}

/* ---------- Fiche exercice ---------- */
let exForm = null;
function openExForm(ex, then) {
  exForm = ex ? { ...ex } : { id: null, name: "", mode: "reps", band: false, kg: true, rest: 90, notes: "", photo: null };
  exForm.then = then; exForm.newPhoto = undefined;
  drawExForm();
}
function drawExForm() {
  const f = exForm, ph = f.newPhoto !== undefined ? f.newPhoto : (f.photo && photos[f.photo]);
  openSheet(`<div class="sheet-head"><button class="btn-text" data-act="close">Annuler</button><h2>${f.id ? "Exercice" : "Nouvel exercice"}</h2><button class="btn-text bold" data-act="f-save">${f.id ? "OK" : "Créer"}</button></div>
    ${ph ? `<img class="photo-top" src="${ph}" alt="Photo de l'exercice">` : ""}
    <div class="group"><label class="row"><span class="row-label">Nom</span><input class="row-input" id="f-name" value="${esc(f.name)}" placeholder="Front lever, Tractions…" autocomplete="off"></label></div>
    <h2 class="sh">Mesure</h2>
    <div class="seg"><button data-act="f-mode" data-v="reps" aria-pressed="${f.mode === "reps"}">Répétitions</button><button data-act="f-mode" data-v="time" aria-pressed="${f.mode === "time"}">Durée (secondes)</button></div>
    <h2 class="sh">Options</h2>
    <div class="group">
      <label class="row"><span class="row-main"><span class="row-title">Élastique</span><span class="row-sub">Assistance de léger à très fort</span></span><input type="checkbox" class="switch" id="f-band" ${f.band ? "checked" : ""}></label>
      <label class="row"><span class="row-main"><span class="row-title">Charge (kg)</span><span class="row-sub">Lest, haltères, gilet…</span></span><input type="checkbox" class="switch" id="f-kg" ${f.kg ? "checked" : ""}></label>
      <label class="row"><span class="row-label">Récup</span><input class="row-input" id="f-rest" inputmode="numeric" value="${esc(f.rest)}"><span class="row-unit">s</span></label>
    </div>
    <h2 class="sh">Consignes</h2>
    <div class="group"><div class="row"><textarea class="row-area" id="f-notes" rows="3" placeholder="Prise, placement, points techniques…">${esc(f.notes)}</textarea></div></div>
    <h2 class="sh">Photo</h2>
    <div class="group">
      <label class="row row-btn" for="f-photo"><span class="row-title accent">${ph ? "Changer la photo" : "Ajouter une photo"}</span></label>
      ${ph ? `<button class="row row-btn" data-act="f-nophoto"><span class="row-title danger">Retirer la photo</span></button>` : ""}
    </div>
    <input type="file" id="f-photo" accept="image/*" hidden>
    ${f.id ? `<div class="group" style="margin-top:12px"><button class="row row-btn" data-act="f-del"><span class="row-title danger">Supprimer l'exercice</span></button></div>` : ""}`);
}
function readExForm() {
  exForm.name = $("f-name").value; exForm.band = $("f-band").checked; exForm.kg = $("f-kg").checked;
  exForm.rest = num($("f-rest").value) || 90; exForm.notes = $("f-notes").value;
}
async function saveExForm() {
  readExForm(); const f = exForm;
  if (!f.name.trim()) { toast("Donne un nom à l'exercice."); return; }
  if (f.newPhoto !== undefined) {
    if (f.photo) { await DB.del("photo:" + f.photo); delete photos[f.photo]; }
    f.photo = null;
    if (f.newPhoto) { const pid = uid(); await DB.set("photo:" + pid, f.newPhoto); photos[pid] = f.newPhoto; f.photo = pid; }
  }
  const data = { id: f.id || uid(), name: f.name.trim(), mode: f.mode, band: f.band, kg: f.kg, rest: f.rest, notes: f.notes.trim(), photo: f.photo };
  const i = S.exercises.findIndex(e => e.id === data.id);
  if (i >= 0) S.exercises[i] = data; else S.exercises.push(data);
  await save("exercises");
  S.draft.exos.forEach(x => { if (x.exId === data.id) Object.assign(x, { name: data.name, mode: data.mode, band: data.band, kg: data.kg }); });
  saveDraft();
  const then = f.then; closeSheet();
  if (then) then(data);
  renderAll(); toast(i >= 0 ? "Exercice modifié" : "Exercice créé");
}
function resizePhoto(file) {
  return new Promise((res, rej) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const m = 900, k = Math.min(1, m / Math.max(img.width, img.height));
      const c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
      res(c.toDataURL("image/jpeg", .82));
    };
    img.onerror = () => rej(new Error("image illisible"));
    img.src = url;
  });
}

/* ---------- Choix d'un exercice ---------- */
function openPicker() {
  const draw = q => {
    const n = q.trim().toLowerCase();
    const list = S.exercises.filter(e => !n || e.name.toLowerCase().includes(n)).sort((a, b) => a.name.localeCompare(b.name, "fr"));
    $("pick-list").innerHTML = list.map(e => `<button class="row row-btn" data-act="pick" data-id="${e.id}">${thumb(e, e.mode, false)}
        <span class="row-main"><span class="row-title">${esc(e.name)}</span><span class="row-sub">${meta(e)}</span></span></button>`).join("")
      + `<button class="row row-btn" data-act="pick-new"><span class="thumb ph">${I.plus}</span><span class="row-main"><span class="row-title accent">${n ? `Créer « ${esc(q.trim())} »` : "Nouvel exercice"}</span></span></button>`;
  };
  openSheet(`<div class="sheet-head"><button class="btn-text" data-act="close">Annuler</button><h2>Ajouter un exercice</h2><span></span></div>
    <label class="search">${I.search}<input id="pick-q" placeholder="Rechercher" autocomplete="off" enterkeyhint="search" aria-label="Rechercher un exercice"></label>
    <div class="group thumbs" id="pick-list"></div>`);
  draw(""); $("pick-q").oninput = e => draw(e.target.value);
}
function addToDraft(ex) { S.draft.exos.push(draftExo(ex)); saveDraft(); renderSeance(); }
function addSet(i) {
  const x = S.draft.exos[i], l = x.sets[x.sets.length - 1] || {};
  x.sets.push(blankSet(l.rest || exById(x.exId)?.rest || 90, { reps: l.reps || l.ph?.reps || "", sec: l.sec || l.ph?.sec || "", kg: l.kg || l.ph?.kg || "", band: l.band || l.ph?.band || "" }));
  saveDraft(); renderSeance();
  return x.sets.length - 1;
}

/* ---------- Type de séance ---------- */
function openTypeSheet() {
  const cur = S.draft.type, custom = S.settings.types || [];
  openSheet(`<div class="sheet-head"><button class="btn-text" data-act="close">Annuler</button><h2>Type de séance</h2><span></span></div>
    <div class="group">
      <button class="row row-btn" data-act="type-pick" data-v=""><span class="row-title">Aucun</span>${cur ? "" : `<span class="accent">${I.check}</span>`}</button>
      ${allTypes().map(t => `<button class="row row-btn" data-act="type-pick" data-v="${esc(t)}">
        <span class="type-dot" style="--c:${typeColor(t)}"></span><span class="row-title">${esc(t)}</span>${t === cur ? `<span class="accent">${I.check}</span>` : ""}</button>`).join("")}
    </div>
    <h2 class="sh">Mes types</h2>
    <div class="group">
      ${custom.map(t => `<div class="row"><span class="type-dot" style="--c:${typeColor(t)}"></span><span class="row-title">${esc(t)}</span><button class="btn-text danger" data-act="type-del" data-v="${esc(t)}">Retirer</button></div>`).join("")}
      <div class="row"><input class="row-input left" id="type-new" placeholder="Nouveau type (ex. Dos / biceps)" autocomplete="off" enterkeyhint="done"><button class="btn-text bold" data-act="type-add">Ajouter</button></div>
    </div>
    <p class="footnote">Les types que tu ajoutes apparaissent dans la liste, avant « Autre ». Les séances déjà enregistrées gardent leur type.</p>`);
}
function setDraftType(t) { S.draft.type = t; saveDraft(); renderSeance(); }
async function addType() {
  const t = $("type-new").value.trim().replace(/\s+/g, " ");
  if (!t) { toast("Écris le nom du type."); return; }
  if (allTypes().some(x => x.toLowerCase() === t.toLowerCase())) { toast("Ce type existe déjà."); return; }
  S.settings.types = [...(S.settings.types || []), t]; await save("settings");
  closeSheet(); setDraftType(t); toast(`Type « ${t} » ajouté`);
}
document.addEventListener("keydown", e => { if (e.key === "Enter" && e.target.id === "type-new") { e.preventDefault(); addType(); } });

/* ---------- Modèles ---------- */
function openModelForm() {
  openSheet(`<div class="sheet-head"><button class="btn-text" data-act="close">Annuler</button><h2>Nouveau modèle</h2><button class="btn-text bold" data-act="model-save">Enregistrer</button></div>
    <div class="group"><label class="row"><span class="row-label">Nom</span><input class="row-input" id="m-name" value="${esc(S.draft.name)}" placeholder="Push, Pull, Jambes…" autocomplete="off"></label></div>
    <p class="footnote" style="margin-top:4px">Le modèle garde la liste des exercices, le nombre de séries et les temps de récup.</p>`);
}
function useModel(id) {
  const m = S.models.find(m => m.id === id), d = S.draft; if (!m) return;
  d.name = d.name || m.name; d.type = d.type || m.type || "";
  m.exos.forEach(me => {
    const ex = exById(me.exId); if (!ex) return;
    const last = lastOccurrence(ex.id, S.sessions);
    d.exos.push(draftExo(ex, me.sets.map((s, k) => ({ ...(last?.e.sets[k] || {}), rest: s.rest }))));
  });
  saveDraft(); renderSeance(); showTab("seance");
}

/* ---------- Enregistrement ---------- */
async function saveSession() {
  const d = S.draft;
  const exos = d.exos.map(x => ({
    exId: x.exId, name: x.name, mode: x.mode, band: x.band, kg: x.kg, note: (x.note || "").trim(),
    // Une série compte dès qu'elle est validée ou qu'une valeur y est saisie.
    // Les valeurs affichées en gris (charge, élastique reprises de la série d'avant) sont alors enregistrées telles quelles.
    sets: x.sets.filter(s => s.done || s.reps !== "" || s.sec !== "" || s.kg !== "").map(s => ({
      reps: s.reps || (s.done ? s.ph?.reps : "") || "", sec: s.sec || (s.done ? s.ph?.sec : "") || "",
      kg: x.kg ? (s.kg || s.ph?.kg || "") : (s.kg || ""), band: x.band ? (s.band || s.ph?.band || "") : (s.band || ""),
      rest: s.rest, rpe: s.rpe, note: (s.note || "").trim(),
    })),
  })).filter(x => x.sets.length);
  if (!exos.length) { toast("Remplis ou valide au moins une série."); return; }
  const old = d.id && S.sessions.find(s => s.id === d.id);
  const s = { id: d.id || uid(), name: d.name.trim() || d.type || "Séance", type: d.type || "", date: d.date || today(), note: d.note.trim(), exos, createdAt: old ? old.createdAt : Date.now(), updatedAt: Date.now() };
  s.comments = buildComments(s);
  if (old) Object.assign(old, s); else S.sessions.push(s);
  sortSessions(); await save("sessions");
  S.draft = newDraft(); saveDraft(); releaseWake();
  if (T.mode === "hold") stopTimer();
  renderAll();
  openSheet(`<div class="sheet-head"><span></span><h2>${old ? "Séance mise à jour" : "Séance enregistrée"}</h2><button class="btn-text bold" data-act="close">OK</button></div>
    <div class="done-hero">${I.check}</div>
    <p class="done-title">${esc(s.name)}</p>${s.type && s.type !== s.name ? `<div class="center">${tag(s.type)}</div>` : ""}
    <p class="muted center" style="margin:-8px 0 0">${fmtLong(s.date)} · ${plural(s.exos.length, "exercice")}</p>
    <div class="insights"><p class="insights-title">${I.sparkle}Analyse</p><ul>${s.comments.map(c => `<li class="${c.rec ? "rec" : ""}">${esc(c.t)}</li>`).join("")}</ul></div>`);
}

/* ---------- Saisie ---------- */
document.addEventListener("input", e => {
  const t = e.target, d = S.draft;
  if (t.id === "d-name") d.name = t.value;
  else if (t.id === "d-date") d.date = t.value;
  else if (t.id === "d-note") d.note = t.value;
  else if (t.dataset.xnote !== undefined) d.exos[t.dataset.xnote].note = t.value;
  else if (t.dataset.f && t.dataset.i !== undefined && t.closest("#v-seance")) d.exos[t.dataset.i].sets[t.dataset.j][t.dataset.f] = t.value;
  else return;
  saveDraft();
});
document.addEventListener("change", async e => {
  const t = e.target;
  if (t.id === "f-photo" && t.files[0]) {
    readExForm();
    try { exForm.newPhoto = await resizePhoto(t.files[0]); drawExForm(); } catch (err) { toast("Photo illisible, essaie une autre image."); }
  }
  if (t.id === "import-file" && t.files[0]) importData(t.files[0]);
  if (t.id === "set-shortcut") {
    S.settings.shortcut = t.checked; save("settings");
    if (t.checked && !S.settings.shortcutSeen) { S.settings.shortcutSeen = true; save("settings"); openShortcutHelp(); }
  }
});

/* ---------- Actions ---------- */
document.addEventListener("click", async e => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const a = b.dataset.act, d = S.draft, i = +b.dataset.i, j = +b.dataset.j, id = b.dataset.id;
  unlockAudio(); if (d.exos.length) keepAwake();
  switch (a) {
    case "tab": showTab(b.dataset.tab); break;
    case "close": closeSheet(); break;
    case "pick-ex": openPicker(); break;
    case "pick": closeSheet(); addToDraft(exById(id)); break;
    case "pick-new": openExForm({ id: null, name: $("pick-q").value.trim(), mode: "reps", band: false, kg: true, rest: 90, notes: "", photo: null }, addToDraft); break;
    case "new-ex": openExForm(null); break;
    case "edit-ex": openExForm(exById(id)); break;
    case "f-mode": readExForm(); exForm.mode = b.dataset.v; if (b.dataset.v === "time" && !exForm.id) exForm.kg = false; drawExForm(); break;
    case "f-nophoto": readExForm(); exForm.newPhoto = null; drawExForm(); break;
    case "f-save": saveExForm(); break;
    case "f-del": {
      const ok = await ask({ title: `Supprimer « ${exForm.name} » ?`, message: "Les séances passées gardent cet exercice dans leur historique.", actions: [{ label: "Supprimer l'exercice", destructive: true, value: true }] });
      if (!ok) break;
      if (exForm.photo) { await DB.del("photo:" + exForm.photo); delete photos[exForm.photo]; }
      S.exercises = S.exercises.filter(x => x.id !== exForm.id); await save("exercises"); closeSheet(); renderAll(); toast("Exercice supprimé"); break;
    }
    case "photo": openSheet(`<div class="sheet-head"><span></span><h2>Photo</h2><button class="btn-text bold" data-act="close">OK</button></div><img class="photo-big" src="${photos[id]}" alt="Photo de l'exercice">`); break;

    case "add-set": addSet(i); break;
    case "more": d.exos[i].sets[j].open = !d.exos[i].sets[j].open; renderSeance(); break;
    case "del-set": {
      const x = d.exos[i], s = x.sets[j];
      const filled = s.reps || s.sec || s.kg;
      const ok = await ask({ title: `Supprimer la série ${j + 1} ?`, message: `${x.name}${filled ? " · " + fmtSet(s, x) : ""}`, actions: [{ label: "Supprimer la série", destructive: true, value: true }] });
      if (!ok) break;
      if (T.mode === "hold") stopTimer(); x.sets.splice(j, 1); saveDraft(); renderSeance(); toast("Série supprimée"); break;
    }
    case "done": {
      const x = d.exos[i], s = x.sets[j]; s.done = !s.done;
      if (s.done) {
        for (const k of ["reps", "sec", "kg", "band"]) if (!s[k] && s.ph?.[k]) s[k] = s.ph[k];
        if (j < x.sets.length - 1 || d.exos[i + 1]) startRest(num(s.rest) || 90, x.name);
      }
      saveDraft(); renderSeance(); break;
    }
    case "rest": { const x = d.exos[i], s = x.sets.find(s => !s.done) || x.sets[x.sets.length - 1]; startRest(num(s?.rest) || 90, x.name); break; }
    case "hold": { const x = d.exos[i]; let k = x.sets.findIndex(s => !s.done); if (k < 0) k = addSet(i); startHold(i, k); break; }
    case "ex-menu": {
      const x = d.exos[i], n = d.exos.length;
      const acts = [];
      if (i > 0) acts.push({ label: "Monter", value: "up" });
      if (i < n - 1) acts.push({ label: "Descendre", value: "down" });
      if (exById(x.exId)) acts.push({ label: "Modifier la fiche", value: "edit" });
      acts.push({ label: "Retirer de la séance", destructive: true, value: "del" });
      const r = await ask({ title: x.name, actions: acts });
      if (r && r !== "edit" && T.mode === "hold") stopTimer();
      if (r === "up" || r === "down") { const k = r === "up" ? i - 1 : i + 1; [d.exos[k], d.exos[i]] = [d.exos[i], d.exos[k]]; saveDraft(); renderSeance(); }
      else if (r === "edit") openExForm(exById(x.exId));
      else if (r === "del") { d.exos.splice(i, 1); saveDraft(); renderSeance(); toast("Exercice retiré"); }
      break;
    }
    case "save": saveSession(); break;
    case "clear": {
      if (!await ask({ title: "Vider la séance en cours ?", message: "Les exercices et séries saisis seront perdus.", actions: [{ label: "Vider la séance", destructive: true, value: true }] })) break;
      if (T.mode === "hold") stopTimer(); S.draft = newDraft(); saveDraft(); renderSeance(); break;
    }
    case "cancel-edit": if (T.mode === "hold") stopTimer(); S.draft = newDraft(); saveDraft(); renderSeance(); break;
    case "save-model": openModelForm(); break;
    case "model-save": {
      const name = $("m-name").value.trim(); if (!name) { toast("Donne un nom au modèle."); break; }
      S.models.push({ id: uid(), name, type: d.type || "", exos: d.exos.map(x => ({ exId: x.exId, name: x.name, sets: x.sets.map(s => ({ rest: s.rest })) })) });
      await save("models"); closeSheet(); renderExos(); renderSeance(); toast("Modèle enregistré"); break;
    }
    case "use-model": useModel(id); break;
    case "model-menu": {
      const m = S.models.find(m => m.id === id);
      const r = await ask({ title: m.name, message: m.exos.map(e => e.name).join(", "), actions: [{ label: "Démarrer cette séance", value: "use" }, { label: "Supprimer le modèle", destructive: true, value: "del" }] });
      if (r === "use") {
        if (d.exos.length && !await ask({ title: "Ajouter à la séance en cours ?", message: "Les exercices du modèle s'ajouteront à ceux déjà saisis.", actions: [{ label: "Ajouter", value: true }] })) break;
        useModel(id);
      } else if (r === "del") { S.models = S.models.filter(x => x.id !== id); await save("models"); renderAll(); toast("Modèle supprimé"); }
      break;
    }
    case "edit": {
      if (d.exos.length && !d.id && !await ask({ title: "Remplacer la séance en cours ?", message: "Ta séance en cours sera remplacée par celle à modifier.", actions: [{ label: "Modifier quand même", value: true }] })) break;
      const s = S.sessions.find(s => s.id === id);
      if (T.mode === "hold") stopTimer();
      S.draft = { id: s.id, name: s.name, type: s.type || "", date: s.date, note: s.note || "", exos: s.exos.map(x => ({ ...x, note: x.note || "", sets: x.sets.map(t => ({ ...t, done: true, ph: {} })) })) };
      saveDraft(); renderSeance(); showTab("seance"); break;
    }
    case "redo": {
      if (d.exos.length && !await ask({ title: "Remplacer la séance en cours ?", message: "Les exercices déjà saisis seront remplacés.", actions: [{ label: "Remplacer", value: true }] })) break;
      const s = S.sessions.find(s => s.id === id); if (T.mode === "hold") stopTimer(); S.draft = newDraft(); S.draft.name = s.name; S.draft.type = s.type || "";
      s.exos.forEach(x => { const ex = exById(x.exId) || { id: x.exId, name: x.name, mode: x.mode, band: x.band, kg: x.kg, rest: 90 }; S.draft.exos.push(draftExo(ex, x.sets)); });
      saveDraft(); renderSeance(); showTab("seance"); break;
    }
    case "del-session": {
      const s = S.sessions.find(s => s.id === id);
      if (!await ask({ title: `Supprimer « ${s.name} » du ${fmtDate(s.date)} ?`, message: "Cette séance sera définitivement effacée.", actions: [{ label: "Supprimer la séance", destructive: true, value: true }] })) break;
      S.sessions = S.sessions.filter(s => s.id !== id); await save("sessions"); renderAll(); toast("Séance supprimée"); break;
    }
    case "type-open": openTypeSheet(); break;
    case "type-pick": closeSheet(); setDraftType(b.dataset.v); break;
    case "type-add": addType(); break;
    case "type-del": {
      const t = b.dataset.v;
      S.settings.types = (S.settings.types || []).filter(x => x !== t); await save("settings");
      openTypeSheet(); toast(`Type « ${t} » retiré`); break;
    }
    case "hist-filter": HIST_FILTER = b.dataset.v; renderHist(); break;
    case "sess-toggle": {
      const c = new Set(S.settings.collapsed || []);
      c.has(id) ? c.delete(id) : c.add(id);
      S.settings.collapsed = [...c].filter(x => S.sessions.some(s => s.id === x)); save("settings"); renderHist(); break;
    }
    case "sess-all": {
      const ids = (HIST_FILTER ? S.sessions.filter(s => s.type === HIST_FILTER) : S.sessions).map(s => s.id);
      const c = new Set(S.settings.collapsed || []), allShut = ids.every(x => c.has(x));
      ids.forEach(x => allShut ? c.delete(x) : c.add(x));
      S.settings.collapsed = [...c].filter(x => S.sessions.some(s => s.id === x)); save("settings"); renderHist(); break;
    }
    case "chart-mode": CH_MODE[b.dataset.key] = b.dataset.m; renderProg(); break;
    case "export": exportData(); break;
    case "shortcut-help": openShortcutHelp(); break;
    case "shortcut-copy":
      try { await navigator.clipboard.writeText(SHORTCUT); toast("Nom copié"); } catch (err) { toast(SHORTCUT); }
      break;
    case "shortcut-test": launchShortcut(10); break;

    case "timer-open": openTimerSheet(); break;
    case "mini-btn": if (T.mode === "hold") finishHold(); else stopTimer(); break;
    case "t-main":
      if (T.mode === "rest") stopTimer();
      else if (T.mode === "hold") finishHold();
      else startRest(T.pick);
      break;
    case "t-adj": adjustRest(+b.dataset.s); break;
    case "t-preset": T.pick = +b.dataset.s; startRest(T.pick); break;
  }
});

/* ---------- Onglets et barre du haut ---------- */
let TAB = "seance";
function showTab(t) {
  TAB = t;
  document.querySelectorAll(".tab").forEach(b => b.setAttribute("aria-current", b.dataset.tab === t ? "page" : "false"));
  ["seance", "hist", "prog", "exos"].forEach(k => $("v-" + k).hidden = k !== t);
  $("nav-title").textContent = TITLES[t];
  window.scrollTo(0, 0); onScroll();
}
function onScroll() { $("navbar").classList.toggle("scrolled", window.scrollY > 40); }
window.addEventListener("scroll", onScroll, { passive: true });

/* Fenêtres ouvertes : la page de derrière ne doit pas défiler */
let touchY = 0;
document.addEventListener("touchstart", e => { touchY = e.touches[0].clientY; }, { passive: true });
document.addEventListener("touchmove", e => {
  const sheetOpen = !$("modal").hidden, dialogOpen = !$("dialog").hidden;
  if (!sheetOpen && !dialogOpen) return;
  if (!e.cancelable) return;
  const sc = e.target.closest(".sheet");
  if (dialogOpen || !sc) { e.preventDefault(); return; }
  const dy = e.touches[0].clientY - touchY;
  const atTop = sc.scrollTop <= 0, atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 1;
  if (sc.scrollHeight <= sc.clientHeight + 1 || (dy > 0 && atTop) || (dy < 0 && atBottom)) e.preventDefault();
}, { passive: false });
function syncLock() { document.documentElement.classList.toggle("locked", !$("modal").hidden || !$("dialog").hidden); }
function renderAll() { renderSeance(); renderHist(); renderProg(); renderExos(); }

/* ---------- Minuteur ---------- */
const T = { mode: "idle", end: 0, start: 0, dur: 0, pick: 90, label: "Récup", hold: null, iv: null, doneT: null, shown: "" };
const PRESETS = [30, 60, 90, 120, 180];
const MINI_C = 2 * Math.PI * 14, BIG_C = 2 * Math.PI * 100;
const fmtPreset = s => s < 60 ? s + " s" : s % 60 ? fmtTime(s) : s / 60 + " min";
let audio;
function unlockAudio() { try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); if (audio.state === "suspended") audio.resume(); } catch (e) {} }
function beep() {
  try { [0, .28, .56].forEach(t => { const o = audio.createOscillator(), g = audio.createGain(); o.frequency.value = 880; g.gain.value = .25; o.connect(g); g.connect(audio.destination); o.start(audio.currentTime + t); o.stop(audio.currentTime + t + .15); }); } catch (e) {}
  try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch (e) {}
}
function launchShortcut(sec) {
  location.href = `shortcuts://run-shortcut?name=${encodeURIComponent(SHORTCUT)}&input=text&text=${Math.round(sec)}`;
}
function startRest(sec, name) {
  T.mode = "rest"; T.dur = sec; T.end = Date.now() + sec * 1000; T.label = name ? `Récup · ${name}` : "Récup"; T.hold = null;
  clearTimeout(T.doneT); run();
  if (S.settings.shortcut) launchShortcut(sec);
}
function adjustRest(delta) {
  if (T.mode !== "rest") return;
  T.end += delta * 1000; T.dur = Math.max(1, T.dur + delta); drawTimer();
}
function startHold(i, j) { T.mode = "hold"; T.start = Date.now(); T.hold = { i, j }; T.label = `Série ${j + 1} · ${S.draft.exos[i].name}`; clearTimeout(T.doneT); run(); }
function run() { clearInterval(T.iv); T.iv = setInterval(drawTimer, 250); drawTimer(); }
function stopTimer() { clearInterval(T.iv); clearTimeout(T.doneT); T.mode = "idle"; T.hold = null; T.label = "Récup"; drawTimer(); }
function finishRest() {
  clearInterval(T.iv); const late = Date.now() - T.end; T.mode = "done";
  if (late < 3000) beep();
  drawTimer();
  T.doneT = setTimeout(() => { if (T.mode === "done") stopTimer(); }, 12000);
}
function finishHold() {
  const { i, j } = T.hold, x = S.draft.exos[i], s = x?.sets[j];
  const sec = Math.floor((Date.now() - T.start) / 1000);
  if (s) { s.sec = String(sec); s.done = true; for (const k of ["kg", "band"]) if (!s[k] && s.ph?.[k]) s[k] = s.ph[k]; saveDraft(); renderSeance(); }
  startRest(num(s?.rest) || 90, x?.name);
}
function drawTimer() {
  const now = Date.now(); let secs, p;
  if (T.mode === "rest") {
    const left = Math.ceil((T.end - now) / 1000);
    if (left <= 0) { finishRest(); return; }
    secs = left; p = Math.max(0, Math.min(1, (T.end - now) / (T.dur * 1000)));
  } else if (T.mode === "hold") { secs = Math.floor((now - T.start) / 1000); p = (secs % 60) / 60; }
  else if (T.mode === "done") { secs = 0; p = 1; }
  else { secs = T.pick; p = 1; }
  const txt = fmtTime(secs);
  const mini = $("mini");
  mini.hidden = T.mode === "idle";
  mini.classList.toggle("done", T.mode === "done");
  $("mini-time").textContent = txt;
  $("mini-label").textContent = T.mode === "done" ? "Récup terminée, c'est reparti" : T.label;
  $("mini-ring").style.strokeDashoffset = (MINI_C * (1 - p)).toFixed(2);
  if (T.shown !== T.mode) {
    T.shown = T.mode;
    $("mini-btn").innerHTML = T.mode === "hold" ? I.check : I.x;
    $("mini-btn").setAttribute("aria-label", T.mode === "hold" ? "Terminer la série" : "Arrêter le minuteur");
  }
  if ($("t-clock")) {
    $("t-clock").textContent = txt;
    $("t-label").textContent = T.mode === "done" ? "C'est reparti" : T.mode === "idle" ? "Choisis une durée" : T.label;
    $("t-ring").style.strokeDashoffset = (BIG_C * (1 - p)).toFixed(2);
    $("t-big").classList.toggle("done", T.mode === "done");
    const main = $("t-main");
    main.textContent = T.mode === "rest" ? "Arrêter" : T.mode === "hold" ? "Terminer" : "Démarrer";
    main.className = "round " + (T.mode === "rest" ? "stop" : "go");
    $("t-minus").disabled = $("t-plus").disabled = T.mode !== "rest";
    document.querySelectorAll(".presets .chip").forEach(c => c.classList.toggle("on", +c.dataset.s === T.pick));
  }
}
function openTimerSheet() {
  openSheet(`<div class="sheet-head"><span></span><h2>Minuteur</h2><button class="btn-text bold" data-act="close">OK</button></div>
    <div class="tbig" id="t-big"><svg viewBox="0 0 220 220" aria-hidden="true"><circle class="ring-track" cx="110" cy="110" r="100"/><circle class="ring-prog" id="t-ring" cx="110" cy="110" r="100" stroke-dasharray="${BIG_C.toFixed(2)}"/></svg>
      <div class="tbig-in"><div class="tclock" id="t-clock" role="timer">0:00</div><div class="tlabel" id="t-label"></div></div></div>
    <div class="tbtns"><button class="round" id="t-minus" data-act="t-adj" data-s="-15">−15 s</button><button class="round go" id="t-main" data-act="t-main">Démarrer</button><button class="round" id="t-plus" data-act="t-adj" data-s="15">+15 s</button></div>
    <h2 class="sh">Durée de récup</h2>
    <div class="presets">${PRESETS.map(s => `<button class="chip" data-act="t-preset" data-s="${s}">${fmtPreset(s)}</button>`).join("")}</div>
    <p class="footnote" style="margin-top:4px">${S.settings.shortcut ? `Le minuteur de l'iPhone se lance aussi, via le raccourci « ${SHORTCUT} ». Les boutons ±15 s ne le modifient pas.` : "Pour voir le décompte sur l'écran verrouillé, active le minuteur de l'iPhone dans l'onglet Exercices."}</p>`);
  drawTimer();
}
function openShortcutHelp() {
  openSheet(`<div class="sheet-head"><span></span><h2>Minuteur de l'iPhone</h2><button class="btn-text bold" data-act="close">OK</button></div>
    <p class="lead">Le minuteur de l'iPhone affiche le décompte sur l'écran verrouillé et dans la Dynamic Island, et sonne même téléphone verrouillé. Coach Claude le lance grâce à un raccourci, à créer une seule fois.</p>
    <ol class="group steps">
      <li class="row"><span class="step">1</span><span>Ouvre l'app <b>Raccourcis</b> et appuie sur <b>+</b> pour créer un raccourci.</span></li>
      <li class="row"><span class="step">2</span><span>Ajoute l'action <b>Démarrer le minuteur</b> (app Horloge).</span></li>
      <li class="row"><span class="step">3</span><span>Touche la durée, choisis la variable <b>Entrée du raccourci</b>, puis l'unité <b>secondes</b>.</span></li>
      <li class="row"><span class="step">4</span><span>Nomme le raccourci exactement <b>${SHORTCUT}</b>.</span></li>
      <li class="row"><span class="step">5</span><span>Active l'option dans Coach Claude, puis fais un essai.</span></li>
    </ol>
    <div class="group">
      <button class="row row-btn" data-act="shortcut-copy"><span class="row-title accent">Copier le nom « ${SHORTCUT} »</span></button>
      <button class="row row-btn" data-act="shortcut-test"><span class="row-title accent">Tester avec 10 secondes</span></button>
    </div>
    <p class="footnote">À chaque récup, l'app Raccourcis s'ouvre une seconde pour lancer le minuteur, puis tu reviens dans Coach Claude. Le minuteur de l'appli continue en parallèle.</p>`);
}

/* ---------- Écran allumé pendant la séance ---------- */
let wake = null;
async function keepAwake() { try { if (!wake && "wakeLock" in navigator && document.visibilityState === "visible") { wake = await navigator.wakeLock.request("screen"); wake.addEventListener("release", () => wake = null); } } catch (e) {} }
function releaseWake() { try { wake && wake.release(); } catch (e) {} wake = null; }
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { drawTimer(); if (S.draft?.exos.length) keepAwake(); } });

/* ---------- Export / import ---------- */
async function exportData() {
  const ph = {}; for (const e of S.exercises) if (e.photo && photos[e.photo]) ph[e.photo] = photos[e.photo];
  const data = { app: "coach-claude", version: 2, exportedAt: new Date().toISOString(), exercises: S.exercises, sessions: S.sessions, models: S.models, types: S.settings.types || [], photos: ph };
  const name = `coach-claude-sauvegarde-${today()}.json`;
  const file = new File([JSON.stringify(data)], name, { type: "application/json" });
  try { if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: "Sauvegarde Coach Claude" }); return; } } catch (e) { if (e.name === "AbortError") return; }
  const a = document.createElement("a"); a.href = URL.createObjectURL(file); a.download = name; document.body.append(a); a.click(); a.remove();
}
async function importData(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!["carnet", "coach-claude"].includes(data.app)) throw new Error("ce fichier n'est pas une sauvegarde de Coach Claude");
    const merge = (cur, inc) => { const m = new Map(cur.map(x => [x.id, x])); (inc || []).forEach(x => m.set(x.id, x)); return [...m.values()]; };
    S.exercises = merge(S.exercises, data.exercises); S.sessions = merge(S.sessions, data.sessions); S.models = merge(S.models, data.models);
    for (const [k, v] of Object.entries(data.photos || {})) { photos[k] = v; await DB.set("photo:" + k, v); }
    if (data.types?.length) { S.settings.types = [...new Set([...(S.settings.types || []), ...data.types])]; await save("settings"); }
    sortSessions(); await Promise.all([save("exercises"), save("sessions"), save("models")]);
    renderAll(); toast(`Import terminé : ${plural((data.sessions || []).length, "séance")}`);
  } catch (e) { toast("Import impossible : " + e.message); }
}

/* ---------- Démarrage ---------- */
(async () => {
  try {
    for (const k of ["exercises", "sessions", "models", "draft"]) { const v = await DB.get(k); if (v) S[k] = v; }
    const st = await DB.get("settings"); if (st) S.settings = { ...S.settings, ...st };
    for (const k of await DB.keys()) if (String(k).startsWith("photo:")) photos[k.slice(6)] = await DB.get(k);
    navigator.storage?.persist?.();
  } catch (e) { toast("Stockage indisponible : les données ne seront pas gardées."); }
  if (!S.draft) S.draft = newDraft();
  sortSessions(); renderAll(); showTab("seance"); drawTimer();
})();

/* Mises à jour : dès qu'une nouvelle version est installée, l'appli se recharge toute seule
   (la séance en cours est déjà enregistrée sur le téléphone). */
function reloadWhenIdle() {
  if (!$("modal").hidden || !$("dialog").hidden) { pendingReload = true; return; }
  location.reload();
}
if ("serviceWorker" in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (hadController) reloadWhenIdle(); });
  navigator.serviceWorker.register("sw.js").then(reg => {
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reg.update().catch(() => {}); });
  }).catch(() => {});
}
