import {
  SIZE,
  EMPTY,
  BLACK,
  WHITE,
  toIndex,
  toXY,
  isFive,
  getForbiddenInfo,
  reasonLabel,
  placeStone,
  removeStone,
  emptyBoard,
  centerIndex,
} from './rules.js';

import {
  startPositions,
  simulateDuel,
  computeShotVelocity,
  applyHandTremor,
  judgeShotResult,
  BOARD_HALF,
  MARBLE_R,
  MAX_PULL,
} from './physics.js';

import { createNetwork, ABORT, isValidRoomCode } from './net.js';

function other(color) {
  return color === BLACK ? WHITE : BLACK;
}

function colorLabel(color) {
  return color === BLACK ? '흑' : '백';
}

function parseBanned(str) {
  return str ? str.split(',').filter(Boolean).map(Number) : [];
}

function dbStartPositions() {
  const p = startPositions();
  return { B: { x: p.B.x, y: p.B.y, out: false }, W: { x: p.W.x, y: p.W.y, out: false } };
}

function colorOf(room, playerId) {
  if (!room) return null;
  if (room.players.B === playerId) return 'B';
  if (room.players.W === playerId) return 'W';
  return null;
}

// ---------- 게임 규칙 트랜잭션 (net.js의 update()로 실행) ----------

function placeMoveUpdater(current, { index, color, playerId }) {
  if (!current) return ABORT;
  if (current.phase !== 'omok') return ABORT;
  if (current.turn !== color) return ABORT;
  if (current.players[color] !== playerId) return ABORT;
  if (current.board[index] !== EMPTY) return ABORT;
  if (color === BLACK && current.moves === 0 && index !== centerIndex()) return ABORT;
  if (color === BLACK && getForbiddenInfo(current.board, index).forbidden) return ABORT;

  const board = placeStone(current.board, index, color);
  const moves = current.moves + 1;
  const defender = other(color);

  if (isFive(board, index, color)) {
    return {
      ...current,
      board,
      last: index,
      moves,
      phase: 'duel',
      duelCount: (current.duelCount || 0) + 1,
      relocateBanned: '',
      duel: { attacker: color, turn: defender, pos: dbStartPositions() },
      shot: null,
    };
  }
  if (moves >= 130) {
    return { ...current, board, last: index, moves, phase: 'over', winner: 'draw', reason: 'draw' };
  }
  return { ...current, board, last: index, moves, turn: defender };
}

function shotUpdater(current, { by, vx, vy, final, playerId }) {
  if (!current) return ABORT;
  if (current.phase !== 'duel') return ABORT;
  if (current.duel.turn !== by) return ABORT;
  if (current.players[by] !== playerId) return ABORT;

  const from = current.duel.pos;
  const seq = (current.shot && current.shot.seq ? current.shot.seq : 0) + 1;
  const shot = { seq, by, vx, vy, from };
  const result = judgeShotResult(final, by);
  const attacker = current.duel.attacker;

  if (result === null) {
    return { ...current, shot, duel: { ...current.duel, turn: other(by), pos: final } };
  }

  const duelWinner = result === 'shooter-win' ? by : other(by);

  if (duelWinner === attacker) {
    return { ...current, shot, duel: { ...current.duel, pos: final }, phase: 'over', winner: attacker, reason: 'five' };
  }

  const banned = parseBanned(current.relocateBanned);
  banned.push(current.last);
  return {
    ...current,
    shot,
    duel: { ...current.duel, pos: final },
    phase: 'relocate',
    turn: attacker,
    relocateBanned: banned.join(','),
  };
}

function relocateUpdater(current, { index, playerId }) {
  if (!current) return ABORT;
  if (current.phase !== 'relocate') return ABORT;
  const attacker = current.turn;
  if (current.players[attacker] !== playerId) return ABORT;

  const banned = parseBanned(current.relocateBanned);
  if (banned.includes(index)) return ABORT;

  const withoutOld = removeStone(current.board, current.last);
  if (withoutOld[index] !== EMPTY) return ABORT;
  if (attacker === BLACK && getForbiddenInfo(withoutOld, index).forbidden) return ABORT;

  const board = placeStone(withoutOld, index, attacker);
  const defender = other(attacker);

  if (isFive(board, index, attacker)) {
    return {
      ...current,
      board,
      last: index,
      phase: 'duel',
      duelCount: (current.duelCount || 0) + 1,
      duel: { attacker, turn: defender, pos: dbStartPositions() },
      shot: null,
    };
  }
  return { ...current, board, last: index, phase: 'omok', turn: defender, relocateBanned: '' };
}

function rematchUpdater(current, color) {
  if (!current) return ABORT;
  if (current.phase !== 'over') return ABORT;
  const rematch = { ...current.rematch, [color]: true };
  if (rematch[other(color)]) {
    const oldPlayers = current.players;
    const oldNames = current.names;
    return {
      ...current,
      players: { B: oldPlayers.W, W: oldPlayers.B },
      names: { B: oldNames.W, W: oldNames.B },
      presence: { B: true, W: true },
      phase: 'omok',
      board: emptyBoard(),
      turn: 'B',
      last: -1,
      moves: 0,
      duelCount: 0,
      duel: null,
      shot: null,
      relocateBanned: '',
      winner: '',
      reason: '',
      rematch: { B: false, W: false },
    };
  }
  return { ...current, rematch };
}

// ---------- DOM ----------

