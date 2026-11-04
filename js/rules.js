// 렌주룰 판정 로직 (오목판 19x19)
// 보드는 길이 361의 문자열/배열이며 각 칸은 '.', 'B', 'W' 중 하나입니다.

export const SIZE = 19;
export const EMPTY = '.';
export const BLACK = 'B';
export const WHITE = 'W';

export function toIndex(x, y) {
  return y * SIZE + x;
}

export function toXY(index) {
  return { x: index % SIZE, y: Math.floor(index / SIZE) };
}

export function inBounds(x, y) {
  return x >= 0 && x < SIZE && y >= 0 && y < SIZE;
}

export function emptyBoard() {
  return EMPTY.repeat(SIZE * SIZE);
}

export function centerIndex() {
  const half = Math.floor(SIZE / 2);
  return toIndex(half, half);
}

const DIRECTIONS = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
];

const RADIUS = 5; // 중심에서 좌우로 5칸씩, 총 11칸을 본다.

// 한 방향의 직선을 중심(index, 새로 놓일 돌)을 기준으로 11칸짜리 문자 배열로 뽑는다.
// 'X' = 판정 대상 색(새 돌 포함), '#' = 상대 돌 또는 판 밖(막힘), '.' = 빈칸
function extractLine(board, index, color, dx, dy) {
  const { x, y } = toXY(index);
  const chars = new Array(RADIUS * 2 + 1);
  for (let offset = -RADIUS; offset <= RADIUS; offset++) {
    const nx = x + dx * offset;
    const ny = y + dy * offset;
    const pos = offset + RADIUS;
    if (offset === 0) {
      chars[pos] = 'X';
      continue;
    }
    if (!inBounds(nx, ny)) {
      chars[pos] = '#';
      continue;
    }
    const cell = board[toIndex(nx, ny)];
    if (cell === EMPTY) chars[pos] = '.';
    else if (cell === color) chars[pos] = 'X';
    else chars[pos] = '#';
  }
  return chars;
}

// chars 배열의 pos 위치가 'X'라고 가정하고, 거기서 좌우로 이어지는 연속 개수를 센다.
function runLengthAt(chars, pos) {
  let left = pos;
  while (left - 1 >= 0 && chars[left - 1] === 'X') left--;
  let right = pos;
  while (right + 1 < chars.length && chars[right + 1] === 'X') right++;
  return right - left + 1;
}

// 한 방향에서: 정확히 5, 장목(6+), 사(4+빈칸1=5 완성), 열린삼 여부를 계산한다.
function analyzeLine(chars) {
  const center = RADIUS;
  const runLen = runLengthAt(chars, center);

  let hasFour = false;
  // 4-연속 + 빈칸 1개 = 5 완성이 되는 지점(사)을 찾는다. (사목이 아니라 '정확히 5'가 되는 경우만 인정)
  for (let s = Math.max(0, center - 4); s <= Math.min(center, chars.length - 5); s++) {
    const window = chars.slice(s, s + 5);
    const xCount = window.filter((c) => c === 'X').length;
    const dotIdx = window.indexOf('.');
    if (xCount === 4 && dotIdx !== -1 && window.filter((c) => c === '#').length === 0) {
      const globalDot = s + dotIdx;
      const before = chars[globalDot - 1];
      const temp = chars.slice();
      temp[globalDot] = 'X';
      const completedRun = runLengthAt(temp, globalDot);
      if (completedRun === 5) {
        hasFour = true;
      }
      void before;
    }
  }

  let hasOpenThree = false;
  // 단순 열린삼: . X X X .
  for (let s = Math.max(0, center - 4); s <= Math.min(center, chars.length - 5); s++) {
    const w = chars.slice(s, s + 5);
    if (w[0] === '.' && w[1] === 'X' && w[2] === 'X' && w[3] === 'X' && w[4] === '.') {
      hasOpenThree = true;
    }
  }
  // 끊긴 열린삼: . X X . X .  /  . X . X X .
  for (let s = Math.max(0, center - 5); s <= Math.min(center, chars.length - 6); s++) {
    const w = chars.slice(s, s + 6);
    const a = w[0] === '.' && w[1] === 'X' && w[2] === 'X' && w[3] === '.' && w[4] === 'X' && w[5] === '.';
    const b = w[0] === '.' && w[1] === 'X' && w[2] === '.' && w[3] === 'X' && w[4] === 'X' && w[5] === '.';
    if (a || b) hasOpenThree = true;
  }

  return {
    five: runLen === 5,
    overline: runLen >= 6,
    four: hasFour,
    openThree: hasOpenThree,
  };
}

/**
 * index 자리에 color 돌을 놓았다고 가정하고 5목 여부를 판정한다.
 * 흑은 정확히 5개 연속일 때만, 백은 5개 이상 연속이면 5목으로 인정한다.
 */
export function isFive(board, index, color) {
  for (const [dx, dy] of DIRECTIONS) {
    const chars = extractLine(board, index, color, dx, dy);
    const { five, overline } = analyzeLine(chars);
    if (color === BLACK) {
      if (five) return true;
    } else {
      if (five || overline) return true;
    }
  }
  return false;
}

/**
 * 흑이 index 자리에 두었을 때 금수인지 판정한다. (백은 금수가 없으므로 호출하지 않는다)
 * 반환값: { forbidden, reason } reason은 'overline' | 'double-four' | 'double-three' | null
 */
export function getForbiddenInfo(board, index) {
  // 정확한 5목이 되는 수는 3-3/4-4가 같이 생겨도 허용(5목 우선)
  if (isFive(board, index, BLACK)) {
    return { forbidden: false, reason: null };
  }

  let overline = false;
  let fourCount = 0;
  let threeCount = 0;

  for (const [dx, dy] of DIRECTIONS) {
    const chars = extractLine(board, index, BLACK, dx, dy);
    const info = analyzeLine(chars);
    if (info.overline) overline = true;
    if (info.four) fourCount++;
    if (info.openThree) threeCount++;
  }

  if (overline) return { forbidden: true, reason: 'overline' };
  if (fourCount >= 2) return { forbidden: true, reason: 'double-four' };
  if (threeCount >= 2) return { forbidden: true, reason: 'double-three' };
  return { forbidden: false, reason: null };
}

/**
 * color가 index에 둘 수 있는지 (빈칸 + 금수 아님) 종합 판정.
 */
export function isLegalMove(board, index, color) {
  if (board[index] !== EMPTY) return false;
  if (color === BLACK) {
    return !getForbiddenInfo(board, index).forbidden;
  }
  return true;
}

export function reasonLabel(reason) {
  switch (reason) {
    case 'double-three':
      return '3-3 금수';
    case 'double-four':
      return '4-4 금수';
    case 'overline':
      return '장목 금수';
    default:
      return '둘 수 없는 자리';
  }
}

export function placeStone(board, index, color) {
  return board.slice(0, index) + color + board.slice(index + 1);
}

export function removeStone(board, index) {
  return board.slice(0, index) + EMPTY + board.slice(index + 1);
}

export function isBoardFull(board) {
  return board.indexOf(EMPTY) === -1;
}
