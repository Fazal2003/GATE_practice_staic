#!/usr/bin/env node
/* Unit tests for js/scheduler.js. Run with: node scripts/test_scheduler.js
 *
 * These cover the bugs that made the old scheduler drift:
 *   - Card.interval could freeze forever at 1 day (Math.round(ivl * ef)).
 *   - "Hard" could not grow an interval below 3 days and drained ease to 1.3.
 *   - "Hard" straight after "Again" jumped to 1 day, skipping the relearning step.
 *   - Intervals were measured from the exact minute you graded a card, so a
 *     card answered at 23:55 was due at 23:55 the next day.
 */
"use strict";

var path = require('path');
var SS = require(path.join(__dirname, '..', 'js', 'scheduler.js'));

var passed = 0;
var failures = [];

function test(name, fn){
  try { fn(); passed++; console.log('ok   ' + name); }
  catch(e){ failures.push(name + ': ' + e.message); console.log('FAIL ' + name + ' -> ' + e.message); }
}
function eq(actual, expected, msg){
  if(actual !== expected) throw new Error((msg || 'value') + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
}
function ok(cond, msg){ if(!cond) throw new Error(msg || 'expected a truthy value'); }
function near(actual, expected, tol, msg){
  if(!(Math.abs(actual - expected) <= tol)) throw new Error((msg || 'value') + ': expected ~' + expected + ', got ' + actual);
}
function card(over){
  return Object.assign({ id: 'c1', q: 'question', a: 'answer' }, over || {});
}
function reviewCard(over){
  return card(Object.assign({ state: 'review', reps: 3, interval: 10, ef: 2.5, due: 0 }, over || {}));
}

// Fixed local timestamps so the day-boundary maths stays deterministic.
function T(h, m, day){ return new Date(2026, 0, day || 15, h, m || 0, 0, 0).getTime(); }

console.log('--- new-card learning steps -------------------------------------------');

test('a brand new card is due immediately and starts on step 0', function(){
  var c = SS.newCard('q', 'a', '1');
  eq(c.state, 'new');
  eq(c.step, 0);
  eq(c.due, 0);
  eq(c.ef, 2.5);
  ok(SS.isDue(c, T(9)), 'new card should be due');
});

test('first Good on a new card goes to the 10m step, not a full day', function(){
  var c = SS.newCard('q', 'a', '1');
  SS.schedule(c, 'good', T(9));
  eq(c.state, 'learning');
  eq(c.step, 1);
  near(c.interval, 10 / 1440, 1e-9, 'interval in days');
  eq(c.due - T(9), 10 * SS.MINUTE);
});

test('second Good graduates the card to 1 day', function(){
  var c = SS.newCard('q', 'a', '1');
  SS.schedule(c, 'good', T(9));
  SS.schedule(c, 'good', T(9));
  eq(c.state, 'review');
  eq(c.interval, 1);
  eq(c.reps, 1);
  eq(c.due, new Date(2026, 0, 16, 4, 0, 0, 0).getTime(), 'due at the next study-day start');
});

test('Again on a new card returns to the 1m step and keeps ease', function(){
  var c = SS.newCard('q', 'a', '1');
  SS.schedule(c, 'again', T(9));
  eq(c.state, 'learning');
  eq(c.step, 0);
  eq(c.due - T(9), 1 * SS.MINUTE);
  eq(c.ef, 2.5, 'a first look at a card must not cost ease');
});

test('Hard on a new card repeats the current step instead of jumping a day', function(){
  var c = SS.newCard('q', 'a', '1');
  SS.schedule(c, 'hard', T(9));
  eq(c.step, 0);
  eq(c.due - T(9), 1 * SS.MINUTE);
  eq(c.ef, 2.5);
});

test('Easy on a new card graduates straight to 4 days with an ease bonus', function(){
  var c = SS.newCard('q', 'a', '1');
  SS.schedule(c, 'easy', T(9));
  eq(c.state, 'review');
  eq(c.interval, 4);
  eq(c.ef, 2.65);
});


console.log('--- review growth (freeze regressions) --------------------------------');

test('ease hell: a 1-day card at minimum ease still grows', function(){
  var c = reviewCard({ interval: 1, ef: 1.3 });
  var seen = [];
  for(var i = 0; i < 5; i++){
    var before = c.interval;
    SS.schedule(c, 'good', T(9));
    ok(c.interval > before, 'interval froze at ' + before + ' days');
    seen.push(c.interval);
  }
  eq(seen.join(','), '2,3,4,5,7', 'max(ivl+1, round(ivl*ef))');
});

test('Hard always grows the interval, even at 1 and 2 days', function(){
  [1, 2, 3].forEach(function(start){
    var c = reviewCard({ interval: start, ef: 1.3 });
    SS.schedule(c, 'hard', T(9));
    ok(c.interval > start, 'hard on a ' + start + 'd card left it at ' + c.interval + 'd');
  });
});

test('Hard grows slower than Good, which grows slower than Easy', function(){
  var base = { interval: 10, ef: 2.5 };
  var hard = SS.schedule(reviewCard(base), 'hard', T(9)).interval;
  var good = SS.schedule(reviewCard(base), 'good', T(9)).interval;
  var easy = SS.schedule(reviewCard(base), 'easy', T(9)).interval;
  ok(hard < good && good < easy, 'expected hard(' + hard + ') < good(' + good + ') < easy(' + easy + ')');
});

test('review ease moves the way SM-2 says it should', function(){
  eq(SS.schedule(reviewCard({ ef: 2.5 }), 'hard', T(9)).ef, 2.35);
  eq(SS.schedule(reviewCard({ ef: 2.5 }), 'good', T(9)).ef, 2.5);
  eq(SS.schedule(reviewCard({ ef: 2.5 }), 'easy', T(9)).ef, 2.65);
});

test('ease is clamped to [1.3, 3.5] and intervals to 36500 days', function(){
  eq(SS.schedule(reviewCard({ ef: 1.35 }), 'hard', T(9)).ef, 1.3);
  eq(SS.schedule(reviewCard({ ef: 3.45 }), 'easy', T(9)).ef, 3.5);
  eq(SS.schedule(reviewCard({ interval: 30000, ef: 3.5 }), 'easy', T(9)).interval, SS.CFG.MAX_INTERVAL_DAYS);
});

console.log('--- lapses ------------------------------------------------------------');

test('Again on a review card lapses it into a 10m relearning step, once', function(){
  var c = reviewCard({ interval: 90, ef: 2.5, reps: 10 });
  SS.schedule(c, 'again', T(9));
  eq(c.state, 'relearning');
  eq(c.lapses, 1);
  eq(c.ef, 2.3, 'one lapse = one ease penalty');
  near(c.interval, 10 / 1440, 1e-9, 'interval in days');
  eq(c.due - T(9), 10 * SS.MINUTE);
  eq(c.reps, 0);
});

test('Hard straight after a lapse stays on the 10m step (no jump to a day)', function(){
  var c = reviewCard({ interval: 90, ef: 2.5, reps: 10 });
  SS.schedule(c, 'again', T(9));
  SS.schedule(c, 'hard', T(9));
  eq(c.state, 'relearning');
  eq(c.due - T(9), 10 * SS.MINUTE);
  eq(c.ef, 2.3, 'the lapse penalty must not be applied twice');
});

test('Good after relearning graduates back into the review queue', function(){
  var c = reviewCard({ interval: 90, ef: 2.5, reps: 10 });
  SS.schedule(c, 'again', T(9));
  SS.schedule(c, 'good', T(9));
  eq(c.state, 'review');
  eq(c.interval, 1);
  eq(c.due, new Date(2026, 0, 16, 4, 0, 0, 0).getTime());
});

test('LAPSE_NEW_INTERVAL_FACTOR can keep part of a mature interval', function(){
  var original = SS.CFG.LAPSE_NEW_INTERVAL_FACTOR;
  SS.CFG.LAPSE_NEW_INTERVAL_FACTOR = 0.5;
  try {
    var c = reviewCard({ interval: 90, ef: 2.5, reps: 10 });
    SS.schedule(c, 'again', T(9));
    SS.schedule(c, 'good', T(9));
    eq(c.interval, 45);
  } finally {
    SS.CFG.LAPSE_NEW_INTERVAL_FACTOR = original;
  }
});

console.log('--- study-day boundaries ----------------------------------------------');

test('a card graded at 23:55 lands on a 04:00 study-day boundary', function(){
  var c = reviewCard({ interval: 1 });
  SS.schedule(c, 'good', T(23, 55, 15));
  var due = new Date(c.due);
  eq(c.interval, 3, 'max(ivl+1, round(ivl*ef)) = 3');
  eq(due.getHours(), 4, 'never due at the minute you graded it');
  eq(due.getMinutes(), 0);
  eq(due.getDate(), 18);
  eq(due.getMonth(), 0);
});

test('grading at 02:00 belongs to the previous study day', function(){
  var beforeMidnight = reviewCard({ interval: 1 });
  var afterMidnight = reviewCard({ interval: 1 });
  SS.schedule(beforeMidnight, 'good', T(22, 0, 15));
  SS.schedule(afterMidnight, 'good', T(2, 0, 16));
  eq(afterMidnight.due, beforeMidnight.due, '02:00 on the 16th is still the 15th study day');
  eq(beforeMidnight.due, new Date(2026, 0, 18, 4, 0, 0, 0).getTime());
});

test('learning steps stay at minute precision, not day boundaries', function(){
  var c = SS.newCard('q', 'a', '1');
  SS.schedule(c, 'good', T(23, 55, 15));
  eq(c.due - T(23, 55, 15), 10 * SS.MINUTE);
});

console.log('--- previews ----------------------------------------------------------');

test('previewInterval reports exactly what schedule would store', function(){
  var shapes = [
    SS.newCard('q', 'a', '1'),
    reviewCard({ interval: 1, ef: 1.3 }),
    reviewCard({ interval: 90, ef: 2.5 }),
    card({ state: 'relearning', step: 0, interval: 10 / 1440, ef: 2.3 })
  ];
  shapes.forEach(function(c){
    ['again', 'hard', 'good', 'easy'].forEach(function(g){
      var stored = SS.formatInterval(SS.previewCard(c, g, T(9)).interval);
      eq(SS.previewInterval(c, g, T(9)), stored, 'preview for ' + g);
    });
  });
});

test('previewing never mutates the card', function(){
  var c = reviewCard({ interval: 90, ef: 2.5, reps: 10 });
  var before = JSON.stringify(c);
  ['again', 'hard', 'good', 'easy'].forEach(function(g){ SS.previewInterval(c, g, T(9)); });
  eq(JSON.stringify(c), before);
});

test('formatInterval labels the scale the way the buttons show it', function(){
  eq(SS.formatInterval(1 / 1440), '1m');
  eq(SS.formatInterval(10 / 1440), '10m');
  eq(SS.formatInterval(0.5), '12h');
  eq(SS.formatInterval(1), '1d');
  eq(SS.formatInterval(44), '44d');
  eq(SS.formatInterval(45), '1.5mo');
  eq(SS.formatInterval(60), '2mo');
  eq(SS.formatInterval(400), '1.1y');
  eq(SS.formatInterval(0), 'now');
});

console.log('--- migrating cards saved by the old scheduler -------------------------');

test('an untouched card from the old app becomes a new card on step 0', function(){
  var c = SS.normalizeCard({ id: 'x', q: 'q', a: 'a', ef: 2.5, reps: 0, interval: 0, due: 0 });
  eq(c.state, 'new');
  eq(c.step, 0);
  var after = SS.schedule(c, 'good', T(9));
  eq(after.interval, 10 / 1440, 'legacy new cards must still walk the learning steps');
});

test('a card the old app had lapsed (10m, reps 0) graduates on the next Good', function(){
  var c = SS.normalizeCard({ id: 'x', q: 'q', a: 'a', ef: 2.3, reps: 0, interval: 10 / 1440, due: T(9) });
  eq(c.state, 'learning');
  eq(c.step, 1, 'sits on the last learning step');
  eq(SS.schedule(c, 'good', T(9)).interval, 1);
});

test('a mature card keeps its interval and gain', function(){
  var c = SS.normalizeCard({ id: 'x', q: 'q', a: 'a', ef: 2.5, reps: 5, interval: 30, due: T(9) });
  eq(c.state, 'review');
  eq(SS.schedule(c, 'good', T(9)).interval, 75);
});

test('junk input cannot poison the state machine', function(){
  var c = SS.normalizeCard({ id: 'x', q: 'q', a: 'a', state: 'constructor', ef: 'x', reps: null, interval: NaN, due: 'soon' });
  eq(c.state, 'new');
  eq(c.ef, 2.5);
  eq(c.reps, 0);
  eq(c.interval, 0);
  eq(c.due, 0);
  eq(SS.isLearningPhase(c), true);
  eq(SS.isLearningPhase({ state: 'toString' }), false, 'prototype keys are not states');
});

console.log('--- session queue -----------------------------------------------------');

function queueFixture(){
  var now = T(9);
  var cards = [];
  for(var i = 0; i < 25; i++) cards.push(SS.newCard('new ' + i, 'a', 'n' + i));
  cards.push(reviewCard({ id: 'r1', due: now - 60000 }));
  cards.push(reviewCard({ id: 'r2', due: now + 10 * SS.DAY }));
  cards.push(card({ id: 'l1', state: 'learning', step: 1, interval: 10 / 1440, ef: 2.5, due: now - 5000 }));
  cards.push(card({ id: 'l2', state: 'learning', step: 1, interval: 10 / 1440, ef: 2.5, due: now - 60000 }));
  return { cards: cards, now: now };
}

test('the queue is learning first, then reviews, then a new-card allowance', function(){
  var f = queueFixture();
  var plan = SS.buildSessionQueue(f.cards, f.now, { newPerDay: 20, newIntroducedToday: 0 });
  eq(plan.learning, 2);
  eq(plan.review, 1, 'only the due review counts');
  eq(plan.new, 25);
  eq(plan.newQueued, 20);
  eq(plan.newDeferred, 5);
  eq(plan.queue.length, 23);
  eq(plan.queue[0].id, 'l2', 'learning cards ordered by due date');
  eq(plan.queue[1].id, 'l1');
  eq(plan.queue[2].id, 'r1');
});

test('the new-card allowance shrinks as cards are introduced today', function(){
  var f = queueFixture();
  var plan = SS.buildSessionQueue(f.cards, f.now, { newPerDay: 20, newIntroducedToday: 15 });
  eq(plan.newQueued, 5);
  eq(plan.newDeferred, 20);
});

test('a fresh deck is capped at NEW_PER_DAY by default', function(){
  var cards = [];
  for(var i = 0; i < 65; i++) cards.push(SS.newCard('q' + i, 'a' + i, 'n' + i));
  var plan = SS.buildSessionQueue(cards, T(9), {});
  eq(plan.queue.length, SS.CFG.NEW_PER_DAY);
  eq(plan.newDeferred, 65 - SS.CFG.NEW_PER_DAY);
});

test('cards that are not due yet stay out of the queue', function(){
  var f = queueFixture();
  var plan = SS.buildSessionQueue(f.cards, f.now, { newPerDay: 0, newIntroducedToday: 0 });
  eq(plan.newQueued, 0);
  var ids = plan.queue.map(function(c){ return c.id; });
  ok(ids.indexOf('r2') === -1, 'r2 is 10 days away');
});

test('shuffling is injectable so queue order is reproducible', function(){
  var f = queueFixture();
  var rng = function(){ return 0; };
  var ids = function(){
    return SS.buildSessionQueue(f.cards, f.now, { newPerDay: 3, rng: rng })
      .queue.map(function(c){ return c.id; }).join(',');
  };
  eq(ids(), ids(), 'the same seed must give the same order');
  eq(ids(), 'l2,l1,r1,n1,n2,n3');
});

console.log('--- deck parsing ------------------------------------------------------');

test('parses LF and CRLF decks with --- or blank-line separators', function(){
  var lf = 'Q: one\nA: 1\n---\nQ: two\nA: 2\n';
  var crlf = 'Q: one\r\nA: 1\r\n\r\nQ: two\r\nA: 2\r\n';
  [lf, crlf].forEach(function(text){
    var res = SS.parseDeck(text);
    eq(res.cards.length, 2, text.indexOf('\r') >= 0 ? 'crlf deck' : 'lf deck');
    eq(res.cards[0].q, 'one');
    eq(res.cards[1].a, '2');
    eq(res.malformed, 0);
  });
});

test('multi-line answers survive, and blank lines with spaces still split', function(){
  var res = SS.parseDeck('Q: multi\nA: line one\nline two\n   \nQ: second\nA: two');
  eq(res.cards.length, 2);
  eq(res.cards[0].a, 'line one\nline two');
  eq(res.cards[1].q, 'second');
});

test('duplicate questions are counted, not imported twice', function(){
  var res = SS.parseDeck('Q: Same\nA: 1\n---\nQ: same\nA: 2');
  eq(res.cards.length, 1);
  eq(res.duplicates, 1);
  eq(SS.dedupeKey('  Same\nQuestion '), SS.dedupeKey('same question'));
});

test('blocks without a Q:/A: pair are reported as malformed', function(){
  var res = SS.parseDeck('just some prose\n\nQ: has no answer\n\nQ: ok\nA: fine');
  eq(res.cards.length, 1);
  eq(res.cards[0].q, 'ok');
  eq(res.malformed, 2);
});

test('an empty or missing deck is handled without throwing', function(){
  [ '', '   ', null, undefined, 42 ].forEach(function(v){
    var res = SS.parseDeck(v);
    eq(res.cards.length, 0);
  });
});

test('the bundled GATE deck parses cleanly', function(){
  var fs = require('fs');
  var text = fs.readFileSync(path.join(__dirname, '..', 'data', 'gate-me-2026-deck.txt'), 'utf8');
  var res = SS.parseDeck(text);
  ok(res.cards.length >= 60, 'expected the sample deck to yield 60+ cards, got ' + res.cards.length);
  eq(res.malformed, 0);
  eq(res.duplicates, 0);
});

console.log('--- streak and daily new-card bookkeeping ------------------------------');

test('the streak counts consecutive study days and resets after a gap', function(){
  var s = SS.defaults();
  eq(SS.touchStreak(s, T(10, 0, 15)), 1, 'first ever session');
  eq(SS.touchStreak(s, T(10, 0, 15)), 1, 'idempotent within a day');
  eq(SS.touchStreak(s, T(10, 0, 16)), 2);
  eq(SS.touchStreak(s, T(10, 0, 17)), 3);
  var fresh = SS.defaults();
  SS.touchStreak(fresh, T(10, 0, 15));
  eq(SS.touchStreak(fresh, T(10, 0, 18)), 1, 'a skipped day breaks the streak');
});

test('a session that runs past midnight stays one study day', function(){
  var s = SS.defaults();
  eq(SS.touchStreak(s, T(22, 0, 15)), 1);
  eq(SS.touchStreak(s, T(2, 0, 16)), 1, '02:00 still belongs to the 15th');
  eq(SS.touchStreak(s, T(9, 0, 16)), 2, 'after the 04:00 rollover it is a new day');
});

test('new cards introduced today are counted per study day', function(){
  var s = SS.defaults();
  eq(SS.newIntroducedToday(s, T(9, 0, 15)), 0);
  eq(SS.recordNewIntroduced(s, T(9, 0, 15)), 1);
  eq(SS.recordNewIntroduced(s, T(10, 0, 15)), 2);
  eq(SS.newIntroducedToday(s, T(11, 0, 15)), 2);
  eq(SS.newIntroducedToday(s, T(9, 0, 16)), 0, 'the counter resets on the next study day');
  eq(SS.recordNewIntroduced(s, T(9, 0, 16)), 1);
});

test('defaults() hands back a fresh, fully populated stats object', function(){
  var a = SS.defaults();
  a.streak = 9;
  a.newByDay.count = 9;
  var b = SS.defaults();
  eq(b.streak, 0);
  eq(b.newByDay.count, 0);
  ok(b.newByDay !== a.newByDay, 'newByDay must not be shared between objects');
});

test('isDue treats a missing due date as available now', function(){
  ok(SS.isDue({ due: 0 }, T(9)), 'due 0 means "new"');
  ok(SS.isDue({}, T(9)), 'missing due means available');
  ok(SS.isDue({ due: T(9) }, T(9)), 'due exactly now is due');
  ok(!SS.isDue({ due: T(10) }, T(9)), 'due in an hour is not due');
});

console.log('');
console.log(passed + ' passed, ' + failures.length + ' failed');
if(failures.length){
  failures.forEach(function(f){ console.log('  - ' + f); });
  process.exit(1);
}