const els = {
  localBadge: document.getElementById('local-badge'),

  screenLobby: document.getElementById('screen-lobby'),
  screenGame: document.getElementById('screen-game'),
  nicknameInput: document.getElementById('nickname-input'),
  codeInput: document.getElementById('code-input'),
  btnCreateRoom: document.getElementById('btn-create-room'),
  btnJoinRoom: document.getElementById('btn-join-room'),
  lobbyMessage: document.getElementById('lobby-message'),

  infoMe: document.getElementById('info-me'),
  infoMeStone: document.getElementById('info-me-stone'),
  infoMeName: document.getElementById('info-me-name'),
  infoMeConn: document.getElementById('info-me-conn'),
  infoOpp: document.getElementById('info-opp'),
  infoOppStone: document.getElementById('info-opp-stone'),
  infoOppName: document.getElementById('info-opp-name'),
  infoOppConn: document.getElementById('info-opp-conn'),
  turnIndicator: document.getElementById('turn-indicator'),
  statusLine: document.getElementById('status-line'),
  disconnectBanner: document.getElementById('disconnect-banner'),

  boardCanvas: document.getElementById('board-canvas'),
  bottomBarPlay: document.getElementById('bottom-bar-play'),
  bottomBarEnd: document.getElementById('bottom-bar-end'),
  btnCopyInvite: document.getElementById('btn-copy-invite'),
  btnLeave: document.getElementById('btn-leave'),

  duelOverlay: document.getElementById('duel-overlay'),
  fightTitle: document.getElementById('fight-title'),
  duelStatus: document.getElementById('duel-status'),
  duelCanvas: document.getElementById('duel-canvas'),
  duelHint: document.getElementById('duel-hint'),
  tremorGauge: document.getElementById('tremor-gauge'),
  tremorTrack: document.getElementById('tremor-track'),
  tremorPointer: document.getElementById('tremor-pointer'),

  btnRematch: document.getElementById('btn-rematch'),
  btnToLobby: document.getElementById('btn-to-lobby'),
  rematchStatus: document.getElementById('rematch-status'),

  toast: document.getElementById('toast'),
};

const boardCtx = els.boardCanvas.getContext('2d');
const duelCtx = els.duelCanvas.getContext('2d');

const PIXEL = els.boardCanvas.width;
const MARGIN = 32;
const CELL = (PIXEL - MARGIN * 2) / (SIZE - 1);

const DUEL_PIXEL = els.duelCanvas.width;
const DUEL_MARGIN = 14;
const DUEL_SCALE = (DUEL_PIXEL / 2 - DUEL_MARGIN) / BOARD_HALF;

// ---------- 상태 ----------

const state = {
  net: null,
  code: null,
  room: null, // 네트워크에서 받은 최신(진짜) 상태
  displayRoom: null, // 화면에 실제로 그리는 상태 (애니메이션 중에는 지연됨)
  myColor: null,
  lastAttachedColor: null,
  lastAnimatedSeq: 0,
  animating: false,
  animTimer: null,
  animPauseTimer: null,
  duelAnimFrame: null,
  dragging: null,
  hoverIndex: null,
  unsubscribe: null,
  disconnectTimer: null,
  disconnectDeadline: null,
  lastPoppedIndex: null,
  stonePop: null,
  tremorActive: false,
  tremorStart: 0,
  tremorTimer: null,
};

// ---------- 공통 유틸 ----------

let toastTimer = null;
function showToast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2200);
}

function setLobbyMessage(text) {
  els.lobbyMessage.textContent = text || '';
}

function showScreen(name) {
  els.screenLobby.classList.toggle('hidden', name !== 'lobby');
  els.screenGame.classList.toggle('hidden', name !== 'game');
}

// ---------- 오목판 좌표 변환 ----------

function cellPixel(gx, gy) {
  return { x: MARGIN + gx * CELL, y: MARGIN + gy * CELL };
}

function cellFromEvent(e) {
  const rect = els.boardCanvas.getBoundingClientRect();
  const scaleX = els.boardCanvas.width / rect.width;
  const scaleY = els.boardCanvas.height / rect.height;
  const px = (e.clientX - rect.left) * scaleX;
  const py = (e.clientY - rect.top) * scaleY;
  const gx = Math.round((px - MARGIN) / CELL);
  const gy = Math.round((py - MARGIN) / CELL);
  if (gx < 0 || gx >= SIZE || gy < 0 || gy >= SIZE) return null;
  const p = cellPixel(gx, gy);
  if (Math.hypot(p.x - px, p.y - py) > CELL * 0.45) return null;
  return toIndex(gx, gy);
}

let forbiddenCache = { board: null, set: null };
function getForbiddenSet(board) {
  if (forbiddenCache.board === board) return forbiddenCache.set;
  const set = new Set();
  for (let i = 0; i < board.length; i++) {
    if (board[i] !== EMPTY) continue;
    if (getForbiddenInfo(board, i).forbidden) set.add(i);
  }
  forbiddenCache = { board, set };
  return set;
}

const STONE_POP_MS = 320;

// 말랑하게 튀어오르듯 커지는 착수 연출용 이징(처음엔 작았다가 살짝 넘치고 제자리로).
function popScale(t) {
  if (t >= 1) return 1;
  const c1 = 1.3;
  const c3 = c1 + 1;
  const x = t - 1;
  return 1 + c3 * x * x * x + c1 * x * x;
}

function triggerStonePop(index) {
  state.stonePop = { index, startedAt: performance.now() };
  stonePopFrame();
}

function stonePopFrame() {
  if (!state.animating) renderBoardCanvas(state.displayRoom);
  if (state.stonePop && performance.now() - state.stonePop.startedAt < STONE_POP_MS) {
    requestAnimationFrame(stonePopFrame);
  } else {
    state.stonePop = null;
    if (!state.animating) renderBoardCanvas(state.displayRoom);
  }
}

