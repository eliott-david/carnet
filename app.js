"use strict";
/* Carnet de séances — PWA hors ligne. Données stockées dans IndexedDB sur l'appareil. */

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

const S = { exercises: [], sessions: [], models: [], draft: null };
const save = k => DB.set(k, S[k]).catch(e => toast("Sauvegarde impossible : " + e.message));
const photos = {}; // cache id -> dataURL

/* ---------- Outils ---------- */
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const fmtDate = d => new Date(d + "T12:00").toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" });
const fmtTime = s => Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
const BANDS = ["Aucun", "Léger", "Moyen", "Fort", "Très fort"];
const num = v => (v === "" || v == null) ? 0 : +String(v).replace(",", ".") || 0;
let toastT;
function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 2600); }
const exById = id => S.exercises.find(e => e.id === id);

/* Valeur principale d'une série : reps ou secondes */
const val = (set, ex) => num(ex.mode === "time" ? set.sec : set.reps);
const fmtSet = (set, ex) => {
  const v = ex.mode === "time" ? (set.sec ? set.sec + " s" : "?") : (set.reps || "?");
  return v + (ex.kg && num(set.kg) ? " × " + set.kg + " kg" : "") + (ex.band && set.band ? " (" + set.band.toLowerCase() + ")" : "");
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

/* Séances antérieures à une séance donnée (pour comparer) */
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
  const week = S.sessions.filter(o => o.id !== s.id && (d - new Date(o.date + "T12:00")) / 864e5 >= 0 && (d - new Date(o.date + "T12:00")) / 864e5 < 7).length + 1;
  if (prior[0]) {
    const gap = Math.round((d - new Date(prior[0].date + "T12:00")) / 864e5);
    if (gap >= 8) out.push({ t: `Reprise après ${gap} jours sans séance enregistrée. Bien joué d'être revenu.` });
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
const newDraft = () => ({ id: null, name: "", date: today(), note: "", exos: [] });
function draftExo(ex, template) {
  const last = lastOccurrence(ex.id, S.sessions);
  const ref = template || (last && last.e.sets) || [{}];
  return {
    exId: ex.id, name: ex.name, mode: ex.mode, band: ex.band, kg: ex.kg, note: "",
    sets: ref.map(r => ({ reps: "", sec: "", kg: "", band: "", rest: r.rest || ex.rest || 90, rpe: "", note: "", done: false, ph: { reps: r.reps || "", sec: r.sec || "", kg: r.kg || "", band: r.band || "" } })),
  };
}
const saveDraft = () => save("draft");

/* ---------- Rendu : Séance ---------- */
function renderSeance() {
  const d = S.draft, v = $("v-seance");
  const editing = d.id ? `<div class="banner"><span>Modification de la séance du ${fmtDate(S.sessions.find(s => s.id === d.id)?.date || d.date)}</span><button class="btn" data-act="cancel-edit">Annuler</button></div>` : "";
  const models = !d.exos.length && S.models.length ? `<div class="card"><h3>Démarrer depuis un modèle</h3><div class="pick-list">${S.models.map(m => `<button class="pick" data-act="use-model" data-id="${m.id}"><span class="grow"><b>${esc(m.name)}</b><br><span class="note">${esc(m.exos.map(e => e.name).join(", "))}</span></span></button>`).join("")}</div></div>` : "";
  v.innerHTML = `${editing}
    <div class="card">
      <div class="row"><input class="grow" id="d-name" placeholder="Nom de la séance (Push, Tirage…)" value="${esc(d.name)}"><input id="d-date" type="date" style="width:150px" value="${esc(d.date)}"></div>
      <textarea id="d-note" rows="2" placeholder="Commentaire sur la séance (forme, sommeil…)">${esc(d.note)}</textarea>
    </div>
    ${models}
    ${d.exos.map(renderExo).join("")}
    <button class="btn full" data-act="pick-ex">+ Ajouter un exercice</button>
    ${d.exos.length ? `<button class="btn pri full" data-act="save">${d.id ? "Mettre à jour la séance" : "Enregistrer la séance"}</button>
    <div class="row"><button class="btn ghost" data-act="save-model">Enregistrer comme modèle</button><button class="btn ghost danger" data-act="clear">Vider la séance</button></div>` : `<p class="note">Ajoute un exercice pour commencer. Les exercices que tu crées sont gardés dans l'onglet Exos.</p>`}`;
}

function renderExo(x, i) {
  const lib = exById(x.exId) || x;
  const ph = lib.photo && photos[lib.photo];
  const last = lastOccurrence(keyOf(x), S.sessions.filter(s => s.id !== S.draft.id));
  const cols = ["34px", "1fr"]; if (x.kg) cols.push("1fr"); if (x.band) cols.push("1.25fr"); cols.push("1fr", "26px");
  const head = `<span class="h">✓</span><span class="h">${x.mode === "time" ? "Sec" : "Reps"}</span>${x.kg ? '<span class="h">Kg</span>' : ""}${x.band ? '<span class="h">Élastique</span>' : ""}<span class="h">Récup s</span><span></span>`;
  const rows = x.sets.map((s, j) => {
    const at = `data-i="${i}" data-j="${j}"`;
    const open = s.open || s.note || s.rpe;
    return `<button class="done-btn ${s.done ? "on" : ""}" data-act="done" ${at} aria-label="Valider la série ${j + 1}">${s.done ? "✓" : j + 1}</button>
      <input inputmode="${x.mode === "time" ? "numeric" : "numeric"}" data-f="${x.mode === "time" ? "sec" : "reps"}" ${at} value="${esc(x.mode === "time" ? s.sec : s.reps)}" placeholder="${esc(x.mode === "time" ? s.ph?.sec : s.ph?.reps)}">
      ${x.kg ? `<input inputmode="decimal" data-f="kg" ${at} value="${esc(s.kg)}" placeholder="${esc(s.ph?.kg || "0")}">` : ""}
      ${x.band ? `<select data-f="band" ${at}><option value="">${esc(s.ph?.band || "—")}</option>${BANDS.map(b => `<option ${s.band === b ? "selected" : ""}>${b}</option>`).join("")}</select>` : ""}
      <input inputmode="numeric" data-f="rest" ${at} value="${esc(s.rest)}">
      <button class="more-btn ${s.note || s.rpe ? "has" : ""}" data-act="more" ${at} aria-label="Ressenti et note de la série">⋯</button>
      ${open ? `<div class="set-extra"><select data-f="rpe" ${at} aria-label="Ressenti sur 10"><option value="">Ressenti</option>${[5, 6, 7, 8, 9, 10].map(n => `<option value="${n}" ${+s.rpe === n ? "selected" : ""}>${n}/10</option>`).join("")}</select><input data-f="note" ${at} value="${esc(s.note)}" placeholder="Note sur la série"></div>` : ""}`;
  }).join("");
  return `<div class="card">
    <div class="ex-head">
      ${ph ? `<img class="thumb" src="${ph}" alt="" data-act="photo" data-id="${lib.photo}">` : `<span class="thumb empty">${x.mode === "time" ? "⏱" : "●"}</span>`}
      <div class="ex-title"><h2>${esc(x.name)}</h2><div class="pills"><span class="pill">${x.mode === "time" ? "Durée" : "Reps"}</span>${x.band ? '<span class="pill">Élastique</span>' : ""}${x.kg ? '<span class="pill">Charge</span>' : ""}</div></div>
      <button class="btn ghost" data-act="ex-up" data-i="${i}" aria-label="Monter">↑</button>
      <button class="btn ghost" data-act="del-ex" data-i="${i}" aria-label="Retirer l'exercice">✕</button>
    </div>
    ${lib.notes ? `<div class="note">${esc(lib.notes)}</div>` : ""}
    ${last ? `<div class="note">Dernière fois (${fmtDate(last.s.date)}) : ${esc(last.e.sets.map(s => fmtSet(s, last.e)).join(" · "))}</div>` : ""}
    <div class="sets" style="grid-template-columns:${cols.join(" ")}">${head}${rows}</div>
    <input data-xnote="${i}" value="${esc(x.note)}" placeholder="Commentaire sur l'exercice">
    <div class="row">
      <button class="btn" data-act="add-set" data-i="${i}">+ Série</button>
      ${x.mode === "time" ? `<button class="btn" data-act="hold" data-i="${i}">▶ Chrono de série</button>` : ""}
      <button class="btn" data-act="rest" data-i="${i}">Récup</button>
    </div>
  </div>`;
}

/* ---------- Rendu : Historique ---------- */
function renderHist() {
  $("v-hist").innerHTML = S.sessions.length ? S.sessions.map(s => `<div class="card">
    <div class="between"><div><h2>${esc(s.name)}</h2><span class="note">${fmtDate(s.date)}</span></div>
      <button class="btn icon" data-act="edit" data-id="${s.id}" aria-label="Modifier la séance">✎</button></div>
    ${s.note ? `<div class="note">${esc(s.note)}</div>` : ""}
    ${s.exos.map(e => `<div class="hist-ex"><div class="between"><span>${esc(e.name)}</span><span>${esc(e.sets.map(x => fmtSet(x, e)).join(" · "))}</span></div>
      ${e.note ? `<span class="note">${esc(e.note)}</span>` : ""}
      ${e.sets.filter(x => x.note).map(x => `<span class="note">Série ${e.sets.indexOf(x) + 1} : ${esc(x.note)}</span>`).join("")}</div>`).join("")}
    ${s.comments?.length ? `<ul class="comments">${s.comments.map(c => `<li class="${c.rec ? "rec" : ""}">${esc(c.t)}</li>`).join("")}</ul>` : ""}
    <div class="row"><button class="btn" data-act="redo" data-id="${s.id}">Refaire cette séance</button><button class="btn ghost danger" data-act="del-session" data-id="${s.id}">Supprimer</button></div>
  </div>`).join("") : `<div class="card"><h2>Pas encore de séance</h2><p class="note">Enregistre ta première séance dans l'onglet Séance, elle apparaîtra ici avec ses commentaires.</p></div>`;
}

/* ---------- Rendu : Progrès ---------- */
function renderProg() {
  const map = new Map();
  [...S.sessions].reverse().forEach(s => s.exos.forEach(e => {
    const b = bestSet(e); if (!b) return;
    const k = keyOf(e); if (!map.has(k)) map.set(k, { ex: e, pts: [] });
    map.get(k).pts.push({ date: s.date, best: b, ex: e, tot: total(e) });
  }));
  if (!map.size) { $("v-prog").innerHTML = `<div class="card"><h2>Rien à suivre pour l'instant</h2><p class="note">Tes records et l'évolution de chaque exercice s'afficheront ici après quelques séances.</p></div>`; return; }
  $("v-prog").innerHTML = [...map.values()].map(({ ex, pts }) => {
    const rec = pts.reduce((a, p) => cmp(score(p.best, p.ex), score(a.best, a.ex)) > 0 ? p : a);
    const lastP = pts[pts.length - 1], isRec = rec === lastP && pts.length > 1;
    const name = (exById(ex.exId) || ex).name;
    return `<div class="card">
      <div class="between"><h2>${esc(name)}</h2><span class="pill ${isRec ? "rec" : ""}">${isRec ? "Record à la dernière séance" : pts.length + " séance" + (pts.length > 1 ? "s" : "")}</span></div>
      <div class="row" style="gap:18px"><div><h3>Record</h3><div class="big">${esc(fmtSet(rec.best, rec.ex))}</div><span class="note">${fmtDate(rec.date)}</span></div>
      <div><h3>Dernière fois</h3><div class="big">${esc(fmtSet(lastP.best, lastP.ex))}</div><span class="note">${fmtDate(lastP.date)}</span></div></div>
      ${spark(pts.map(p => val(p.best, p.ex)), ex.mode === "time" ? "secondes" : "reps")}
      ${pts.length > 1 ? `<span class="note">Meilleure série en ${ex.mode === "time" ? "secondes" : "reps"}, séance par séance${ex.band ? " (le niveau d'élastique compte aussi dans le record)" : ""}</span>` : ""}
    </div>`;
  }).join("");
}
function spark(v, unit) {
  if (v.length < 2) return "";
  const W = 300, H = 56, max = Math.max(...v), min = Math.min(...v), r = max - min || 1;
  const pts = v.map((y, i) => [i * (W - 8) / (v.length - 1) + 4, H - 6 - (y - min) / r * (H - 14)]);
  const line = pts.map(p => p.join(",")).join(" "), L = pts[pts.length - 1];
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Meilleure série en ${unit}, séance par séance">
    <line x1="0" x2="${W}" y1="${H - 6}" y2="${H - 6}" stroke="var(--line)"/>
    <polygon points="4,${H - 6} ${line} ${L[0]},${H - 6}" fill="var(--accent-soft)"/>
    <polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke"/>
    <circle cx="${L[0]}" cy="${L[1]}" r="3.5" fill="var(--accent)"/></svg>`;
}

/* ---------- Rendu : Exos (bibliothèque, modèles, sauvegarde) ---------- */
function renderExos() {
  const list = [...S.exercises].sort((a, b) => a.name.localeCompare(b.name, "fr"));
  $("v-exos").innerHTML = `
    <button class="btn pri full" data-act="new-ex">+ Nouvel exercice</button>
    ${list.length ? list.map(e => `<div class="card"><div class="ex-head">
        ${e.photo && photos[e.photo] ? `<img class="thumb" src="${photos[e.photo]}" alt="" data-act="photo" data-id="${e.photo}">` : `<span class="thumb empty">${e.mode === "time" ? "⏱" : "●"}</span>`}
        <div class="ex-title"><h2>${esc(e.name)}</h2><div class="pills"><span class="pill">${e.mode === "time" ? "Durée" : "Reps"}</span>${e.band ? '<span class="pill">Élastique</span>' : ""}${e.kg ? '<span class="pill">Charge</span>' : ""}<span class="pill">Récup ${e.rest} s</span></div></div>
        <button class="btn icon" data-act="edit-ex" data-id="${e.id}" aria-label="Modifier l'exercice">✎</button></div>
        ${e.notes ? `<div class="note">${esc(e.notes)}</div>` : ""}</div>`).join("")
      : `<div class="card"><p class="note">Aucun exercice pour l'instant. Crée tes exercices ici ou directement pendant une séance.</p></div>`}
    <div class="card"><h3>Modèles de séance</h3>
      ${S.models.length ? S.models.map(m => `<div class="between"><span>${esc(m.name)} <span class="note">· ${m.exos.length} exo${m.exos.length > 1 ? "s" : ""}</span></span><button class="btn ghost danger" data-act="del-model" data-id="${m.id}">Supprimer</button></div>`).join("") : `<p class="note">Pendant une séance, « Enregistrer comme modèle » garde la liste d'exercices pour la relancer en un tap.</p>`}
    </div>
    <div class="card"><h3>Sauvegarde</h3>
      <p class="note">Tes données restent sur ce téléphone. Exporte de temps en temps un fichier de sauvegarde (dans Fichiers ou iCloud Drive) pour pouvoir tout récupérer.</p>
      <div class="row"><button class="btn" data-act="export">Exporter</button><label class="btn" for="import-file">Importer</label><input type="file" id="import-file" accept="application/json,.json" hidden></div>
    </div>`;
}

/* ---------- Fiche exercice (création / modification) ---------- */
let exForm = null;
function openExForm(ex, then) {
  exForm = ex ? { ...ex } : { id: null, name: "", mode: "reps", band: false, kg: true, rest: 90, notes: "", photo: null };
  exForm.then = then; exForm.newPhoto = undefined;
  drawExForm();
}
function drawExForm() {
  const f = exForm, ph = f.newPhoto !== undefined ? f.newPhoto : (f.photo && photos[f.photo]);
  openModal(`<div class="between"><h2>${f.id ? "Modifier l'exercice" : "Nouvel exercice"}</h2><button class="btn ghost" data-act="close">Fermer</button></div>
    <label class="field">Nom<input id="f-name" value="${esc(f.name)}" placeholder="Front lever, Tractions…"></label>
    <div class="field" style="display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--mute)">Type de mesure
      <div class="seg"><button data-act="f-mode" data-v="reps" aria-pressed="${f.mode === "reps"}">Répétitions</button><button data-act="f-mode" data-v="time" aria-pressed="${f.mode === "time"}">Durée (secondes)</button></div></div>
    <label class="toggle"><span>Avec élastique<br><span class="note">Pour noter l'assistance (léger à très fort)</span></span><input type="checkbox" id="f-band" ${f.band ? "checked" : ""}></label>
    <label class="toggle"><span>Avec charge (kg)<br><span class="note">Lest, haltères, gilet…</span></span><input type="checkbox" id="f-kg" ${f.kg ? "checked" : ""}></label>
    <label class="field">Récup par défaut (secondes)<input id="f-rest" inputmode="numeric" value="${esc(f.rest)}"></label>
    <label class="field">Consignes / réglages<textarea id="f-notes" placeholder="Prise, placement, points techniques…">${esc(f.notes)}</textarea></label>
    <div class="field" style="display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--mute)">Photo (facultative)
      ${ph ? `<img class="photo-big" src="${ph}" alt="Photo de l'exercice">` : ""}
      <div class="row"><label class="btn" for="f-photo">${ph ? "Changer la photo" : "Ajouter une photo"}</label>${ph ? '<button class="btn ghost danger" data-act="f-nophoto">Retirer</button>' : ""}</div>
      <input type="file" id="f-photo" accept="image/*" hidden></div>
    <button class="btn pri full" data-act="f-save">${f.id ? "Enregistrer" : "Créer l'exercice"}</button>
    ${f.id ? '<button class="btn ghost danger" data-act="f-del">Supprimer cet exercice</button>' : ""}`);
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
  // Mettre à jour les exos de la séance en cours qui utilisent cette fiche
  S.draft.exos.forEach(x => { if (x.exId === data.id) Object.assign(x, { name: data.name, mode: data.mode, band: data.band, kg: data.kg }); });
  saveDraft();
  const then = f.then; closeModal();
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
      res(c.toDataURL("image/jpeg", .8));
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
    $("pick-list").innerHTML = list.map(e => `<button class="pick" data-act="pick" data-id="${e.id}">
      ${e.photo && photos[e.photo] ? `<img class="thumb" src="${photos[e.photo]}" alt="">` : `<span class="thumb empty">${e.mode === "time" ? "⏱" : "●"}</span>`}
      <span class="grow"><b>${esc(e.name)}</b><br><span class="note">${e.mode === "time" ? "Durée" : "Reps"}${e.band ? " · élastique" : ""}${e.kg ? " · charge" : ""}</span></span></button>`).join("")
      + `<button class="pick" data-act="pick-new"><span class="thumb empty">+</span><span class="grow"><b>${n ? `Créer « ${esc(q.trim())} »` : "Créer un nouvel exercice"}</b></span></button>`;
  };
  openModal(`<div class="between"><h2>Ajouter un exercice</h2><button class="btn ghost" data-act="close">Fermer</button></div>
    <input id="pick-q" placeholder="Rechercher…" autocomplete="off"><div class="pick-list" id="pick-list"></div>`);
  draw(""); $("pick-q").oninput = e => draw(e.target.value);
}
function addToDraft(ex) { S.draft.exos.push(draftExo(ex)); saveDraft(); renderSeance(); }

/* ---------- Fenêtre ---------- */
function openModal(html) { $("modal-box").innerHTML = html; $("modal").hidden = false; }
function closeModal() { $("modal").hidden = true; $("modal-box").innerHTML = ""; }
$("modal").addEventListener("click", e => { if (e.target.id === "modal") closeModal(); });

/* ---------- Enregistrement ---------- */
async function saveSession() {
  const d = S.draft;
  const exos = d.exos.map(x => ({
    exId: x.exId, name: x.name, mode: x.mode, band: x.band, kg: x.kg, note: x.note.trim(),
    sets: x.sets.filter(s => s.done || s.reps !== "" || s.sec !== "" || s.kg !== "").map(s => ({
      reps: s.reps || (s.done ? s.ph?.reps : "") || "", sec: s.sec || (s.done ? s.ph?.sec : "") || "",
      kg: s.kg || (s.done ? s.ph?.kg : "") || "", band: s.band || (s.done ? s.ph?.band : "") || "",
      rest: s.rest, rpe: s.rpe, note: (s.note || "").trim(),
    })),
  })).filter(x => x.sets.length);
  if (!exos.length) { toast("Remplis ou valide au moins une série."); return; }
  const old = d.id && S.sessions.find(s => s.id === d.id);
  const s = { id: d.id || uid(), name: d.name.trim() || "Séance", date: d.date || today(), note: d.note.trim(), exos, createdAt: old ? old.createdAt : Date.now(), updatedAt: Date.now() };
  s.comments = buildComments(s);
  if (old) Object.assign(old, s); else S.sessions.push(s);
  sortSessions(); await save("sessions");
  S.draft = newDraft(); saveDraft(); releaseWake();
  renderAll();
  openModal(`<h2>${old ? "Séance mise à jour" : "Séance enregistrée"}</h2><span class="note">${esc(s.name)} · ${fmtDate(s.date)}</span>
    <ul class="comments">${s.comments.map(c => `<li class="${c.rec ? "rec" : ""}">${esc(c.t)}</li>`).join("")}</ul>
    <button class="btn pri full" data-act="close">OK</button>`);
}

/* ---------- Événements ---------- */
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
});

document.addEventListener("click", async e => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const a = b.dataset.act, d = S.draft, i = +b.dataset.i, j = +b.dataset.j, id = b.dataset.id;
  unlockAudio(); if (d.exos.length) keepAwake();
  switch (a) {
    case "close": closeModal(); break;
    case "pick-ex": openPicker(); break;
    case "pick": closeModal(); addToDraft(exById(id)); break;
    case "pick-new": { const q = $("pick-q").value.trim(); openExForm({ id: null, name: q, mode: "reps", band: false, kg: true, rest: 90, notes: "", photo: null }, addToDraft); break; }
    case "new-ex": openExForm(null); break;
    case "edit-ex": openExForm(exById(id)); break;
    case "f-mode": readExForm(); exForm.mode = b.dataset.v; if (b.dataset.v === "time" && !exForm.id) exForm.kg = false; drawExForm(); break;
    case "f-nophoto": readExForm(); exForm.newPhoto = null; drawExForm(); break;
    case "f-save": saveExForm(); break;
    case "f-del":
      if (!confirm("Supprimer cet exercice ? Les séances passées le gardent dans leur historique.")) break;
      if (exForm.photo) { await DB.del("photo:" + exForm.photo); delete photos[exForm.photo]; }
      S.exercises = S.exercises.filter(x => x.id !== exForm.id); await save("exercises"); closeModal(); renderAll(); break;
    case "photo": openModal(`<img class="photo-big" src="${photos[id]}" alt="Photo de l'exercice"><button class="btn full" data-act="close">Fermer</button>`); break;
    case "add-set": { const x = d.exos[i], l = x.sets[x.sets.length - 1] || {};
      x.sets.push({ reps: "", sec: "", kg: "", band: "", rest: l.rest || 90, rpe: "", note: "", done: false, ph: { reps: l.reps || l.ph?.reps || "", sec: l.sec || l.ph?.sec || "", kg: l.kg || l.ph?.kg || "", band: l.band || l.ph?.band || "" } });
      saveDraft(); renderSeance(); break; }
    case "more": d.exos[i].sets[j].open = !d.exos[i].sets[j].open; renderSeance(); break;
    case "done": { const x = d.exos[i], s = x.sets[j]; s.done = !s.done;
      if (s.done) { // série validée : reprend les valeurs suggérées si vides, puis lance la récup
        for (const k of ["reps", "sec", "kg", "band"]) if (!s[k] && s.ph?.[k]) s[k] = s.ph[k];
        if (j < x.sets.length - 1 || d.exos[i + 1]) startRest(num(s.rest) || 90, x.name);
      }
      saveDraft(); renderSeance(); break; }
    case "rest": { const x = d.exos[i], s = x.sets.find(s => !s.done) || x.sets[x.sets.length - 1]; startRest(num(s?.rest) || 90, x.name); break; }
    case "hold": { const x = d.exos[i]; let j2 = x.sets.findIndex(s => !s.done);
      if (j2 < 0) { $("v-seance").querySelector(`[data-act="add-set"][data-i="${i}"]`).click(); j2 = x.sets.length - 1; }
      startHold(i, j2); break; }
    case "ex-up": if (i > 0) { [d.exos[i - 1], d.exos[i]] = [d.exos[i], d.exos[i - 1]]; saveDraft(); renderSeance(); } break;
    case "del-ex": if (confirm(`Retirer ${d.exos[i].name} de la séance ?`)) { d.exos.splice(i, 1); saveDraft(); renderSeance(); } break;
    case "save": saveSession(); break;
    case "clear": if (confirm("Vider la séance en cours ?")) { S.draft = newDraft(); saveDraft(); renderSeance(); } break;
    case "cancel-edit": S.draft = newDraft(); saveDraft(); renderSeance(); break;
    case "save-model": {
      const name = prompt("Nom du modèle", d.name || "Ma séance"); if (!name) break;
      S.models.push({ id: uid(), name: name.trim(), exos: d.exos.map(x => ({ exId: x.exId, name: x.name, sets: x.sets.map(s => ({ rest: s.rest })) })) });
      await save("models"); toast("Modèle enregistré"); break; }
    case "use-model": { const m = S.models.find(m => m.id === id);
      d.name = d.name || m.name;
      m.exos.forEach(me => { const ex = exById(me.exId); if (!ex) return; const last = lastOccurrence(ex.id, S.sessions);
        const tpl = me.sets.map((s, k) => ({ ...(last?.e.sets[k] || {}), rest: s.rest })); d.exos.push(draftExo(ex, tpl)); });
      saveDraft(); renderSeance(); break; }
    case "del-model": if (confirm("Supprimer ce modèle ?")) { S.models = S.models.filter(m => m.id !== id); await save("models"); renderExos(); } break;
    case "edit": {
      if (d.exos.length && !d.id && !confirm("Ta séance en cours sera remplacée par celle à modifier. Continuer ?")) break;
      const s = S.sessions.find(s => s.id === id);
      S.draft = { id: s.id, name: s.name, date: s.date, note: s.note || "", exos: s.exos.map(x => ({ ...x, note: x.note || "", sets: x.sets.map(t => ({ ...t, done: true, ph: {} })) })) };
      saveDraft(); renderSeance(); showTab("seance"); break; }
    case "redo": {
      if (d.exos.length && !confirm("Remplacer la séance en cours ?")) break;
      const s = S.sessions.find(s => s.id === id); S.draft = newDraft(); S.draft.name = s.name;
      s.exos.forEach(x => { const ex = exById(x.exId) || { id: x.exId, name: x.name, mode: x.mode, band: x.band, kg: x.kg, rest: 90 }; S.draft.exos.push(draftExo(ex, x.sets)); });
      saveDraft(); renderSeance(); showTab("seance"); break; }
    case "del-session": if (confirm("Supprimer définitivement cette séance ?")) { S.sessions = S.sessions.filter(s => s.id !== id); await save("sessions"); renderAll(); } break;
    case "export": exportData(); break;
  }
});

/* ---------- Onglets ---------- */
function showTab(t) {
  document.querySelectorAll("#tabs button").forEach(b => b.setAttribute("aria-pressed", b.dataset.tab === t));
  ["seance", "hist", "prog", "exos"].forEach(k => $("v-" + k).hidden = k !== t);
  window.scrollTo(0, 0);
}
$("tabs").addEventListener("click", e => { const b = e.target.closest("button"); if (b) showTab(b.dataset.tab); });
function renderAll() {
  renderSeance(); renderHist(); renderProg(); renderExos();
  const n = S.sessions.length; $("status").textContent = n ? `${n} séance${n > 1 ? "s" : ""}` : "";
}

/* ---------- Chrono ---------- */
const T = { mode: "idle", end: 0, start: 0, label: "Récup", hold: null, iv: null };
let audio;
function unlockAudio() { try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); if (audio.state === "suspended") audio.resume(); } catch (e) {} }
function beep() {
  try { [0, .28, .56].forEach(t => { const o = audio.createOscillator(), g = audio.createGain(); o.frequency.value = 880; g.gain.value = .25; o.connect(g); g.connect(audio.destination); o.start(audio.currentTime + t); o.stop(audio.currentTime + t + .15); }); } catch (e) {}
  try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch (e) {}
}
function startRest(sec, name) { T.mode = "rest"; T.end = Date.now() + sec * 1000; T.label = "Récup" + (name ? " · " + name : ""); T.hold = null; run(); }
function startHold(i, j) { T.mode = "hold"; T.start = Date.now(); T.hold = { i, j }; T.label = `Série ${j + 1} · ${S.draft.exos[i].name}`; run(); showTimer(true); }
function run() { clearInterval(T.iv); T.iv = setInterval(drawTimer, 200); drawTimer(); }
function stopTimer() { clearInterval(T.iv); T.mode = "idle"; T.hold = null; T.label = "Récup"; drawTimer(); }
function drawTimer() {
  let txt = "0:00", done = false;
  if (T.mode === "rest") { const left = Math.max(0, Math.ceil((T.end - Date.now()) / 1000)); txt = fmtTime(left); if (!left) { done = true; clearInterval(T.iv); T.mode = "done"; beep(); } }
  else if (T.mode === "done") { txt = "0:00"; done = true; }
  else if (T.mode === "hold") txt = fmtTime(Math.floor((Date.now() - T.start) / 1000));
  $("clock").textContent = txt; $("pill-clock").textContent = txt;
  $("clock").classList.toggle("done", done);
  $("timer-label").textContent = T.mode === "done" ? "C'est reparti" : T.label;
  $("timer-finish").hidden = T.mode !== "hold";
  $("timer-pill").classList.toggle("run", T.mode === "rest" || T.mode === "hold");
  $("timer-pill").classList.toggle("done", done);
}
function finishHold() {
  const { i, j } = T.hold, x = S.draft.exos[i], s = x?.sets[j];
  const sec = Math.floor((Date.now() - T.start) / 1000);
  if (s) { s.sec = String(sec); s.done = true; for (const k of ["kg", "band"]) if (!s[k] && s.ph?.[k]) s[k] = s.ph[k]; saveDraft(); renderSeance(); }
  startRest(num(s?.rest) || 90, x?.name);
}
[30, 60, 90, 120, 180].forEach(s => { const b = document.createElement("button"); b.textContent = s < 60 ? s + " s" : s / 60 + " min"; b.onclick = () => { unlockAudio(); startRest(s); }; $("chips").append(b); });
$("timer-stop").onclick = stopTimer;
$("timer-finish").onclick = finishHold;
function showTimer(show) {
  $("timer").hidden = !show; $("timer-pill").hidden = show; document.body.classList.toggle("timer-hidden", !show);
  try { localStorage.setItem("timer-hidden", show ? "0" : "1"); } catch (e) {}
}
$("timer-hide").onclick = () => showTimer(false);
$("timer-pill").onclick = () => showTimer(true);

/* ---------- Écran allumé pendant la séance ---------- */
let wake = null;
async function keepAwake() { try { if (!wake && "wakeLock" in navigator && document.visibilityState === "visible") { wake = await navigator.wakeLock.request("screen"); wake.addEventListener("release", () => wake = null); } } catch (e) {} }
function releaseWake() { try { wake && wake.release(); } catch (e) {} wake = null; }
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { drawTimer(); if (S.draft?.exos.length) keepAwake(); } });

/* ---------- Export / import ---------- */
async function exportData() {
  const ph = {}; for (const e of S.exercises) if (e.photo && photos[e.photo]) ph[e.photo] = photos[e.photo];
  const data = { app: "carnet", version: 1, exportedAt: new Date().toISOString(), exercises: S.exercises, sessions: S.sessions, models: S.models, photos: ph };
  const name = `carnet-sauvegarde-${today()}.json`;
  const file = new File([JSON.stringify(data)], name, { type: "application/json" });
  try { if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: "Sauvegarde Carnet" }); return; } } catch (e) { if (e.name === "AbortError") return; }
  const a = document.createElement("a"); a.href = URL.createObjectURL(file); a.download = name; document.body.append(a); a.click(); a.remove();
}
async function importData(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== "carnet") throw new Error("ce fichier n'est pas une sauvegarde du Carnet");
    const merge = (cur, inc) => { const m = new Map(cur.map(x => [x.id, x])); (inc || []).forEach(x => m.set(x.id, x)); return [...m.values()]; };
    S.exercises = merge(S.exercises, data.exercises); S.sessions = merge(S.sessions, data.sessions); S.models = merge(S.models, data.models);
    for (const [k, v] of Object.entries(data.photos || {})) { photos[k] = v; await DB.set("photo:" + k, v); }
    sortSessions(); await Promise.all([save("exercises"), save("sessions"), save("models")]);
    renderAll(); toast(`Import terminé : ${(data.sessions || []).length} séances`);
  } catch (e) { toast("Import impossible : " + e.message); }
}

/* ---------- Démarrage ---------- */
(async () => {
  try {
    for (const k of ["exercises", "sessions", "models", "draft"]) { const v = await DB.get(k); if (v) S[k] = v; }
    const keys = await DB.keys();
    for (const k of keys) if (String(k).startsWith("photo:")) photos[k.slice(6)] = await DB.get(k);
    navigator.storage?.persist?.();
  } catch (e) { toast("Stockage indisponible : les données ne seront pas gardées."); }
  if (!S.draft) S.draft = newDraft();
  sortSessions(); renderAll(); drawTimer();
  try { if (localStorage.getItem("timer-hidden") === "1") showTimer(false); } catch (e) {}
})();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").then(reg => {
    reg.addEventListener("updatefound", () => {
      const w = reg.installing;
      w && w.addEventListener("statechange", () => { if (w.state === "activated" && navigator.serviceWorker.controller) toast("Appli mise à jour. Relance-la pour en profiter."); });
    });
  }).catch(() => {});
}
