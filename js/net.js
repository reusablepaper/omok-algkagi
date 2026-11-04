// Firebase / 로컬 모드 공통 네트워크 인터페이스
// - firebase-config.js 가 비어있거나 URL에 ?local=1 이 있으면 "로컬 테스트 모드"(같은 브라우저 탭끼리
//   BroadcastChannel + localStorage로 통신)로 동작합니다.
// - 그 외에는 Firebase Realtime Database를 사용합니다.
// 어느 모드든 호출하는 쪽(main.js)에서는 완전히 동일한 메서드만 사용합니다.

import { emptyBoard } from './rules.js';
import { firebaseConfig } from './firebase-config.js';

export const ABORT = Symbol('net-abort');

const ROOM_CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 0/O, 1/I/L 제외
export const ROOM_CODE_LENGTH = 4;
export const ROOM_CODE_REGEX = new RegExp(`^[${ROOM_CODE_CHARS}]{${ROOM_CODE_LENGTH}}$`);

export function isValidRoomCode(code) {
  return typeof code === 'string' && ROOM_CODE_REGEX.test(code);
}

function generateRoomCode() {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  }
  return code;
}

function randomId() {
  if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
  return 'p-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// 새로고침해도 같은 탭이면 유지되지만, 다른 탭과는 공유되지 않는 저장소(sessionStorage)를 사용합니다.
// -> 로컬 테스트 모드에서 탭 두 개를 서로 다른 플레이어로 구분할 수 있는 핵심 트릭입니다.
function getPlayerId() {
  let id = sessionStorage.getItem('omok_player_id');
  if (!id) {
    id = randomId();
    sessionStorage.setItem('omok_player_id', id);
  }
  return id;
}

export function getNickname() {
  return localStorage.getItem('omok_nickname') || '';
}

export function setNickname(name) {
  localStorage.setItem('omok_nickname', name);
}

export function wantsLocalMode() {
  const params = new URLSearchParams(location.search);
  return params.get('local') === '1';
}

function isFirebaseConfigValid(cfg) {
  return !!(cfg && cfg.apiKey && cfg.databaseURL && String(cfg.apiKey).trim().length > 0);
}

function normalizeRoom(raw) {
  if (!raw) return null;
  return {
    createdAt: raw.createdAt || 0,
    code: raw.code || '',
    waitingPlayer: raw.waitingPlayer || null,
    players: raw.players || {},
    names: raw.names || {},
    presence: raw.presence || {},
    phase: raw.phase || 'waiting',
    board: raw.board || emptyBoard(),
    turn: raw.turn || 'B',
    last: typeof raw.last === 'number' ? raw.last : -1,
    moves: raw.moves || 0,
    duelCount: raw.duelCount || 0,
    relocateBanned: raw.relocateBanned || '',
    duel: raw.duel || null,
    shot: raw.shot || null,
    winner: raw.winner || '',
    reason: raw.reason || '',
    rematch: raw.rematch || { B: false, W: false },
  };
}

function initialRoom(code, playerId, nickname) {
  return {
    createdAt: Date.now(),
    code,
    waitingPlayer: { id: playerId, name: nickname },
    phase: 'waiting',
    board: emptyBoard(),
    turn: 'B',
    last: -1,
    moves: 0,
    duelCount: 0,
    relocateBanned: '',
    duel: null,
    shot: null,
    presence: {},
    players: {},
    names: {},
    winner: '',
    reason: '',
    rematch: { B: false, W: false },
  };
}

function joinUpdater(current, playerId, nickname) {
  if (!current) return ABORT;

  if (current.phase === 'waiting') {
    if (current.waitingPlayer && current.waitingPlayer.id === playerId) {
      return ABORT; // 이미 대기 중인 본인
    }
    if (!current.waitingPlayer) {
      return { ...current, waitingPlayer: { id: playerId, name: nickname } };
    }
    // 두 번째 사람 입장 -> 흑/백 무작위 배정 후 게임 시작 [가정]
    const firstIsBlack = Math.random() < 0.5;
    const firstId = current.waitingPlayer.id;
    const firstName = current.waitingPlayer.name;
    const players = firstIsBlack ? { B: firstId, W: playerId } : { B: playerId, W: firstId };
    const names = firstIsBlack ? { B: firstName, W: nickname } : { B: nickname, W: firstName };
    return {
      ...current,
      waitingPlayer: null,
      players,
      names,
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

  // 이미 시작된 방: 기존 플레이어만 자기 자리로 복귀 가능
  if (current.players.B === playerId) {
    return { ...current, presence: { ...current.presence, B: true } };
  }
  if (current.players.W === playerId) {
    return { ...current, presence: { ...current.presence, W: true } };
  }
  return ABORT; // 가득 참 -> 관전
}

function deriveJoinOutcome(final, code, playerId) {
  if (!final) return { action: 'not-found', color: null, code };
  if (final.players.B === playerId) return { action: 'joined', color: 'B', code };
  if (final.players.W === playerId) return { action: 'joined', color: 'W', code };
  if (final.phase === 'waiting' && final.waitingPlayer && final.waitingPlayer.id === playerId) {
    return { action: 'waiting', color: null, code };
  }
  return { action: 'full', color: null, code };
}

// ---------- 로컬 테스트 모드 (BroadcastChannel + localStorage) ----------

function localRoomKey(code) {
  return 'omok_room_' + code;
}

function readLocalRoom(code) {
  try {
    const raw = localStorage.getItem(localRoomKey(code));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeLocalRoom(code, data) {
  if (data === null || data === undefined) {
    localStorage.removeItem(localRoomKey(code));
  } else {
    localStorage.setItem(localRoomKey(code), JSON.stringify(data));
  }
}

const localHubs = new Map();

function getLocalHub(code) {
  let hub = localHubs.get(code);
  if (hub) return hub;

  const listeners = new Set();
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel('omok_bc_' + code) : null;

  const notify = () => {
    const data = readLocalRoom(code);
    for (const fn of listeners) fn(data);
  };

  if (channel) channel.onmessage = notify;

  const storageHandler = (e) => {
    if (e.key === localRoomKey(code)) notify();
  };
  window.addEventListener('storage', storageHandler);

  hub = {
    subscribe(fn) {
      listeners.add(fn);
      fn(readLocalRoom(code));
      return () => {
        listeners.delete(fn);
      };
    },
    broadcast() {
      notify(); // 이 탭도 즉시 갱신
      if (channel) channel.postMessage({ t: Date.now() });
    },
  };
  localHubs.set(code, hub);
  return hub;
}

async function localUpdate(code, updateFn, retries = 5) {
  for (let i = 0; i < retries; i++) {
    const before = readLocalRoom(code);
    const current = before ? { ...before } : null;
    const result = updateFn(current);
    if (result === ABORT) return normalizeRoom(before);

    const check = readLocalRoom(code);
    if (JSON.stringify(check) !== JSON.stringify(before)) {
      continue; // 그 사이 다른 탭이 값을 바꿨으면 최신값으로 재시도
    }
    writeLocalRoom(code, result);
    getLocalHub(code).broadcast();
    return normalizeRoom(result);
  }
  throw new Error('로컬 동기화 충돌이 반복되어 처리하지 못했습니다. 다시 시도해 주세요.');
}

// code -> color. 탭이 닫힐 때(pagehide) 이 맵에 적힌 색만 presence=false로 내린다.
// (다시하기로 흑/백이 바뀌어도 리스너를 중복 등록하지 않고 이 맵만 갱신하면 됨)
const localPresenceMap = new Map();
let localPagehideBound = false;

function ensureLocalPagehideListener() {
  if (localPagehideBound) return;
  localPagehideBound = true;
  window.addEventListener('pagehide', () => {
    for (const [code, color] of localPresenceMap) {
      try {
        const current = readLocalRoom(code);
        if (!current) continue;
        current.presence = { ...current.presence, [color]: false };
        writeLocalRoom(code, current);
        getLocalHub(code).broadcast();
      } catch {
        /* 베스트 에포트: 종료 중이라 실패해도 무시 */
      }
    }
  });
}

function createLocalBackend(playerId) {
  return {
    mode: 'local',
    playerId,
    async update(code, updateFn) {
      return localUpdate(code, updateFn);
    },
    async peekRoom(code) {
      return normalizeRoom(readLocalRoom(code));
    },
    watchRoom(code, cb) {
      const unsub = getLocalHub(code).subscribe((raw) => cb(normalizeRoom(raw)));
      return unsub;
    },
    attachPresence(code, color) {
      ensureLocalPagehideListener();
      localPresenceMap.set(code, color);
    },
    async withWarmRoom(code, fn) {
      return fn();
    },
  };
}

// ---------- Firebase 모드 ----------

async function createFirebaseBackend(playerId) {
  const appMod = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js');
  const dbMod = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js');

  const app = appMod.initializeApp(firebaseConfig);
  const db = dbMod.getDatabase(app);

  // 연결 직후 바로 get()을 호출하면 서버 응답 전에 "없음"으로 잘못 끝나버리는 경우가 있어서,
  // 실제로 서버와 연결됐다는 신호(.info/connected)를 받을 때까지 잠깐 기다린다.
  // (최대 3초만 기다리고, 그래도 안 되면 그냥 진행 — get()이 알아서 서버에 재시도한다)
  function waitForConnected() {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      const unsub = dbMod.onValue(dbMod.ref(db, '.info/connected'), (snap) => {
        if (snap.val() === true) {
          unsub();
          finish();
        }
      });
      setTimeout(finish, 3000);
    });
  }
  const readyPromise = waitForConnected();

  function roomRef(code) {
    return dbMod.ref(db, 'rooms/' + code);
  }

  // code -> 현재 등록된 onDisconnect 핸들. 다시하기로 흑/백이 바뀌면 이전 색의 예약을 취소하고
  // 새 색으로 다시 등록해야, 나중에 내가 끊겼을 때 엉뚱하게 상대방 색의 presence가 내려가지 않는다.
  const disconnectHandles = new Map();

  await readyPromise;

  return {
    mode: 'firebase',
    playerId,
    async update(code, updateFn) {
      const result = await dbMod.runTransaction(roomRef(code), (current) => {
        const applied = updateFn(current ? normalizeRoom(current) : null);
        return applied === ABORT ? undefined : applied;
      });
      return normalizeRoom(result.snapshot.val());
    },
    async peekRoom(code) {
      const snap = await dbMod.get(roomRef(code));
      return normalizeRoom(snap.exists() ? snap.val() : null);
    },
    watchRoom(code, cb) {
      return dbMod.onValue(roomRef(code), (snap) => cb(normalizeRoom(snap.val())));
    },
    // Firebase는 그 경로를 한 번도 "구독"해본 적이 없으면, 트랜잭션이 실제 서버 값이 오기도 전에
    // null을 기준으로 판단해버리는 경우가 있다(그래서 분명히 있는 방인데도 참가가 "없음"으로 실패함).
    // 트랜잭션을 돌리는 동안 onValue로 그 경로를 "구독 중" 상태로 만들어두면 이 문제가 사라진다.
    async withWarmRoom(code, fn) {
      return new Promise((resolve, reject) => {
        let started = false;
        const unsub = dbMod.onValue(
          roomRef(code),
          async () => {
            if (started) return;
            started = true;
            try {
              const result = await fn();
              unsub();
              resolve(result);
            } catch (err) {
              unsub();
              reject(err);
            }
          },
          (err) => {
            unsub();
            reject(err);
          }
        );
      });
    },
    attachPresence(code, color) {
      const existing = disconnectHandles.get(code);
      if (existing && existing.color === color) return; // 이미 같은 색으로 등록됨
      if (existing) existing.handle.cancel();
      const handle = dbMod.onDisconnect(dbMod.ref(db, `rooms/${code}/presence/${color}`));
      handle.set(false);
      disconnectHandles.set(code, { color, handle });
    },
  };
}

// ---------- 공개 API ----------

export async function createNetwork() {
  const playerId = getPlayerId();
  const useLocal = wantsLocalMode() || !isFirebaseConfigValid(firebaseConfig);
  const backend = useLocal ? createLocalBackend(playerId) : await createFirebaseBackend(playerId);

  return {
    mode: backend.mode,
    playerId,

    getNickname,
    setNickname,

    watchRoom(code, cb) {
      return backend.watchRoom(code, cb);
    },

    peekRoom(code) {
      return backend.peekRoom(code);
    },

    update(code, updateFn) {
      return backend.update(code, updateFn);
    },

    attachPresence(code, color) {
      return backend.attachPresence(code, color);
    },

    setPresence(code, color, value) {
      return backend.update(code, (current) => {
        if (!current) return ABORT;
        return { ...current, presence: { ...current.presence, [color]: value } };
      });
    },

    async createRoom(nickname) {
      for (let i = 0; i < 10; i++) {
        const code = generateRoomCode();
        const fresh = initialRoom(code, playerId, nickname);
        const result = await backend.update(code, (current) => {
          const abandoned =
            current &&
            current.phase !== 'waiting' &&
            current.presence &&
            current.presence.B === false &&
            current.presence.W === false;
          if (!current || abandoned) return fresh;
          return ABORT;
        });
        if (result && result.code === code && result.waitingPlayer && result.waitingPlayer.id === playerId) {
          return { code };
        }
      }
      throw new Error('방 코드 생성에 반복적으로 실패했습니다. 다시 시도해 주세요.');
    },

    async joinRoom(code, nickname) {
      const upperCode = code.toUpperCase();
      return backend.withWarmRoom(upperCode, async () => {
        const existing = await backend.peekRoom(upperCode);
        if (!existing) return { action: 'not-found', color: null, code: upperCode };
        const final = await backend.update(upperCode, (current) => joinUpdater(current, playerId, nickname));
        return deriveJoinOutcome(final, upperCode, playerId);
      });
    },

  };
}
