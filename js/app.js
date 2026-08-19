(function(){
  "use strict";

  const DAY = 24*60*60*1000;
  const DECK_KEY = 'studycards.deck';
  const STATS_KEY = 'studycards.stats';

  let deck = { cards: [] };
  let stats = { streak: 0, lastStudyDate: null, totalReviews: 0 };

  const el = id => document.getElementById(id);

  function loadData(){
    try{
      const raw = localStorage.getItem(DECK_KEY);
      if(raw) deck = JSON.parse(raw);
    }catch(e){ deck = { cards: [] }; }
    try{
      const raw = localStorage.getItem(STATS_KEY);
      if(raw) stats = JSON.parse(raw);
    }catch(e){ stats = { streak:0, lastStudyDate:null, totalReviews:0 }; }
  }
  function saveDeck(){
    try{ localStorage.setItem(DECK_KEY, JSON.stringify(deck)); }
    catch(e){ console.error('deck save failed', e); }
  }
  function saveStats(){
    try{ localStorage.setItem(STATS_KEY, JSON.stringify(stats)); }
    catch(e){ console.error('stats save failed', e); }
  }

  function uid(){ return 'c_' + Math.random().toString(36).slice(2,10) + Date.now().toString(36); }

  function dueCards(){
    const now = Date.now();
    return deck.cards.filter(c => !c.due || c.due <= now);
  }

  function fmtDue(ts){
    if(!ts) return 'new';
    const diff = ts - Date.now();
    if(diff <= 0) return 'due now';
    const mins = diff/60000;
    if(mins < 60) return 'in ' + Math.round(mins) + 'm';
    const hrs = mins/60;
    if(hrs < 24) return 'in ' + Math.round(hrs) + 'h';
    return 'in ' + Math.round(hrs/24) + 'd';
  }

  // ---- SM-2 style scheduler ----
  function schedule(card, grade){
    if(card.ef === undefined) card.ef = 2.5;
    if(card.reps === undefined) card.reps = 0;
    if(card.interval === undefined) card.interval = 0;

    if(grade === 'again'){
      card.reps = 0;
      card.ef = Math.max(1.3, card.ef - 0.2);
      card.interval = 10/1440; // 10 minutes, expressed in days
    } else {
      card.reps += 1;
      if(grade === 'hard'){
        card.ef = Math.max(1.3, card.ef - 0.15);
        card.interval = card.reps === 1 ? 1 : Math.max(1, Math.round(card.interval * 1.2));
      } else if(grade === 'good'){
        if(card.reps === 1) card.interval = 1;
        else if(card.reps === 2) card.interval = 3;
        else card.interval = Math.round(card.interval * card.ef);
      } else if(grade === 'easy'){
        card.ef = card.ef + 0.15;
        if(card.reps === 1) card.interval = 4;
        else card.interval = Math.round(card.interval * card.ef * 1.3);
      }
    }
    card.due = Date.now() + card.interval * DAY;
    return card;
  }

  function previewInterval(card, grade){
    const clone = JSON.parse(JSON.stringify(card || {}));
    schedule(clone, grade);
    const days = clone.interval;
    if(days < 1/24) return Math.round(days*1440) + 'm';
    if(days < 1) return Math.round(days*24) + 'h';
    if(days < 30) return Math.round(days) + 'd';
    return Math.round(days/30) + 'mo';
  }

  // ---- rendering ----
  function renderHome(){
    el('statDue').textContent = dueCards().length;
    el('statTotal').textContent = deck.cards.length;
    el('statStreak').textContent = stats.streak || 0;
    el('btnStart').disabled = dueCards().length === 0;
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
      row.innerHTML = `<div class="q">${escapeHtml(c.q)}</div><div class="due-tag">${fmtDue(c.due)}</div><button class="del" data-id="${c.id}">✕</button>`;
      list.appendChild(row);
    });
    list.querySelectorAll('.del').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        deck.cards = deck.cards.filter(c=>c.id !== btn.dataset.id);
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

  // ---- screens ----
  function showScreen(id){
    document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
    el(id).classList.add('active');
  }

  // ---- study session state ----
  let session = { queue: [], index: 0, revealed:false, results:{again:0,hard:0,good:0,easy:0}, timerId:null, timeLeft:120 };

  function startStudy(){
    session.queue = dueCards().slice();
    for(let i=session.queue.length-1;i>0;i--){
      const j = Math.floor(Math.random()*(i+1));
      [session.queue[i],session.queue[j]] = [session.queue[j],session.queue[i]];
    }
    session.index = 0;
    session.results = {again:0,hard:0,good:0,easy:0};
    if(session.queue.length === 0){ showScreen('screen-home'); return; }
    showScreen('screen-study');
    loadCard();
  }

  function loadCard(){
    clearInterval(session.timerId);
    session.timeLeft = 120;
    session.revealed = false;
    const card = session.queue[session.index];
    el('studyProgress').textContent = (session.index+1) + ' / ' + session.queue.length;
    el('questionText').textContent = card.q;
    el('answerText').textContent = card.a;
    el('answerBlock').classList.remove('show');
    el('revealWrap').style.display = 'block';
    el('gradeRow').style.display = 'none';
    updateTimerDisplay();
    el('timerDisplay').classList.remove('warn');

    session.timerId = setInterval(()=>{
      session.timeLeft--;
      updateTimerDisplay();
      if(session.timeLeft <= 15) el('timerDisplay').classList.add('warn');
      if(session.timeLeft <= 0){
        clearInterval(session.timerId);
        revealAnswer();
      }
    },1000);

    ['again','hard','good','easy'].forEach(g=>{
      const map = {again:'ivAgain',hard:'ivHard',good:'ivGood',easy:'ivEasy'};
      el(map[g]).textContent = previewInterval(card, g);
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
    el('answerBlock').classList.add('show');
    el('revealWrap').style.display = 'none';
    el('gradeRow').style.display = 'grid';
  }

  function gradeCard(grade){
    const card = session.queue[session.index];
    const realCard = deck.cards.find(c=>c.id === card.id);
    schedule(realCard, grade);
    session.results[grade]++;
    saveDeck();

    session.index++;
    if(session.index >= session.queue.length){
      finishSession();
    } else {
      loadCard();
    }
  }

  function finishSession(){
    clearInterval(session.timerId);
    const today = new Date().toDateString();
    if(stats.lastStudyDate !== today){
      const yest = new Date(Date.now()-DAY).toDateString();
      stats.streak = (stats.lastStudyDate === yest) ? (stats.streak||0)+1 : 1;
      stats.lastStudyDate = today;
    }
    stats.totalReviews = (stats.totalReviews||0) + session.queue.length;
    saveStats();

    el('sumReviewed').textContent = session.queue.length;
    el('sumStreak').textContent = stats.streak;
    const bd = el('sumBreakdown');
    bd.innerHTML = '';
    const colors = {again:'var(--rust)',hard:'#8a5a1f',good:'var(--forest)',easy:'#2c6f8e'};
    Object.entries(session.results).forEach(([k,v])=>{
      const d = document.createElement('div');
      d.className = 'bd-item';
      d.innerHTML = `<div class="n" style="color:${colors[k]}">${v}</div><div class="l">${k}</div>`;
      bd.appendChild(d);
    });
    showScreen('screen-summary');
    renderHome();
  }

  function endSessionEarly(){
    clearInterval(session.timerId);
    showScreen('screen-home');
    renderHome();
  }

  // ---- bulk import parsing ----
  function parseBulk(text){
    const cards = [];
    const blocks = text.split(/\n\s*---\s*\n|\n{2,}/);
    blocks.forEach(block=>{
      const qm = block.match(/Q:\s*([\s\S]*?)(?:\nA:|$)/i);
      const am = block.match(/A:\s*([\s\S]*)/i);
      if(qm && am){
        const q = qm[1].trim();
        const a = am[1].trim();
        if(q && a) cards.push({id:uid(), q, a, ef:2.5, reps:0, interval:0, due:0});
      }
    });
    return cards;
  }

  // ---- wire up ----
  document.addEventListener('DOMContentLoaded', ()=>{
    loadData();
    renderHome();
    renderManage();
    setInterval(()=>{ el('clockNow').textContent = new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}); },1000);

    el('btnStart').addEventListener('click', startStudy);
    el('btnManage').addEventListener('click', ()=>{ renderManage(); showScreen('screen-manage'); });
    el('linkHowImport').addEventListener('click', ()=>{ renderManage(); showScreen('screen-manage'); });
    el('btnBackHome').addEventListener('click', ()=>{ renderHome(); showScreen('screen-home'); });
    el('btnBackHome2').addEventListener('click', ()=>{ renderHome(); showScreen('screen-home'); });

    el('btnAddCard').addEventListener('click', ()=>{
      const q = el('newQ').value.trim();
      const a = el('newA').value.trim();
      if(!q || !a) return;
      deck.cards.push({id:uid(), q, a, ef:2.5, reps:0, interval:0, due:0});
      saveDeck();
      el('newQ').value=''; el('newA').value='';
      renderManage(); renderHome();
    });

    el('btnBulkImport').addEventListener('click', ()=>{
      const text = el('bulkText').value;
      const cards = parseBulk(text);
      if(cards.length === 0){ alert('No Q:/A: pairs found. Check the format.'); return; }
      deck.cards = deck.cards.concat(cards);
      saveDeck();
      el('bulkText').value = '';
      renderManage(); renderHome();
    });

    el('btnFileImportTrigger').addEventListener('click', ()=> el('fileImport').click());
    el('fileImport').addEventListener('change', (e)=>{
      const file = e.target.files[0];
      if(!file) return;
      const reader = new FileReader();
      reader.onload = (evt)=>{
        const cards = parseBulk(evt.target.result);
        if(cards.length === 0){ alert('No Q:/A: pairs found in that file.'); return; }
        deck.cards = deck.cards.concat(cards);
        saveDeck();
        renderManage(); renderHome();
        alert('Imported ' + cards.length + ' cards.');
      };
      reader.readAsText(file);
      e.target.value = '';
    });

    el('btnReveal').addEventListener('click', revealAnswer);
    el('gradeRow').addEventListener('click', (e)=>{
      const btn = e.target.closest('.stamp-btn');
      if(btn) gradeCard(btn.dataset.grade);
    });
    el('btnExitStudy').addEventListener('click', endSessionEarly);

    document.addEventListener('keydown', (e)=>{
      if(!el('screen-study').classList.contains('active')) return;
      if(e.code === 'Space'){ e.preventDefault(); if(!session.revealed) revealAnswer(); }
      if(session.revealed){
        if(e.key === '1') gradeCard('again');
        if(e.key === '2') gradeCard('hard');
        if(e.key === '3') gradeCard('good');
        if(e.key === '4') gradeCard('easy');
      }
    });
  });
})();
