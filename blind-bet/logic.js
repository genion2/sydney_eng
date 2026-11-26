// 블라인드 경품 베팅 게임 - 순수 게임 로직 (브라우저/Node 공용)
(function (root) {
  const PRIZES = ['A', 'B', 'C'];
  const MAX_PLAYERS = 6;
  const MAX_SPECTATORS = 2;
  const START_CHIPS = 15;

  function newState(room, hostId) {
    return {
      v: 0, room, hostId,
      phase: 'lobby', // lobby | playing | rps | done
      settings: { openBets: true, shuffle: false },
      seats: Array(MAX_PLAYERS).fill(null), // {cid,name,chips,bets:{A,B,C}}
      spectators: [], // {cid,name}
      order: [],      // 진행 순서 (좌석 index)
      turnPos: 0,
      pending: null,  // {seat, roll, burned}
      log: [],
      results: null,  // {A:{status,winner,amount,detail}, ...}
      rps: null,      // {prize, seats:[], round, chosen:[], last:{}}
      prizeNames: { A: '', B: '', C: '' },
      revealed: false,
    };
  }

  function seatOf(s, cid) { return s.seats.findIndex(x => x && x.cid === cid); }
  function playerCount(s) { return s.seats.filter(Boolean).length; }
  function addLog(s, text) { s.log.push({ t: Date.now(), text }); if (s.log.length > 200) s.log.shift(); }
  function label(s, i) { const p = s.seats[i]; return `${i + 1}번 ${p ? p.name : ''}`.trim(); }

  function join(s, cid, name, role) {
    name = String(name || '').trim().slice(0, 12) || '이름없음';
    const seat = seatOf(s, cid);
    if (seat >= 0) { s.seats[seat].name = name; if (role === 'player' || s.phase !== 'lobby') return { ok: true }; }
    const spec = s.spectators.findIndex(x => x.cid === cid);
    if (spec >= 0) { s.spectators[spec].name = name; if (role === 'spectator') return { ok: true }; }
    if (s.phase !== 'lobby' && role === 'player') return { ok: false, err: '게임이 이미 시작되어 관전만 가능합니다.' };
    if (role === 'player') {
      const free = s.seats.findIndex(x => !x);
      if (free < 0) return { ok: false, err: '참가자 6자리가 모두 찼습니다.' };
      if (spec >= 0) s.spectators.splice(spec, 1);
      s.seats[free] = { cid, name, chips: START_CHIPS, bets: { A: 0, B: 0, C: 0 } };
      return { ok: true };
    }
    if (s.spectators.length >= MAX_SPECTATORS) return { ok: false, err: '관전자 2자리가 모두 찼습니다.' };
    if (seat >= 0) s.seats[seat] = null;
    s.spectators.push({ cid, name });
    return { ok: true };
  }

  function leave(s, cid) {
    if (s.phase !== 'lobby') { // 게임 중엔 좌석 유지 (재접속 가능)
      const sp = s.spectators.findIndex(x => x.cid === cid); if (sp >= 0) s.spectators.splice(sp, 1);
      return { ok: true };
    }
    const seat = seatOf(s, cid); if (seat >= 0) s.seats[seat] = null;
    const sp = s.spectators.findIndex(x => x.cid === cid); if (sp >= 0) s.spectators.splice(sp, 1);
    return { ok: true };
  }

  function start(s, rnd) {
    if (s.phase !== 'lobby') return { ok: false, err: '이미 시작됨' };
    const seats = s.seats.map((p, i) => p ? i : -1).filter(i => i >= 0);
    if (seats.length < 2) return { ok: false, err: '참가자가 2명 이상 필요합니다.' };
    seats.forEach(i => { s.seats[i].chips = START_CHIPS; s.seats[i].bets = { A: 0, B: 0, C: 0 }; });
    if (s.settings.shuffle) for (let i = seats.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [seats[i], seats[j]] = [seats[j], seats[i]]; }
    s.order = seats; s.turnPos = 0; s.pending = null; s.results = null; s.rps = null; s.revealed = false;
    s.phase = 'playing'; s.log = [];
    addLog(s, `게임 시작! 순서: ${seats.map(i => label(s, i)).join(' → ')}`);
    return { ok: true };
  }

  function currentSeat(s) { return s.phase === 'playing' ? s.order[s.turnPos] : -1; }

  function advance(s) {
    s.pending = null;
    const n = s.order.length;
    for (let k = 1; k <= n; k++) {
      const pos = (s.turnPos + k) % n;
      if (s.seats[s.order[pos]].chips > 0) { s.turnPos = pos; return; }
    }
    finish(s); // 모두 소진
  }

  function roll(s, seat, rnd) {
    if (s.phase !== 'playing' || currentSeat(s) !== seat) return { ok: false, err: '내 차례가 아닙니다.' };
    if (s.pending) return { ok: false, err: '이미 주사위를 굴렸습니다.' };
    const p = s.seats[seat];
    const r = 1 + Math.floor(rnd() * 6);
    if (p.chips < r) {
      addLog(s, `${label(s, seat)}: 🎲${r} → 남은 ${p.chips}칩 부족, 전부 소멸`);
      const burned = p.chips; p.chips = 0;
      s.lastRoll = { seat, roll: r, burned, t: Date.now() };
      advance(s);
      return { ok: true, roll: r, burned };
    }
    s.pending = { seat, roll: r };
    s.lastRoll = { seat, roll: r, t: Date.now() };
    return { ok: true, roll: r };
  }

  function bet(s, seat, prize) {
    if (s.phase !== 'playing' || !s.pending || s.pending.seat !== seat) return { ok: false, err: '먼저 주사위를 굴리세요.' };
    if (!PRIZES.includes(prize)) return { ok: false, err: '경품 선택 오류' };
    const p = s.seats[seat], r = s.pending.roll;
    p.chips -= r; p.bets[prize] += r;
    addLog(s, `${label(s, seat)}: 🎲${r} → ${prize}에 ${r}칩 베팅`);
    s.lastBet = { seat, prize, amount: r, t: Date.now() };
    advance(s);
    return { ok: true };
  }

  // 경품 하나 판정
  function judgePrize(s, prize) {
    const entries = s.seats.map((p, i) => p ? { seat: i, amt: p.bets[prize] } : null).filter(e => e && e.amt > 0);
    if (!entries.length) return { status: 'none' };
    const freq = {}; entries.forEach(e => freq[e.amt] = (freq[e.amt] || 0) + 1);
    const valid = entries.filter(e => freq[e.amt] === 1).sort((a, b) => b.amt - a.amt);
    const dups = [...new Set(entries.filter(e => freq[e.amt] > 1).map(e => e.amt))].sort((a, b) => b - a);
    if (valid.length) return { status: 'win', winner: valid[0].seat, amount: valid[0].amt, voided: dups };
    const top = dups[0];
    return { status: 'rps', amount: top, seats: entries.filter(e => e.amt === top).map(e => e.seat), voided: dups };
  }

  function finish(s) {
    s.pending = null;
    s.results = {};
    PRIZES.forEach(pz => { s.results[pz] = judgePrize(s, pz); });
    addLog(s, '모든 칩 소진! 경품별 판정을 시작합니다.');
    PRIZES.forEach(pz => {
      const r = s.results[pz];
      if (r.status === 'none') addLog(s, `경품 ${pz}: 베팅 없음 → 당첨자 없음`);
      else if (r.status === 'win') addLog(s, `경품 ${pz}: ${label(s, r.winner)} 당첨 (${r.amount}칩)${r.voided.length ? `, 중복 무효: ${r.voided.join(', ')}칩` : ''}`);
      else addLog(s, `경품 ${pz}: 모든 금액 중복 → 최고 중복액 ${r.amount}칩 (${r.seats.map(i => label(s, i)).join(', ')}) 가위바위보`);
    });
    nextRps(s);
  }

  function nextRps(s) {
    const pz = PRIZES.find(p => s.results[p].status === 'rps');
    if (!pz) { s.rps = null; s.phase = 'done'; addLog(s, '게임 종료!'); return; }
    s.phase = 'rps';
    s.rps = { prize: pz, seats: s.results[pz].seats.slice(), round: 1, chosen: [], last: null };
  }

  // choices: {seat: 'R'|'P'|'S'} (진행자 메모리에만 보관)
  const BEATS = { R: 'S', S: 'P', P: 'R' };
  const KR = { R: '바위', P: '보', S: '가위' };
  function resolveRps(s, choices) {
    const rp = s.rps; const picks = rp.seats.map(i => choices[i]);
    const kinds = [...new Set(picks)];
    const shown = rp.seats.map(i => `${label(s, i)} ${KR[choices[i]]}`).join(', ');
    rp.last = { round: rp.round, picks: Object.fromEntries(rp.seats.map(i => [i, choices[i]])) };
    if (kinds.length !== 2) {
      addLog(s, `[${rp.prize}] 가위바위보 ${rp.round}회차: ${shown} → 비김, 다시`);
      rp.round++; rp.chosen = []; return;
    }
    const win = BEATS[kinds[0]] === kinds[1] ? kinds[0] : kinds[1];
    const winners = rp.seats.filter(i => choices[i] === win);
    if (winners.length === 1) {
      addLog(s, `[${rp.prize}] 가위바위보 ${rp.round}회차: ${shown} → ${label(s, winners[0])} 당첨!`);
      const r = s.results[rp.prize]; r.status = 'win'; r.winner = winners[0]; r.byRps = true;
      nextRps(s);
    } else {
      addLog(s, `[${rp.prize}] 가위바위보 ${rp.round}회차: ${shown} → ${winners.map(i => label(s, i)).join(', ')} 재대결`);
      rp.seats = winners; rp.round++; rp.chosen = [];
    }
  }

  function reset(s) {
    const keep = { seats: s.seats.map(p => p && { cid: p.cid, name: p.name, chips: START_CHIPS, bets: { A: 0, B: 0, C: 0 } }), spectators: s.spectators, settings: s.settings, prizeNames: s.prizeNames };
    const n = newState(s.room, s.hostId); Object.assign(n, keep); n.v = s.v; n.prizeNames = { A: '', B: '', C: '' };
    return n;
  }

  // 비공개 모드: 다른 사람 베팅 내역 가리기
  function redact(s) {
    if (s.settings.openBets || s.phase === 'done' || s.phase === 'rps') {
      const c = JSON.parse(JSON.stringify(s)); if (!s.revealed) c.prizeNames = { A: '', B: '', C: '' }; return c;
    }
    const c = JSON.parse(JSON.stringify(s));
    c.prizeNames = { A: '', B: '', C: '' };
    c.seats = c.seats.map(p => p && Object.assign(p, { bets: null }));
    c.log = c.log.map(l => ({ t: l.t, text: l.text.replace(/→ [ABC]에 (\d+)칩 베팅/, '→ $1칩 베팅 (경품 비공개)') }));
    if (c.lastBet) c.lastBet.prize = '?';
    return c;
  }

  const api = { PRIZES, MAX_PLAYERS, MAX_SPECTATORS, START_CHIPS, newState, join, leave, start, roll, bet, judgePrize, resolveRps, reset, redact, currentSeat, seatOf, playerCount, label, KR };
  if (typeof module !== 'undefined') module.exports = api; else root.Game = api;
})(this);
