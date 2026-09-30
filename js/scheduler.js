/* Study Cards - spacing scheduler.
 *
 * Pure logic: no DOM, no storage, no timers. Exposed as `window.StudyScheduler`
 * in the browser and as `module.exports` in Node so it can be unit-tested
 * (see scripts/test_scheduler.js).
 *
 * A small SM-2 variant modelled on Anki's stock defaults:
 *
 *   new cards    learn through steps 1m -> 10m, then graduate to 1 day.
 *                `again` sends it back to the first step, `hard` repeats the
 *                current step, `easy` graduates straight to 4 days.
 *   review cards Hard x1.2, Good x EF, Easy x EF x1.3 - each with a guaranteed
 *                +1 day (Hard) / +2 days (Easy) so an interval can never
 *                freeze the way a bare Math.round(ivl * ef) can.
 *   lapsed cards drop into a 10m relearning step, then restart at
 *                LAPSE_NEW_INTERVAL_FACTOR of the interval they had (0% -> back
 *                to 1 day, which is Anki's default "new interval" setting).
 *
 * Intervals of a day or more are aligned to a study-day boundary
 * (DAY_ROLLOVER_HOUR) instead of the exact minute you graded the card, so a
 * card answered at 23:55 is due tomorrow morning rather than tomorrow night.
 *
 * Card shape (all fields are persisted in localStorage):
 *   { id, q, a, state, step, ef, reps, lapses, interval, due, lapseIvl }
 *     state    : 'new' | 'learning' | 'relearning' | 'review'
 *     step     : index into the current learning-step list
 *     interval : days; fractional while learning, whole days >= 1 in review
 *     due      : epoch ms; 0 (or missing) means "available right now"
 */
