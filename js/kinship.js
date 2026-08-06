// kinship.js — the discerning-individual engine.
// Trust here is not followers or stars: it is measured taste. Two atlases
// resonate when (1) their common ground agrees, (2) they care about the same
// domains, and (3) where they diverge, the divergence is interesting — a
// correspondent strong where you are blank expands you rather than mismatching.

import { haversineKm } from './geocode.js?v=rf21';

const SAME_PLACE_KM = 0.15; // within ~150m = the same place

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

// evidence lines carry our own <b>/<i> markup, so every foreign value
// interpolated into them must arrive inert
function escv(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// tag distribution keyed by normalized tag NAME (ids differ across atlases)
function domainVector(atlas) {
  const tagName = new Map(atlas.tags.map(t => [t.id, norm(t.name)]));
  const v = new Map();
  for (const p of atlas.places) {
    for (const tid of p.tags) {
      const name = tagName.get(tid);
      if (!name) continue;
      v.set(name, (v.get(name) || 0) + 1);
    }
  }
  return v;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const k of keys) {
    const x = a.get(k) || 0, y = b.get(k) || 0;
    dot += x * y; na += x * x; nb += y * y;
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function samePlace(a, b) {
  if (haversineKm(a, b) > SAME_PLACE_KM) return false;
  const an = norm(a.name), bn = norm(b.name);
  return an.includes(bn) || bn.includes(an) || haversineKm(a, b) < 0.04;
}

// mine, theirs: {tags, places}. Returns the full resonance reading.
export function resonance(mine, theirs) {
  const myDomains = domainVector(mine);
  const theirDomains = domainVector(theirs);
  const theirTagName = new Map(theirs.tags.map(t => [t.id, norm(t.name)]));
  const theirTagLabel = new Map(theirs.tags.map(t => [t.id, t.name]));

  // 1 — common ground and whether it agrees
  const common = [];
  for (const tp of theirs.places) {
    const mp = mine.places.find(p => samePlace(p, tp));
    if (!mp) continue;
    const bothLove = (mp.rating >= 4 && tp.rating >= 4);
    const bothHold = true;
    const disagree = (mp.rating >= 4 && tp.rating > 0 && tp.rating <= 2) ||
                     (tp.rating >= 4 && mp.rating > 0 && mp.rating <= 2);
    common.push({ mine: mp, theirs: tp, bothLove, disagree, agree: bothLove && !disagree });
  }
  const loved = common.filter(c => c.bothLove).length;
  const disagreed = common.filter(c => c.disagree).length;
  const groundScore = common.length
    ? Math.min(1, (loved * 1.0 + (common.length - loved - disagreed) * 0.45 - disagreed * 0.6) / Math.max(3, common.length))
    : 0;

  // 2 — domain alignment
  const alignment = cosine(myDomains, theirDomains);
  const aligned = [...theirDomains.keys()]
    .filter(k => (myDomains.get(k) || 0) >= 2 && theirDomains.get(k) >= 2)
    .sort((a, b) => (theirDomains.get(b) + (myDomains.get(b) || 0)) - (theirDomains.get(a) + (myDomains.get(a) || 0)));

  // 3 — the open mind: domains where they are deep and you are blank
  const expansion = [...theirDomains.keys()]
    .filter(k => theirDomains.get(k) >= 3 && (myDomains.get(k) || 0) <= 1)
    .sort((a, b) => theirDomains.get(b) - theirDomains.get(a));

  // blended score: ground counts double when it exists; expansion is a mild bonus
  const hasGround = common.length > 0;
  const score = Math.max(0, Math.min(1,
    (hasGround ? 0.5 * groundScore + 0.38 * alignment : 0.62 * alignment) +
    0.12 * Math.min(1, expansion.length / 3)
  ));

  // their picks for you: strong conviction, in domains you care about or that expand you,
  // and not already yours
  const picks = theirs.places
    .filter(tp => !mine.places.some(p => samePlace(p, tp)))
    .map(tp => {
      const domains = tp.tags.map(t => theirTagName.get(t)).filter(Boolean);
      const affinity = Math.max(0, ...domains.map(d => myDomains.get(d) || 0));
      const expands = domains.some(d => expansion.includes(d));
      const conviction = tp.rating > 0 ? tp.rating / 5 : (tp.status === 'visited' ? 0.55 : 0.35);
      const note = tp.note ? 0.1 : 0;
      return {
        place: tp,
        domainLabels: tp.tags.map(t => theirTagLabel.get(t)).filter(Boolean),
        expands,
        weight: conviction + note + Math.min(0.5, affinity * 0.08) + (expands ? 0.22 : 0),
      };
    })
    .sort((a, b) => b.weight - a.weight);

  return {
    score,
    common,
    loved,
    disagreed,
    alignment,
    alignedDomains: aligned,
    expansionDomains: expansion,
    picks,
  };
}

// the verdict: one word from a five-word lexicon, never a number
export function verdict(r) {
  const s = r.score;
  if (s < 0.15) return { word: 'distant', sub: 'Different orbits. Worth the look.' };
  if (s < 0.35) return { word: 'faint', sub: 'A few shared frequencies.' };
  if (s < 0.55) return { word: 'audible', sub: 'You hear some of the same world.' };
  if (s < 0.75) return { word: 'consonant', sub: 'You keep much of the same world.' };
  return { word: 'resonant', sub: 'You keep the same world.' };
}

// kinship spoken in three registers — specific claims, never a blended score
export function evidenceLines(r, name) {
  const lines = [];
  if (r.common.length) {
    lines.push(r.loved >= 1
      ? `<b>${r.common.length}</b> places you both hold, <b>${r.loved}</b> you both love`
      : `<b>${r.common.length}</b> place${r.common.length > 1 ? 's' : ''} you both hold`);
  } else {
    lines.push('no overlaps yet, every mark here is news');
  }
  if (r.alignedDomains.length) {
    lines.push(`both fluent in <i>${r.alignedDomains.slice(0, 2).map(escv).join('</i> and <i>')}</i>`);
  } else if (r.alignment < 0.25) {
    lines.push('you read different sections of the world');
  }
  if (r.expansionDomains.length) {
    const d = escv(r.expansionDomains[0]);
    const n = r.picks.filter(p => p.expands).length;
    lines.push(n
      ? `${escv(name) || 'they'} would hand you <b>${n}</b> place${n > 1 ? 's' : ''} in <i>${d}</i>, ground you barely touch`
      : `deep in <i>${d}</i>, where your atlas is thin`);
  }
  return lines;
}

// a phrase, not a dashboard — how a person would say it
export function resonancePhrase(r, name) {
  const who = name || 'This atlas';
  if (!r.common.length && r.alignment < 0.25 && !r.expansionDomains.length) {
    return `${who} charts different ground than yours. Read it as travel, not counsel.`;
  }
  const bits = [];
  if (r.loved >= 2) bits.push(`you both love ${r.loved} of the same places`);
  else if (r.loved === 1) bits.push(`you both love one place`);
  else if (r.common.length) bits.push(`${r.common.length} place${r.common.length > 1 ? 's' : ''} in common`);
  if (r.alignedDomains.length) bits.push(`shared ground in ${r.alignedDomains.slice(0, 2).join(' and ')}`);
  if (r.expansionDomains.length) bits.push(`deep in ${r.expansionDomains[0]}, where your atlas is blank`);
  const strength = r.score >= 0.65 ? 'resonates strongly with yours' :
    r.score >= 0.35 ? 'resonates with yours' : 'touches yours lightly';
  return `${who} ${strength}: ${bits.join(', ')}.`;
}
