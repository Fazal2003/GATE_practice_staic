(function(){
  "use strict";

  const SS = window.StudyScheduler;
  const DECK_KEY = 'studycards.deck';
  const STATS_KEY = 'studycards.stats';
  const SCHEMA_VERSION = 2;

  let deck = { version: SCHEMA_VERSION, cards: [] };
  let stats = SS.defaults();

  const el = id => document.getElementById(id);

  function uid(){ return 'c_' + Math.random().toString(36).slice(2,10) + Date.now().toString(36); }

  // ---- storage -------------------------------------------------------------
  // Cards now carry a learning phase (state/step/lapses) on top of the old
  // ef/reps/interval/due fields, so SS.normalizeCard() fills in / migrates them.
  function loadData(){
    let rawDeck = null;
    try{
      rawDeck = localStorage.getItem(DECK_KEY);
      if(rawDeck){
        const parsed = JSON.parse(rawDeck);
        if(parsed && Array.isArray(parsed.cards)){
          deck = { version: parsed.version || 1, cards: parsed.cards.map(SS.normalizeCard) };
        }
      }
    }catch(e){
      // Never let a corrupt blob silently cost the deck: stash a copy first.
      console.error('deck load failed; keeping a backup copy', e);
      try{ if(rawDeck) localStorage.setItem(DECK_KEY + '.corrupt.' + Date.now(), rawDeck); }catch(e2){}
      deck = { version: SCHEMA_VERSION, cards: [] };
    }

    try{
      const parsed = JSON.parse(localStorage.getItem(STATS_KEY) || 'null');
      stats = Object.assign(SS.defaults(), (parsed && typeof parsed === 'object') ? parsed : {});
    }catch(e){
      stats = SS.defaults();
    }
    if(!stats.newByDay) stats.newByDay = { date: null, count: 0 };
  }

  function saveDeck(){
    try{ localStorage.setItem(DECK_KEY, JSON.stringify({ version: SCHEMA_VERSION, cards: deck.cards })); }
    catch(e){ console.error('deck save failed', e); }
  }

  function saveStats(){
    try{ localStorage.setItem(STATS_KEY, JSON.stringify(stats)); }
    catch(e){ console.error('stats save failed', e); }
  }

  // ---- deck management ----------------------------------------------------

  function addCards(list){
    deck.cards = deck.cards.concat(list);
    saveDeck();
    renderManage();
    renderHome();
  }

  // Import a parsed deck, skipping questions already in the deck so that
  // importing the same file twice can never reset existing progress.
  function importParsed(parsed){
    const known = Object.create(null);
    deck.cards.forEach(c => { known[SS.dedupeKey(c.q)] = true; });
    const fresh = [];
    let dupes = parsed.duplicates;
    parsed.cards.forEach(c => {
      const key = SS.dedupeKey(c.q);
      if(known[key]){ dupes += 1; return; }
      known[key] = true;
      fresh.push(SS.newCard(c.q, c.a, uid()));
    });
    if(fresh.length) addCards(fresh);
    return { added: fresh.length, dupes: dupes, malformed: parsed.malformed };
  }

  function importSummary(res){
    const bits = ['Added ' + res.added + ' card' + (res.added === 1 ? '' : 's') + '.'];
    if(res.dupes) bits.push('Skipped ' + res.dupes + ' duplicate' + (res.dupes === 1 ? '' : 's') + '.');
    if(res.malformed) bits.push(res.malformed + ' block' + (res.malformed === 1 ? '' : 's') + ' had no Q:/A: pair.');
    return bits.join(' ');
  }

  function loadSampleDeck(){
    fetch('data/gate-me-2026-deck.txt')
      .then(r => { if(!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then(text => { alert(importSummary(importParsed(SS.parseDeck(text)))); })
      .catch(err => {
        console.error('sample deck fetch failed', err);
        alert('Could not fetch the sample deck. Serve the folder over http:// (or use Import .txt File) and try again.');
      });
  }

  function exportDeck(){
    if(!deck.cards.length){ alert('Nothing to export yet.'); return; }
    const payload = JSON.stringify({
      version: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      stats: stats,
      cards: deck.cards
    }, null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'study-cards-' + new Date().toISOString().slice(0,10) + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function clearDeck(){
    if(!deck.cards.length){ alert('The deck is already empty.'); return; }
    if(!confirm('Delete all ' + deck.cards.length + ' cards, along with their review history? This cannot be undone.')) return;
    deck.cards = [];
    saveDeck();
    renderManage();
    renderHome();
  }

  // ---- session planning ---------------------------------------------------

  function studyOptions(){
    const now = Date.now();
    return { newPerDay: SS.CFG.NEW_PER_DAY, newIntroducedToday: SS.newIntroducedToday(stats, now) };
  }

  function sessionPlan(){ return SS.buildSessionQueue(deck.cards, Date.now(), studyOptions()); }

  function planNote(plan){
    if(!deck.cards.length) return 'No cards yet — paste a Q:/A: import or load the sample GATE deck.';
    const bits = [];
    if(plan.learning) bits.push(plan.learning + ' learning');
    if(plan.review) bits.push(plan.review + ' review');
    if(plan.newQueued) bits.push(plan.newQueued + ' new');
    if(!bits.length) return 'Nothing due right now — cards return as their intervals elapse.';
    let note = bits.join(' · ') + ' ready now';
    if(plan.newDeferred) note += ' · ' + plan.newDeferred + ' new held back (' + SS.CFG.NEW_PER_DAY + '/day limit)';
    return note;
  }

  function fmtDue(ts){
    if(!ts) return 'new';
    const diff = ts - Date.now();
    if(diff <= 0) return 'due now';
    if(diff < 60*60*1000) return 'in ' + Math.max(1, Math.round(diff/60000)) + 'm';
    if(diff < SS.DAY) return 'in ' + Math.max(1, Math.floor(diff/(60*60*1000))) + 'h';
    const days = Math.floor(diff/SS.DAY);
    if(days < 30) return 'in ' + Math.max(1, days) + 'd';
    if(days < 365) return 'in ' + Math.round(days/30) + 'mo';
    return 'in ' + (days/365).toFixed(1) + 'y';
  }

  function stateLabel(card){
    if(card.state === 'new') return 'brand new card';
    if(card.state === 'relearning') return 'relearning after a lapse';
    if(card.state === 'learning') return 'learning step ' + (card.step + 1) + ' of ' + SS.stepsFor(card.state).length;
    return 'ease ' + card.ef.toFixed(2) + (card.lapses ? ' · ' + card.lapses + ' lapse' + (card.lapses === 1 ? '' : 's') : '');
  }

  // ---- rendering ----------------------------------------------------------

  function renderHome(){
    const plan = sessionPlan();
    el('statDue').textContent = plan.queue.length;
    el('statTotal').textContent = deck.cards.length;
    el('statStreak').textContent = stats.streak || 0;
    el('statReviews').textContent = stats.totalReviews || 0;
    el('planNote').textContent = planNote(plan);
    el('btnStart').disabled = plan.queue.length === 0;
  }

  function renderManage(){
    el('deckCount').textContent = deck.cards.length;
    const list = el('cardList');
    list.innerHTML = '';
    if(deck.cards.length === 0){
      list.innerHTML = '<div class="empty-note">No cards yet. Add one above, or paste a bulk import to get started.</div>';
      return;
    }
    deck.cards.slice().reverse().forEach(c => {
      const row = document.createElement('div');
      row.className = 'card-row';
      row.innerHTML = '<div class="q">' + escapeHtml(c.q) + '</div>'
        + '<div class="due-tag" title="' + escapeHtml(stateLabel(c)) + '">' + fmtDue(c.due) + '</div>'
        + '<button class="del" data-id="' + escapeHtml(c.id) + '">✕</button>';
      list.appendChild(row);
    });
    list.querySelectorAll('.del').forEach(btn => {
      btn.addEventListener('click', () => {
        deck.cards = deck.cards.filter(c => c.id !== btn.dataset.id);
        saveDeck();
        renderManage();
        renderHome();
      });
    });
  }

  function escapeHtml(s){
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // ---- screens ------------------------------------------------------------

  function showScreen(id){
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    el(id).classList.add('active');
  }

  // ---- study session ------------------------------------------------------

  const TIMER_SECONDS = 120;
  let session = {
    queue: [], index: 0, revealed: false, locked: false, graded: 0,
    results: { again: 0, hard: 0, good: 0, easy: 0 },
    repsByCard: Object.create(null), newDeferred: 0, timerId: null, timeLeft: TIMER_SECONDS
  };

  function startStudy(){
    const plan = sessionPlan();
    // buildSessionQueue already puts learning steps first, then due reviews,
    // then the day's new-card allowance - no reshuffle here.
    session.queue = plan.queue.slice();
    session.index = 0;
    session.graded = 0;
    session.revealed = false;
    session.locked = false;
    session.repsByCard = Object.create(null);
    session.results = { again: 0, hard: 0, good: 0, easy: 0 };
    session.newDeferred = plan.newDeferred;
    if(session.queue.length === 0){ showScreen('screen-home'); return; }
    showScreen('screen-study');
    loadCard();
  }

  function loadCard(){
    clearInterval(session.timerId);
    session.timeLeft = TIMER_SECONDS;
    session.revealed = false;
    session.locked = false;
    const card = session.queue[session.index];
    el('studyProgress').textContent = (session.index + 1) + ' / ' + session.queue.length;
    el('questionText').textContent = card.q;
    el('answerText').textContent = card.a;
    el('answerBlock').classList.remove('show');
    el('revealWrap').style.display = 'block';
    el('gradeRow').style.display = 'none';
    el('timerDisplay').classList.remove('warn');
    updateTimerDisplay();

    session.timerId = setInterval(() => {
      session.timeLeft -= 1;
      updateTimerDisplay();
      if(session.timeLeft <= 15) el('timerDisplay').classList.add('warn');
      if(session.timeLeft <= 0){
        clearInterval(session.timerId);
        revealAnswer();
      }
    }, 1000);

    el('gradeRow').querySelectorAll('.stamp-btn').forEach(btn => {
      btn.querySelector('.interval').textContent = SS.previewInterval(card, btn.dataset.grade);
      btn.title = SS.previewDueLabel(card, btn.dataset.grade);
    });
  }

  function updateTimerDisplay(){
    const t = Math.max(0, session.timeLeft);
    const m = Math.floor(t/60), s = t%60;
    el('timerDisplay').textContent = m + ':' + String(s).padStart(2,'0');
  }

  function revealAnswer(){
    if(session.revealed) return;
    session.revealed = true;
    clearInterval(session.timerId);
    el('timerDisplay').classList.remove('warn');
    el('answerBlock').classList.add('show');
    el('revealWrap').style.display = 'none';
    el('gradeRow').style.display = 'grid';
  }

  function gradeCard(grade){
    if(!session.revealed || session.locked) return;
    session.locked = true;

    const queued = session.queue[session.index];
    const card = deck.cards.find(c => c.id === queued.id) || queued;
    const now = Date.now();
    const wasNew = card.state === 'new';

    SS.schedule(card, grade, now);
    if(wasNew){
      SS.recordNewIntroduced(stats, now);
      saveStats();
    }

    session.results[grade] = (session.results[grade] || 0) + 1;
    session.graded += 1;
    saveDeck();

    // Still on a learning step? Bring it back later in this same session so the
    // 1m/10m relearning actually happens instead of being pushed to tomorrow.
    if(SS.isLearningPhase(card)){
      const reps = session.repsByCard[card.id] || 0;
      if(reps < SS.CFG.MAX_INTRADAY_REPS){
        session.repsByCard[card.id] = reps + 1;
        session.queue.push(card);
      }
    }

    session.index += 1;
    session.locked = false;
    if(session.index >= session.queue.length) finishSession();
    else loadCard();
  }

  function finishSession(){
    clearInterval(session.timerId);
    const now = Date.now();
    const distinct = new Set(session.queue.map(c => c.id)).size;

    if(session.graded > 0){
      SS.touchStreak(stats, now);
      stats.totalReviews = (stats.totalReviews || 0) + session.graded;
      saveStats();
    }

    el('sumReviewed').textContent = session.graded;
    el('sumStreak').textContent = stats.streak || 0;

    const bd = el('sumBreakdown');
    bd.innerHTML = '';
    const colors = { again:'var(--rust)', hard:'#8a5a1f', good:'var(--forest)', easy:'#2c6f8e' };
    Object.entries(session.results).forEach(([k,v]) => {
      const d = document.createElement('div');
      d.className = 'bd-item';
      d.innerHTML = '<div class="n" style="color:' + colors[k] + '">' + v + '</div><div class="l">' + k + '</div>';
      bd.appendChild(d);
    });

    const plan = sessionPlan();
    const bits = [];
    if(session.graded !== distinct) bits.push(session.graded + ' answers across ' + distinct + ' cards');
    if(plan.learning) bits.push(plan.learning + ' still mid-step');
    if(plan.queue.length) bits.push(plan.queue.length + ' due again already');
    if(session.newDeferred) bits.push(session.newDeferred + ' new held back for tomorrow (' + SS.CFG.NEW_PER_DAY + '/day)');
    el('sumNote').textContent = bits.join(' · ');

    showScreen('screen-summary');
    renderHome();
  }

  function endSessionEarly(){
    // Count the work already done instead of throwing the streak away.
    if(session.graded > 0){ finishSession(); return; }
    clearInterval(session.timerId);
    showScreen('screen-home');
    renderHome();
  }

  // ---- wire up ------------------------------------------------------------

  document.addEventListener('DOMContentLoaded', () => {
    loadData();
    renderHome();
    renderManage();
    setInterval(() => { el('clockNow').textContent = new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }); }, 1000);

    el('btnStart').addEventListener('click', startStudy);
    el('btnManage').addEventListener('click', () => { renderManage(); showScreen('screen-manage'); });
    el('linkHowImport').addEventListener('click', () => { renderManage(); showScreen('screen-manage'); });
    el('btnBackHome').addEventListener('click', () => { renderHome(); showScreen('screen-home'); });
    el('btnBackHome2').addEventListener('click', () => { renderHome(); showScreen('screen-home'); });

    el('btnAddCard').addEventListener('click', () => {
      const q = el('newQ').value.trim();
      const a = el('newA').value.trim();
      if(!q || !a) return;
      addCards([SS.newCard(q, a, uid())]);
      el('newQ').value = '';
      el('newA').value = '';
    });

    el('btnBulkImport').addEventListener('click', () => {
      const text = el('bulkText').value;
      if(!text.trim()){ alert('Paste some Q:/A: text first.'); return; }
      const res = importParsed(SS.parseDeck(text));
      if(res.added === 0){
        alert('Nothing new to import. ' + importSummary(res));
        return;
      }
      el('bulkText').value = '';
      alert(importSummary(res));
    });

    el('btnFileImportTrigger').addEventListener('click', () => el('fileImport').click());
    el('fileImport').addEventListener('change', (e) => {
      const file = e.target.files[0];
      if(!file) return;
      const reader = new FileReader();
      reader.onload = (evt) => { alert(importSummary(importParsed(SS.parseDeck(evt.target.result)))); };
      reader.readAsText(file);
      e.target.value = '';
    });

    el('btnLoadSample').addEventListener('click', loadSampleDeck);
    el('btnExportDeck').addEventListener('click', exportDeck);
    el('btnClearDeck').addEventListener('click', clearDeck);

    el('btnReveal').addEventListener('click', revealAnswer);
    el('gradeRow').addEventListener('click', (e) => {
      const btn = e.target.closest('.stamp-btn');
      if(btn) gradeCard(btn.dataset.grade);
    });
    el('btnExitStudy').addEventListener('click', endSessionEarly);

    document.addEventListener('keydown', (e) => {
      if(e.repeat) return;
      if(!el('screen-study').classList.contains('active')) return;
      if(e.code === 'Space'){
        e.preventDefault();
        if(session.revealed) gradeCard('good');
        else revealAnswer();
        return;
      }
      if(!session.revealed) return;
      if(e.key === '1') gradeCard('again');
      if(e.key === '2') gradeCard('hard');
      if(e.key === '3') gradeCard('good');
      if(e.key === '4') gradeCard('easy');
    });
  });
})();