(function(){
  "use strict";

  var MINUTE = 60 * 1000;
  var DAY = 24 * 60 * MINUTE;

  var CFG = {
    // Anki's stock "new cards" steps, in minutes.
    NEW_STEPS_MIN: [1, 10],
    // Anki's stock "lapsed cards" relearning step, in minutes.
    LAPSE_STEPS_MIN: [10],
    // Interval a learning card graduates to, in days.
    GRADUATING_DAYS: 1,
    // Interval an "Easy" answer graduates straight to, in days.
    EASY_DAYS: 4,
    // Fraction of the pre-lapse interval a lapsed card restarts at (Anki's
    // "new interval" setting; 0 means it restarts at the graduating interval).
    LAPSE_NEW_INTERVAL_FACTOR: 0,
    HARD_MULTIPLIER: 1.2,
    EASY_BONUS: 1.3,
    EF_START: 2.5,
    EF_MIN: 1.3,
    EF_MAX: 3.5,
    EF_AGAIN_DELTA: 0.2,
    EF_HARD_DELTA: 0.15,
    EF_EASY_DELTA: 0.15,
    // Safety rails: no card is ever scheduled more than 100 years out.
    MAX_INTERVAL_DAYS: 36500,
    // Cards graded before this hour count as belonging to the previous day.
    DAY_ROLLOVER_HOUR: 4,
    // New cards introduced per study day (Anki's default new/day = 20).
    NEW_PER_DAY: 20,
    // How many times one card may be re-shown inside a single session.
    MAX_INTRADAY_REPS: 4
  };

  var LEARNING_STATES = { new: true, learning: true, relearning: true };
  var REVIEW_STATE = { review: true };
  var GRADES = { again: true, hard: true, good: true, easy: true };

  function isNum(v){ return typeof v === 'number' && isFinite(v); }
  function num(v, fallback){ return isNum(v) ? v : fallback; }
  function clamp(v, lo, hi){ return v < lo ? lo : (v > hi ? hi : v); }
  function clampDays(d){ return clamp(Math.round(d), 1, CFG.MAX_INTERVAL_DAYS); }
  function has(map, key){ return Object.prototype.hasOwnProperty.call(map, key); }

  // ---- dates ---------------------------------------------------------------

  // Start of the study day that `ts` belongs to (local time).
  function dayStart(ts){
    var d = new Date(num(ts, Date.now()));
    if(d.getHours() < CFG.DAY_ROLLOVER_HOUR) d.setDate(d.getDate() - 1);
    d.setHours(CFG.DAY_ROLLOVER_HOUR, 0, 0, 0);
    return d.getTime();
  }

  function studyDayKey(ts){ return new Date(dayStart(ts)).toDateString(); }

  // Sub-day intervals stay at minute precision (they are learning steps);
  // intervals of a day or more land on a study-day boundary.
  function dueForInterval(intervalDays, now){
    var days = num(intervalDays, 0);
    if(days < 1) return now + Math.max(0, days) * DAY;
    var d = new Date(dayStart(now));
    d.setDate(d.getDate() + clampDays(days));
    return d.getTime();
  }

  function formatInterval(days){
    days = num(days, 0);
    if(days <= 0) return 'now';
    var mins = days * 24 * 60;
    if(mins < 60) return Math.round(mins) + 'm';
    if(days < 1) return Math.round(days * 24) + 'h';
    if(days < 45) return Math.round(days) + 'd';
    if(days < 365){
      var mo = Math.round(days / 30.4 * 10) / 10;
      return (mo % 1 === 0 ? mo.toFixed(0) : mo.toFixed(1)) + 'mo';
    }
    var yrs = Math.round(days / 365 * 10) / 10;
    return (yrs % 1 === 0 ? yrs.toFixed(0) : yrs.toFixed(1)) + 'y';
  }

  // ---- card state ----------------------------------------------------------

  function stepsFor(state){
    if(state === 'relearning') return CFG.LAPSE_STEPS_MIN;
    if(state === 'review') return [];
    return CFG.NEW_STEPS_MIN;
  }

  function isLearningPhase(card){
    return !!card && has(LEARNING_STATES, card.state);
  }

  // Fills in every field the scheduler relies on and migrates cards written by
  // older versions of the app (which only stored ef/reps/interval/due).
  function normalizeCard(card){
    if(!card || typeof card !== 'object') card = {};
    card.ef = clamp(num(card.ef, CFG.EF_START), CFG.EF_MIN, CFG.EF_MAX);
    card.reps = Math.max(0, Math.round(num(card.reps, 0)));
    card.lapses = Math.max(0, Math.round(num(card.lapses, 0)));
    card.interval = Math.max(0, num(card.interval, 0));
    if(!isNum(card.due)) card.due = 0;
    if(!isNum(card.lapseIvl)) card.lapseIvl = 0;

    if(!has(LEARNING_STATES, card.state) && !has(REVIEW_STATE, card.state)){
      // Legacy card: infer the phase from what the old scheduler wrote.
      if(card.reps === 0 && card.interval === 0) card.state = 'new';
      else card.state = card.interval < 1 ? 'learning' : 'review';
    }
    if(card.state === 'new' && (card.interval >= 1 || card.reps > 0)){
      card.state = card.interval < 1 ? 'learning' : 'review';
    }

    var steps = stepsFor(card.state);
    if(!steps.length){
      card.step = 0;
    } else {
      // A migrated mid-lapse card sits on the last step, so its next `good`
      // graduates instead of replaying steps it already passed. Anything else
      // (including every brand-new card) starts at step 0.
      var fallback = card.state === 'learning' ? steps.length - 1 : 0;
      card.step = clamp(Math.round(num(card.step, fallback)), 0, steps.length - 1);
    }
    return card;
  }

  function graduateDays(card, fallbackDays){
    var factor = Math.max(0, num(CFG.LAPSE_NEW_INTERVAL_FACTOR, 0));
    var base = num(card.lapseIvl, 0) * factor;
    return clampDays(Math.max(CFG.GRADUATING_DAYS, base > 0 ? base : fallbackDays));
  }

  // Sleep until a learning step. A card that has been answered at least once
  // leaves the `new` bucket and becomes a `learning` card.
  function enterStep(card, step, now){
    var steps = stepsFor(card.state);
    var mins = steps[clamp(step, 0, steps.length - 1)];
    if(card.state === 'new') card.state = 'learning';
    card.step = step;
    card.interval = mins / (24 * 60);
    card.due = now + mins * MINUTE;
    return card;
  }

  // ---- the scheduler -------------------------------------------------------

  function scheduleLearning(card, grade, now){
    var steps = stepsFor(card.state);
    var last = steps.length - 1;

    if(grade === 'easy'){
      card.state = 'review';
      card.step = 0;
      card.reps += 1;
      card.ef = clamp(card.ef + CFG.EF_EASY_DELTA, CFG.EF_MIN, CFG.EF_MAX);
      card.interval = graduateDays(card, CFG.EASY_DAYS);
      card.due = dueForInterval(card.interval, now);
      return card;
    }
    if(grade === 'again'){
      // Back to the first step. Ease is untouched while still learning - the
      // penalty belongs to a review lapse, not to a first look at a card.
      return enterStep(card, 0, now);
    }
    if(grade === 'hard'){
      // Hard repeats the current step instead of jumping a whole day ahead.
      return enterStep(card, card.step, now);
    }
    // good: advance one step, or graduate once the steps are exhausted.
    if(card.step < last) return enterStep(card, card.step + 1, now);
    card.state = 'review';
    card.step = 0;
    card.reps += 1;
    card.interval = graduateDays(card, CFG.GRADUATING_DAYS);
    card.due = dueForInterval(card.interval, now);
    return card;
  }

  function scheduleReview(card, grade, now){
    var ivl = clampDays(Math.max(1, num(card.interval, CFG.GRADUATING_DAYS)));
    var next;

    if(grade === 'again'){
      card.lapses += 1;
      card.lapseIvl = ivl;
      card.reps = 0;
      card.state = 'relearning';
      card.ef = clamp(card.ef - CFG.EF_AGAIN_DELTA, CFG.EF_MIN, CFG.EF_MAX);
      return enterStep(card, 0, now);
    }

    card.reps += 1;
    if(grade === 'hard'){
      card.ef = clamp(card.ef - CFG.EF_HARD_DELTA, CFG.EF_MIN, CFG.EF_MAX);
      next = Math.max(ivl + 1, ivl * CFG.HARD_MULTIPLIER);
    } else if(grade === 'good'){
      next = Math.max(ivl + 1, ivl * card.ef);
    } else {
      card.ef = clamp(card.ef + CFG.EF_EASY_DELTA, CFG.EF_MIN, CFG.EF_MAX);
      next = Math.max(ivl + 2, ivl * card.ef * CFG.EASY_BONUS);
    }
    card.interval = clampDays(next);
    card.due = dueForInterval(card.interval, now);
    return card;
  }

  // Mutates `card` in place (same contract the app has always used) and
  // returns it. `now` is injectable so the result is deterministic in tests.
  function schedule(card, grade, now){
    now = num(now, Date.now());
    if(!has(GRADES, grade)) grade = 'good';
    normalizeCard(card);
    return card.state === 'review'
      ? scheduleReview(card, grade, now)
      : scheduleLearning(card, grade, now);
  }

  function cloneCard(card){
    try { return JSON.parse(JSON.stringify(card || {})); }
    catch(e){ return {}; }
  }

  // What `schedule` would do, without touching the real card.
  function previewCard(card, grade, now){
    var clone = cloneCard(card);
    schedule(clone, grade, num(now, Date.now()));
    return clone;
  }

  function previewInterval(card, grade, now){
    return formatInterval(previewCard(card, grade, now).interval);
  }

  function previewDueLabel(card, grade, now){
    var base = num(now, Date.now());
    var next = previewCard(card, grade, base);
    if(next.due <= base) return 'available now';
    var d = new Date(next.due);
    var label = next.interval >= 1
      ? d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })
      : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return 'next up ' + label;
  }

  // ---- queue building ------------------------------------------------------

  function isDue(card, now){
    now = num(now, Date.now());
    return !card || !card.due || card.due <= now;
  }

  function shuffle(list, rng){
    var rand = typeof rng === 'function' ? rng : Math.random;
    for(var i = list.length - 1; i > 0; i--){
      var j = Math.floor(rand() * (i + 1));
      var tmp = list[i]; list[i] = list[j]; list[j] = tmp;
    }
    return list;
  }

  function byDue(a, b){ return (a.due || 0) - (b.due || 0); }

  // Order a session the way Anki does: cards already part-way through their
  // learning steps first (oldest step first), then due reviews, then at most
  // `newPerDay - newIntroducedToday` brand-new cards.
  function buildSessionQueue(cards, now, opts){
    var o = opts || {};
    var nowTs = num(now, Date.now());
    var perDay = Math.max(0, Math.round(num(o.newPerDay, CFG.NEW_PER_DAY)));
    var introduced = Math.max(0, Math.round(num(o.newIntroducedToday, 0)));
    var newBudget = Math.max(0, perDay - introduced);

    var learning = [], review = [], fresh = [];
    (cards || []).forEach(function(raw){
      var card = normalizeCard(raw);
      if(!isDue(card, nowTs)) return;
      if(card.state === 'learning' || card.state === 'relearning') learning.push(card);
      else if(card.state === 'review') review.push(card);
      else fresh.push(card);
    });

    learning.sort(byDue);
    shuffle(review, o.rng);
    shuffle(fresh, o.rng);

    var queuedNew = fresh.slice(0, newBudget);
    return {
      queue: learning.concat(review, queuedNew),
      learning: learning.length,
      review: review.length,
      new: fresh.length,
      newQueued: queuedNew.length,
      newDeferred: fresh.length - queuedNew.length
    };
  }

  // ---- study-day bookkeeping ----------------------------------------------

  function defaults(){
    return {
      streak: 0,
      lastStudyDate: null,
      totalReviews: 0,
      newByDay: { date: null, count: 0 }
    };
  }

  function newIntroducedToday(stats, now){
    var s = stats || {};
    var key = studyDayKey(num(now, Date.now()));
    if(!s.newByDay || s.newByDay.date !== key) return 0;
    return Math.max(0, Math.round(num(s.newByDay.count, 0)));
  }

  function recordNewIntroduced(stats, now){
    var s = stats || {};
    var key = studyDayKey(num(now, Date.now()));
    if(!s.newByDay || s.newByDay.date !== key) s.newByDay = { date: key, count: 0 };
    s.newByDay.count = Math.max(0, Math.round(num(s.newByDay.count, 0))) + 1;
    return s.newByDay.count;
  }

  // Idempotent per study day; yesterday-or-before continues the streak.
  function touchStreak(stats, now){
    var s = stats || {};
    var ts = num(now, Date.now());
    var today = studyDayKey(ts);
    if(s.lastStudyDate === today) return num(s.streak, 0);
    s.streak = (s.lastStudyDate === studyDayKey(ts - DAY)) ? num(s.streak, 0) + 1 : 1;
    s.lastStudyDate = today;
    return s.streak;
  }

  // ---- deck parsing --------------------------------------------------------

  function cleanText(s){
    return String(s || '').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  }

  function dedupeKey(question){
    return String(question || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  // Accepts "Q: ... / A: ..." blocks separated by a line of --- or a blank
  // line, in either LF or CRLF (which is what most PDF-to-text and Windows
  // editors produce). Returns cards without ids - the caller owns id creation.
  function parseDeck(text){
    var out = { cards: [], duplicates: 0, malformed: 0 };
    if(typeof text !== 'string' || !text.trim()) return out;

    var normalized = text.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ');
    var blocks = normalized.split(/\n[ \t]*---[ \t]*(?:\n|$)|\n[ \t]*\n+/);
    var seen = Object.create(null);

    blocks.forEach(function(block){
      if(!block.trim()) return;
      var qm = block.match(/(?:^|\n)[ \t]*Q:[ \t]*([\s\S]*?)(?:\n[ \t]*A:[ \t]*|$)/i);
      var am = block.match(/(?:^|\n)[ \t]*A:[ \t]*([\s\S]*)$/i);
      if(!qm || !am){ out.malformed += 1; return; }
      var q = cleanText(qm[1]);
      var a = cleanText(am[1]);
      if(!q || !a){ out.malformed += 1; return; }
      var key = dedupeKey(q);
      if(has(seen, key)){ out.duplicates += 1; return; }
      seen[key] = true;
      out.cards.push({ q: q, a: a });
    });
    return out;
  }

  // ---- exports -------------------------------------------------------------

  var StudyScheduler = {
    CFG: CFG,
    DAY: DAY,
    MINUTE: MINUTE,
    newCard: function(q, a, id){ return normalizeCard({ id: id, q: q, a: a }); },
    normalizeCard: normalizeCard,
    isLearningPhase: isLearningPhase,
    stepsFor: stepsFor,
    schedule: schedule,
    previewCard: previewCard,
    previewInterval: previewInterval,
    previewDueLabel: previewDueLabel,
    formatInterval: formatInterval,
    dueForInterval: dueForInterval,
    dayStart: dayStart,
    studyDayKey: studyDayKey,
    isDue: isDue,
    shuffle: shuffle,
    buildSessionQueue: buildSessionQueue,
    defaults: defaults,
    newIntroducedToday: newIntroducedToday,
    recordNewIntroduced: recordNewIntroduced,
    touchStreak: touchStreak,
    parseDeck: parseDeck,
    dedupeKey: dedupeKey
  };

  if(typeof module !== 'undefined' && module.exports) module.exports = StudyScheduler;
  if(typeof window !== 'undefined') window.StudyScheduler = StudyScheduler;
})();