function drawStone(ctx, x, y, color, alpha, radius) {
  ctx.save();
  ctx.globalAlpha = alpha;
  const grad = ctx.createRadialGradient(x - radius * 0.35, y - radius * 0.35, radius * 0.1, x, y, radius);
  if (color === BLACK) {
    grad.addColorStop(0, '#6b6b6b');
    grad.addColorStop(1, '#0a0a0a');
  } else {
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(1, '#c7c7c7');
  }
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function renderBoardCanvas(room) {
  if (!room) return;
  const ctx = boardCtx;
  ctx.clearRect(0, 0, PIXEL, PIXEL);

  ctx.strokeStyle = 'rgba(60,40,10,0.7)';
  ctx.lineWidth = 1;
  for (let i = 0; i < SIZE; i++) {
    const a = cellPixel(0, i);
    const b = cellPixel(SIZE - 1, i);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    const c = cellPixel(i, 0);
    const d = cellPixel(i, SIZE - 1);
    ctx.beginPath();
    ctx.moveTo(c.x, c.y);
    ctx.lineTo(d.x, d.y);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(60,40,10,0.7)';
  for (const [sx, sy] of [[3, 3], [3, 9], [3, 15], [9, 3], [9, 9], [9, 15], [15, 3], [15, 9], [15, 15]]) {
    const p = cellPixel(sx, sy);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  const myColor = state.myColor;
  const myTurnOmok = room.phase === 'omok' && myColor && room.turn === myColor;
  let forbiddenSet = null;
  if (myTurnOmok && myColor === BLACK) forbiddenSet = getForbiddenSet(room.board);

  let relocateBanned = null;
  let relocateBoard = null;
  let relocateForbidden = null;
  const myRelocateTurn = room.phase === 'relocate' && myColor && room.turn === myColor;
  if (myRelocateTurn) {
    relocateBanned = new Set(parseBanned(room.relocateBanned));
    relocateBoard = removeStone(room.board, room.last);
    if (myColor === BLACK) relocateForbidden = getForbiddenSet(relocateBoard);
  }

  const stoneR = CELL * 0.42;
  for (let i = 0; i < room.board.length; i++) {
    const c = room.board[i];
    if (c === EMPTY) continue;
    const { x: gx, y: gy } = toXY(i);
    const p = cellPixel(gx, gy);
    let r = stoneR;
    if (state.stonePop && state.stonePop.index === i) {
      const t = (performance.now() - state.stonePop.startedAt) / STONE_POP_MS;
      r = stoneR * popScale(Math.min(t, 1));
    }
    drawStone(ctx, p.x, p.y, c, 1, r);
  }

  if (room.last !== -1 && room.phase !== 'duel') {
    const { x: gx, y: gy } = toXY(room.last);
    const p = cellPixel(gx, gy);
    if (room.phase === 'relocate') {
      ctx.strokeStyle = '#e2574c';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(p.x, p.y, stoneR, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.fillStyle = '#e2574c';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  if (myTurnOmok && myColor === BLACK && room.moves === 0) {
    const { x: gx, y: gy } = toXY(centerIndex());
    const p = cellPixel(gx, gy);
    ctx.strokeStyle = 'rgba(232,184,75,0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, stoneR + 5, 0, Math.PI * 2);
    ctx.stroke();
  }

  if (forbiddenSet) {
    ctx.strokeStyle = 'rgba(226,87,76,0.85)';
    ctx.lineWidth = 2;
    for (const i of forbiddenSet) {
      const { x: gx, y: gy } = toXY(i);
      const p = cellPixel(gx, gy);
      const r = CELL * 0.22;
      ctx.beginPath();
      ctx.moveTo(p.x - r, p.y - r);
      ctx.lineTo(p.x + r, p.y + r);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(p.x + r, p.y - r);
      ctx.lineTo(p.x - r, p.y + r);
      ctx.stroke();
    }
  }

  if (myRelocateTurn) {
    ctx.fillStyle = 'rgba(75,161,232,0.35)';
    for (let i = 0; i < relocateBoard.length; i++) {
      if (relocateBoard[i] !== EMPTY) continue;
      if (relocateBanned.has(i)) continue;
      if (relocateForbidden && relocateForbidden.has(i)) continue;
      const { x: gx, y: gy } = toXY(i);
      const p = cellPixel(gx, gy);
      ctx.beginPath();
      ctx.arc(p.x, p.y, CELL * 0.18, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  if (myTurnOmok && state.hoverIndex != null && room.board[state.hoverIndex] === EMPTY) {
    const forbidden = forbiddenSet && forbiddenSet.has(state.hoverIndex);
    if (!forbidden) {
      const { x: gx, y: gy } = toXY(state.hoverIndex);
      const p = cellPixel(gx, gy);
      drawStone(ctx, p.x, p.y, myColor, 0.45, stoneR);
    }
  }
}

function onBoardHover(e) {
  state.hoverIndex = cellFromEvent(e);
  if (!state.animating) renderBoardCanvas(state.displayRoom);
}

function onBoardClick(e) {
  const index = cellFromEvent(e);
  if (index == null) return;
  const room = state.room;
  if (!room || !state.myColor) return;

  if (room.phase === 'omok') {
    if (room.turn !== state.myColor) return;
    if (room.board[index] !== EMPTY) return;
    if (state.myColor === BLACK && room.moves === 0 && index !== centerIndex()) {
      showToast('첫 수는 반드시 판의 정중앙에 둬야 합니다.');
      return;
    }
    if (state.myColor === BLACK) {
      const info = getForbiddenInfo(room.board, index);
      if (info.forbidden) {
        showToast(`금수 자리입니다 (${reasonLabel(info.reason)})`);
        return;
      }
    }
    state.net
      .update(state.code, (current) => placeMoveUpdater(current, { index, color: state.myColor, playerId: state.net.playerId }))
      .catch((err) => showToast(err.message));
  } else if (room.phase === 'relocate') {
    if (room.turn !== state.myColor) return;
    const withoutOld = removeStone(room.board, room.last);
    if (withoutOld[index] !== EMPTY) return;
    const banned = parseBanned(room.relocateBanned);
    if (banned.includes(index)) {
      showToast('원래 있던 자리로는 옮길 수 없습니다.');
      return;
    }
    if (state.myColor === BLACK) {
      const info = getForbiddenInfo(withoutOld, index);
      if (info.forbidden) {
        showToast(`금수 자리입니다 (${reasonLabel(info.reason)})`);
        return;
      }
    }
    state.net
      .update(state.code, (current) => relocateUpdater(current, { index, playerId: state.net.playerId }))
      .catch((err) => showToast(err.message));
  }
}

// ---------- 알까기(듀얼) 좌표 변환 & 렌더 ----------

function duelFlip() {
  return state.myColor === BLACK;
}

function worldToPixel(wx, wy) {
  const flip = duelFlip();
  const sx = flip ? -wx : wx;
  const sy = flip ? -wy : wy;
  return { x: DUEL_PIXEL / 2 + sx * DUEL_SCALE, y: DUEL_PIXEL / 2 + sy * DUEL_SCALE };
}

function pixelToWorld(px, py) {
  const flip = duelFlip();
  const sx = (px - DUEL_PIXEL / 2) / DUEL_SCALE;
  const sy = (py - DUEL_PIXEL / 2) / DUEL_SCALE;
  return { x: flip ? -sx : sx, y: flip ? -sy : sy };
}

function currentDuelPos() {
  if (state.duelAnimFrame) return state.duelAnimFrame;
  const room = state.displayRoom;
  if (room && room.duel) return room.duel.pos;
  const p = startPositions();
  return { B: { ...p.B, out: false }, W: { ...p.W, out: false } };
}

const DUEL_BOARD_MARGIN = 20;
const DUEL_BOARD_CELL = (DUEL_PIXEL - DUEL_BOARD_MARGIN * 2) / (SIZE - 1);

// 알까기 판은 실제 대국과 무관한 "빈 바둑판" 배경일 뿐이다 (장식용 격자).
function drawDuelBoardBackground() {
  const ctx = duelCtx;
  ctx.fillStyle = '#dcb35c';
  ctx.fillRect(0, 0, DUEL_PIXEL, DUEL_PIXEL);
  ctx.strokeStyle = 'rgba(60,40,10,0.55)';
  ctx.lineWidth = 1;
  for (let i = 0; i < SIZE; i++) {
    const a = DUEL_BOARD_MARGIN + i * DUEL_BOARD_CELL;
    ctx.beginPath();
    ctx.moveTo(DUEL_BOARD_MARGIN, a);
    ctx.lineTo(DUEL_PIXEL - DUEL_BOARD_MARGIN, a);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(a, DUEL_BOARD_MARGIN);
    ctx.lineTo(a, DUEL_PIXEL - DUEL_BOARD_MARGIN);
    ctx.stroke();
  }
}

function renderDuelCanvas() {
  const ctx = duelCtx;
  ctx.clearRect(0, 0, DUEL_PIXEL, DUEL_PIXEL);
  drawDuelBoardBackground();

  const pos = currentDuelPos();
  const marbleR = MARBLE_R * DUEL_SCALE;

  for (const color of ['B', 'W']) {
    const p = pos[color];
    if (!p || p.out) continue;
    const sp = worldToPixel(p.x, p.y);
    drawStone(ctx, sp.x, sp.y, color, 1, marbleR);
  }

  if (state.dragging) {
    // 알은 제자리에 그대로 두고, 당긴 방향/세기를 알 중심에서 뻗어나가는 점선 벡터로만 보여준다.
    const { anchor, pull } = state.dragging;
    const sp1 = worldToPixel(anchor.x, anchor.y);
    const sp2 = worldToPixel(anchor.x + pull.x, anchor.y + pull.y);
    const power = Math.min(Math.hypot(pull.x, pull.y), MAX_PULL) / MAX_PULL;
    ctx.strokeStyle = `rgba(232,184,75,${0.4 + power * 0.6})`;
    ctx.lineWidth = 2 + power * 4;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(sp1.x, sp1.y);
    ctx.lineTo(sp2.x, sp2.y);
    ctx.stroke();
    ctx.setLineDash([]);
    els.duelHint.textContent = `세기 ${Math.round(power * 100)}%`;
  }
}

// ---------- 손떨림 게이지 ----------

const TREMOR_PERIOD_MS = 1300; // 한 왕복(위→아래→위)에 걸리는 시간

// -1(맨 아래) ~ 0(정중앙) ~ +1(맨 위)을 오가는 값. 사인파라 양 끝에서 머무는 듯한 리듬감이 생긴다.
function currentTremorValue() {
  const elapsed = performance.now() - state.tremorStart;
  return Math.sin((elapsed / TREMOR_PERIOD_MS) * Math.PI * 2);
}

function renderTremorGauge() {
  const h = els.tremorTrack.clientHeight;
  const v = currentTremorValue();
  const topPx = ((1 - v) / 2) * h;
  els.tremorPointer.style.top = `${topPx}px`;
}

function tremorFrame() {
  if (!state.tremorActive) return;
  renderTremorGauge();
  state.tremorTimer = requestAnimationFrame(tremorFrame);
}

function startTremor() {
  els.tremorGauge.classList.remove('hidden');
  if (state.tremorActive) return;
  state.tremorActive = true;
  state.tremorStart = performance.now();
  tremorFrame();
}

function stopTremor() {
  state.tremorActive = false;
  if (state.tremorTimer) cancelAnimationFrame(state.tremorTimer);
  state.tremorTimer = null;
  els.tremorGauge.classList.add('hidden');
}

function duelPointerDown(e) {
  const room = state.room;
  if (state.dragging || !room || room.phase !== 'duel' || !state.myColor || !room.duel) return;
  if (room.duel.turn !== state.myColor || state.animating) return;

  const rect = els.duelCanvas.getBoundingClientRect();
  const scaleX = DUEL_PIXEL / rect.width;
  const scaleY = DUEL_PIXEL / rect.height;
  const px = (e.clientX - rect.left) * scaleX;
  const py = (e.clientY - rect.top) * scaleY;
  const world = pixelToWorld(px, py);
  const myPos = currentDuelPos()[state.myColor];
  const dist = Math.hypot(world.x - myPos.x, world.y - myPos.y);
  if (dist > MARBLE_R * 2.5) return;

  state.dragging = { color: state.myColor, anchor: { x: myPos.x, y: myPos.y }, pull: { x: 0, y: 0 }, pointerId: e.pointerId };
  els.duelCanvas.setPointerCapture(e.pointerId);
  renderDuelCanvas();
}

function duelPointerMove(e) {
  if (!state.dragging || state.dragging.pointerId !== e.pointerId) return;
  const rect = els.duelCanvas.getBoundingClientRect();
  const scaleX = DUEL_PIXEL / rect.width;
  const scaleY = DUEL_PIXEL / rect.height;
  const px = (e.clientX - rect.left) * scaleX;
  const py = (e.clientY - rect.top) * scaleY;
  const world = pixelToWorld(px, py);
  let dx = world.x - state.dragging.anchor.x;
  let dy = world.y - state.dragging.anchor.y;
  const len = Math.hypot(dx, dy);
  if (len > MAX_PULL) {
    dx = (dx / len) * MAX_PULL;
    dy = (dy / len) * MAX_PULL;
  }
  state.dragging.pull = { x: dx, y: dy };
  renderDuelCanvas();
}

function duelPointerUp(e) {
  if (!state.dragging || state.dragging.pointerId !== e.pointerId) return;
  const { pull, color } = state.dragging;
  state.dragging = null;
  els.duelHint.textContent = '';

  const len = Math.hypot(pull.x, pull.y);
  if (len < 1.5) {
    renderDuelCanvas();
    return;
  }

  const gaugeValue = currentTremorValue();
  stopTremor();
  const base = computeShotVelocity(pull.x, pull.y);
  const { vx, vy } = applyHandTremor(base.vx, base.vy, gaugeValue);
  const startPos = state.room.duel.pos;
  const { final } = simulateDuel(startPos, color, vx, vy);
  state.net
    .update(state.code, (current) => shotUpdater(current, { by: color, vx, vy, final, playerId: state.net.playerId }))
    .catch((err) => showToast(err.message));
}

function triggerFightIntro() {
  const el = els.fightTitle;
  el.classList.remove('play');
  void el.offsetWidth;
  el.classList.add('play');

  els.duelOverlay.classList.remove('intro-flash');
  void els.duelOverlay.offsetWidth;
  els.duelOverlay.classList.add('intro-flash');
}

const DUEL_RESULT_PAUSE_MS = 1500; // 알이 멈춘 모습을 보여준 뒤에야 승패 팝업을 띄운다.

function playShotAnimation(shot) {
  if (state.animTimer) cancelAnimationFrame(state.animTimer);
  if (state.animPauseTimer) clearTimeout(state.animPauseTimer);
  state.animating = true;
  const { steps } = simulateDuel(shot.from, shot.by, shot.vx, shot.vy);
  let frame = 0;
  function step() {
    if (frame >= steps.length) {
      // 알이 멈춘 최종 모습을 잠시 보여준 뒤에 실제 상태(승패 팝업 등)로 전환한다.
      state.duelAnimFrame = steps[steps.length - 1];
      renderDuelCanvas();
      state.animPauseTimer = setTimeout(() => {
        state.animPauseTimer = null;
        state.animating = false;
        state.duelAnimFrame = null;
        state.displayRoom = state.room;
        render();
      }, DUEL_RESULT_PAUSE_MS);
      return;
    }
    state.duelAnimFrame = steps[frame];
    renderDuelCanvas();
    frame++;
    state.animTimer = requestAnimationFrame(step);
  }
  step();
}

// ---------- 상단 바 / 상태 메시지 / 종료 화면 ----------

function updateTopBar(room) {
  const myColor = state.myColor;
  const oppColor = myColor ? other(myColor) : null;
  // 대기 화면에서는 아직 흑/백이 배정되지 않았으므로, 방장 본인인지 먼저 구분한다(관전자와 구분).
  const isWaitingHost = room.phase === 'waiting' && room.waitingPlayer && room.waitingPlayer.id === state.net.playerId;

  els.infoMeName.textContent = myColor ? room.names[myColor] || '나' : isWaitingHost ? room.waitingPlayer.name || '나' : '관전';
  els.infoMeStone.classList.toggle('white', myColor === WHITE);
  els.infoMeStone.style.visibility = myColor ? 'visible' : 'hidden';
  els.infoMeConn.classList.toggle('off', myColor ? room.presence[myColor] === false : !isWaitingHost);

  if (oppColor) {
    els.infoOppName.textContent = room.names[oppColor] || '상대';
    els.infoOppStone.classList.toggle('white', oppColor === WHITE);
    els.infoOppStone.style.visibility = 'visible';
    els.infoOppConn.classList.toggle('off', room.presence[oppColor] === false);
  } else {
    els.infoOppName.textContent = room.phase === 'waiting' ? '대기 중' : '상대';
    els.infoOppStone.style.visibility = 'hidden';
    els.infoOppConn.classList.add('off');
  }

  const activeColor = room.phase === 'duel' && room.duel ? room.duel.turn : room.turn;
  const activeOk = room.phase !== 'over' && room.phase !== 'waiting';
  els.infoMe.classList.toggle('active', !!myColor && activeOk && activeColor === myColor);
  els.infoOpp.classList.toggle('active', !!oppColor && activeOk && activeColor === oppColor);

  els.turnIndicator.textContent =
    room.phase === 'waiting' ? '대기 중' : room.phase === 'over' ? '종료' : activeColor === 'B' ? '흑 차례' : '백 차례';
}

function updateStatusLine(room) {
  const myColor = state.myColor;
  let text = '';
  if (room.phase === 'waiting') {
    text = `상대를 기다리는 중 — 방 코드 ${state.code}`;
  } else if (room.phase === 'over') {
    if (room.reason === 'draw') {
      text = '무승부 — 130수 무승부';
    } else {
      const winnerName = room.names[room.winner] || (room.winner === 'B' ? '흑' : '백');
      const reasonText = room.reason === 'disconnect' ? '상대 연결 끊김' : '5목 + 알까기 승리';
      text = `${winnerName} 승! · ${reasonText}`;
    }
  } else if (!myColor) {
    text = '관전 중';
  } else if (room.phase === 'omok') {
    text = room.turn === myColor ? '내 차례' : '상대 차례';
  } else if (room.phase === 'duel') {
    text = '알까기 진행 중';
  } else if (room.phase === 'relocate') {
    text = room.turn === myColor ? '알까기 패배! 돌을 다른 곳으로 옮기세요' : '상대가 승부수 돌을 옮기는 중';
  }
  els.statusLine.textContent = text;
  els.statusLine.classList.toggle('result', room.phase === 'over');
}

function updateDuelStatus(room) {
  const myTurn = state.myColor && room.duel && room.duel.turn === state.myColor;
  els.duelStatus.textContent = !state.myColor
    ? '관전 중'
    : myTurn
    ? '내 차례 — 알을 당겼다 놓아 튕기세요'
    : '상대가 튕기는 중...';
  if (!state.dragging) {
    els.duelHint.textContent = myTurn ? '내 알을 클릭(터치)한 채 뒤로 당겼다 놓으세요 · 오른쪽 게이지가 가운데일 때 놓아야 정확합니다' : '';
  }
  if (myTurn && !state.animating) {
    startTremor();
  } else {
    stopTremor();
  }
}

function renderEndBar(room) {
  const myColor = state.myColor;
  const rematch = room.rematch || {};
  const agreedCount = (rematch.B ? 1 : 0) + (rematch.W ? 1 : 0);
  // 누가 눌렀는지와 상관없이 양쪽 모두 똑같은 문구(동의 인원수)를 본다.
  els.rematchStatus.textContent = agreedCount > 0 ? `다시하기 대기 (${agreedCount}/2)` : '';
  els.btnRematch.disabled = !myColor || !!rematch[myColor];
}

function render() {
  const room = state.displayRoom;
  if (!room) return;

  updateTopBar(room);
  updateStatusLine(room);
  renderBoardCanvas(room);

  const inDuel = room.phase === 'duel';
  els.duelOverlay.classList.toggle('hidden', !inDuel);
  if (inDuel) {
    updateDuelStatus(room);
    renderDuelCanvas();
  } else {
    stopTremor();
  }

  // 알까기 승리로 게임이 끝나면 별도 팝업 없이, 보드는 그대로 둔 채
  // 하단 버튼만 "초대/나가기"에서 "다시 하기/로비로"로 바뀐다 (더 이상 착수는 안 됨).
  const isOver = room.phase === 'over';
  els.bottomBarPlay.classList.toggle('hidden', isOver);
  els.bottomBarEnd.classList.toggle('hidden', !isOver);
  if (isOver) {
    renderEndBar(room);
  } else {
    els.rematchStatus.textContent = '';
  }
}

// ---------- 연결 끊김(60초) 처리 ----------

function watchPresence(room) {
  if (!state.myColor || room.phase === 'waiting' || room.phase === 'over') {
    clearDisconnectTimer();
    return;
  }
  const oppColor = other(state.myColor);
  const oppPresent = room.presence[oppColor];
  if (oppPresent === false) {
    if (!state.disconnectDeadline) {
      state.disconnectDeadline = Date.now() + 60000;
      tickDisconnect();
    }
  } else {
    clearDisconnectTimer();
  }
}

function tickDisconnect() {
  if (!state.disconnectDeadline) return;
  const remain = Math.max(0, Math.ceil((state.disconnectDeadline - Date.now()) / 1000));
  els.disconnectBanner.textContent = `상대의 연결이 끊겼습니다. ${remain}초 후 자동으로 승리 처리됩니다.`;
  els.disconnectBanner.classList.remove('hidden');
  if (remain <= 0) {
    clearDisconnectTimer();
    claimForfeitWin();
    return;
  }
  state.disconnectTimer = setTimeout(tickDisconnect, 250);
}

function clearDisconnectTimer() {
  if (state.disconnectTimer) clearTimeout(state.disconnectTimer);
  state.disconnectTimer = null;
  state.disconnectDeadline = null;
  els.disconnectBanner.classList.add('hidden');
}

async function claimForfeitWin() {
  const myColor = state.myColor;
  if (!myColor) return;
  await state.net.update(state.code, (current) => {
    if (!current || current.phase === 'over') return ABORT;
    if (current.presence[other(myColor)] !== false) return ABORT;
    return { ...current, phase: 'over', winner: myColor, reason: 'disconnect' };
  });
}

// ---------- 방 입장/퇴장 ----------

// 국면이 바뀔 때마다 "지금 무슨 상황이고 내가 뭘 해야 하는지"를 토스트로 알려준다.
function announceTransition(prevRoom, room, myColor) {
  if (!prevRoom || !myColor) return; // 처음 입장하는 순간(이전 상태 없음)이나 관전자는 생략
  const prevPhase = prevRoom.phase;

  if (prevPhase === 'waiting' && room.phase === 'omok') {
    showToast(
      myColor === BLACK
        ? '상대가 입장했습니다! 당신은 흑입니다. 첫 수는 정중앙에 두세요.'
        : '상대가 입장했습니다! 당신은 백입니다.'
    );
    return;
  }

  if (prevPhase !== 'duel' && room.phase === 'duel' && room.duel) {
    const attacker = room.duel.attacker;
    const isRedo = (room.duelCount || 0) > 1;
    if (myColor === attacker) {
      showToast(isRedo ? '다시 5목! 알까기 재대결입니다. 상대가 먼저 튕깁니다.' : '5목 완성! 알까기에서 이기면 바로 승리합니다. 상대가 먼저 튕깁니다.');
    } else {
      showToast(isRedo ? '상대가 다시 5목을 완성했습니다! 당신이 먼저 튕깁니다.' : '상대가 5목을 완성했습니다! 알까기로 막아내세요. 당신이 먼저 튕깁니다.');
    }
    return;
  }

  if (prevPhase === 'duel' && room.phase === 'duel' && prevRoom.duel && room.duel && prevRoom.duel.turn !== room.duel.turn) {
    showToast(room.duel.turn === myColor ? '내 차례입니다! 알을 당겼다 놓아 튕기세요.' : '상대 차례입니다.');
    return;
  }

  if (prevPhase === 'duel' && room.phase === 'relocate') {
    const attacker = room.turn; // relocateUpdater가 turn을 공격자로 설정해 둔다
    if (myColor === attacker) {
      showToast(`${colorLabel(myColor)}돌 알까기 패배! 다른 곳에 착수해주세요.`);
    } else {
      showToast('알까기 승리! 상대가 승부수 돌을 옮기는 중입니다.');
    }
    return;
  }

  if (prevPhase === 'relocate' && room.phase === 'omok') {
    showToast(room.turn === myColor ? '돌을 옮겼습니다. 내 차례입니다.' : '상대가 돌을 옮겼습니다. 상대 차례입니다.');
    return;
  }

  if (prevPhase !== 'over' && room.phase === 'over' && room.reason === 'five') {
    showToast(myColor === room.winner ? '알까기 승리! 5목 승리가 확정됩니다.' : '알까기 패배... 상대의 5목 승리가 확정됩니다.');
    return;
  }

  if (prevPhase === 'over' && room.phase === 'omok') {
    showToast(`새 판 시작! 이번엔 당신이 ${colorLabel(myColor)}입니다.`);
  }
}

function handleRoomUpdate(room) {
  if (!room) {
    showToast('방을 찾을 수 없거나 종료되었습니다.');
    cleanupRoom();
    showScreen('lobby');
    return;
  }

  const prevRoom = state.room;
  const prevPhase = prevRoom ? prevRoom.phase : null;
  state.room = room;

  const myColor = colorOf(room, state.net.playerId);
  state.myColor = myColor;
  if (myColor && myColor !== state.lastAttachedColor) {
    state.net.attachPresence(state.code, myColor);
    state.lastAttachedColor = myColor;
  }

  watchPresence(room);
  announceTransition(prevRoom, room, myColor);

  if (room.last !== -1 && room.last !== state.lastPoppedIndex) {
    if (state.lastPoppedIndex !== null) triggerStonePop(room.last);
    state.lastPoppedIndex = room.last;
  }

  if (room.phase === 'duel' && prevPhase !== 'duel') {
    state.lastAnimatedSeq = room.shot ? room.shot.seq : 0;
    state.displayRoom = room;
    triggerFightIntro();
    render();
    return;
  }

  const shotSeq = room.shot ? room.shot.seq : 0;
  if (shotSeq > state.lastAnimatedSeq) {
    state.lastAnimatedSeq = shotSeq;
    playShotAnimation(room.shot);
    return;
  }

  if (!state.animating) {
    state.displayRoom = room;
    render();
  }
}

function enterRoom(code) {
  state.code = code;
  state.room = null;
  state.displayRoom = null;
  state.myColor = null;
  state.lastAttachedColor = null;
  state.lastAnimatedSeq = 0;
  state.animating = false;
  state.duelAnimFrame = null;
  state.lastPoppedIndex = null;
  state.stonePop = null;
  if (state.animTimer) cancelAnimationFrame(state.animTimer);
  if (state.animPauseTimer) clearTimeout(state.animPauseTimer);
  state.animTimer = null;
  state.animPauseTimer = null;
  stopTremor();

  const url = new URL(location.href);
  url.searchParams.set('room', code);
  history.replaceState(null, '', url);

  showScreen('game');
  if (state.unsubscribe) state.unsubscribe();
  state.unsubscribe = state.net.watchRoom(code, handleRoomUpdate);
}

function cleanupRoom() {
  clearDisconnectTimer();
  if (state.unsubscribe) {
    state.unsubscribe();
    state.unsubscribe = null;
  }
  if (state.animTimer) cancelAnimationFrame(state.animTimer);
  if (state.animPauseTimer) clearTimeout(state.animPauseTimer);
  state.animTimer = null;
  state.animPauseTimer = null;
  state.animating = false;
  state.stonePop = null;
  stopTremor();
  const url = new URL(location.href);
  url.searchParams.delete('room');
  history.replaceState(null, '', url);
  state.code = null;
  state.room = null;
  state.displayRoom = null;
  state.myColor = null;
}

async function onCreateRoom() {
  const nickname = (els.nicknameInput.value || '').trim();
  if (!nickname) {
    setLobbyMessage('닉네임을 입력해 주세요.');
    return;
  }
  state.net.setNickname(nickname);
  els.btnCreateRoom.disabled = true;
  setLobbyMessage('방을 만드는 중...');
  try {
    const { code } = await state.net.createRoom(nickname);
    setLobbyMessage('');
    enterRoom(code);
  } catch (err) {
    setLobbyMessage(err.message || '방 만들기에 실패했습니다.');
  } finally {
    els.btnCreateRoom.disabled = false;
  }
}

async function attemptJoin(code, nickname) {
  els.btnJoinRoom.disabled = true;
  setLobbyMessage('입장하는 중...');
  try {
    const result = await state.net.joinRoom(code, nickname);
    if (result.action === 'not-found') {
      setLobbyMessage('방을 찾을 수 없습니다.');
      return;
    }
    if (result.action === 'full') {
      setLobbyMessage('플레이어가 가득 찼습니다. 관전으로 입장합니다.');
    } else {
      setLobbyMessage('');
    }
    enterRoom(code);
  } catch (err) {
    setLobbyMessage(err.message || '입장에 실패했습니다.');
  } finally {
    els.btnJoinRoom.disabled = false;
  }
}

function onJoinRoom() {
  const nickname = (els.nicknameInput.value || '').trim();
  const code = (els.codeInput.value || '').trim().toUpperCase();
  if (!nickname) {
    setLobbyMessage('닉네임을 입력해 주세요.');
    return;
  }
  if (!isValidRoomCode(code)) {
    setLobbyMessage('방 코드 형식이 올바르지 않습니다. (예: K7PX)');
    return;
  }
  state.net.setNickname(nickname);
  attemptJoin(code, nickname);
}

function onCopyInvite() {
  const url = new URL(location.href);
  url.searchParams.set('room', state.code);
  navigator.clipboard.writeText(url.toString()).then(
    () => showToast('초대 링크를 복사했습니다.'),
    () => showToast('복사에 실패했습니다. 주소창의 링크를 직접 복사해 주세요.')
  );
}

async function onLeave() {
  if (state.myColor && state.code) {
    await state.net.setPresence(state.code, state.myColor, false);
  }
  cleanupRoom();
  showScreen('lobby');
}

function onToLobby() {
  cleanupRoom();
  showScreen('lobby');
}

async function onRematch() {
  if (!state.myColor) return;
  els.btnRematch.disabled = true;
  try {
    await state.net.update(state.code, (current) => rematchUpdater(current, state.myColor));
  } catch (err) {
    showToast(err.message);
    els.btnRematch.disabled = false;
  }
}

// ---------- 초기화 ----------

async function init() {
  state.net = await createNetwork();
  if (state.net.mode === 'local') els.localBadge.classList.remove('hidden');

  els.nicknameInput.value = state.net.getNickname();

  els.btnCreateRoom.addEventListener('click', onCreateRoom);
  els.btnJoinRoom.addEventListener('click', onJoinRoom);
  els.codeInput.addEventListener('input', () => {
    const upper = els.codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    els.codeInput.value = upper;
  });
  els.codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onJoinRoom();
  });
  els.nicknameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !els.codeInput.value) onCreateRoom();
  });

  els.btnCopyInvite.addEventListener('click', onCopyInvite);
  els.btnLeave.addEventListener('click', onLeave);
  els.btnRematch.addEventListener('click', onRematch);
  els.btnToLobby.addEventListener('click', onToLobby);

  els.boardCanvas.addEventListener('mousemove', onBoardHover);
  els.boardCanvas.addEventListener('mouseleave', () => {
    state.hoverIndex = null;
    if (!state.animating) renderBoardCanvas(state.displayRoom);
  });
  els.boardCanvas.addEventListener('click', onBoardClick);

  els.duelCanvas.addEventListener('pointerdown', duelPointerDown);
  els.duelCanvas.addEventListener('pointermove', duelPointerMove);
  els.duelCanvas.addEventListener('pointerup', duelPointerUp);
  els.duelCanvas.addEventListener('pointercancel', duelPointerUp);

  const params = new URLSearchParams(location.search);
  const roomParam = (params.get('room') || '').toUpperCase();
  if (roomParam && isValidRoomCode(roomParam)) {
    els.codeInput.value = roomParam;
    const nick = state.net.getNickname();
    if (nick) {
      attemptJoin(roomParam, nick);
    }
  }
}

init();
