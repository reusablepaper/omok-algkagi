// 알까기 물리 시뮬레이션 (결정론적: 사칙연산과 제곱근만 사용)
// 좌표계: 정사각형 판, 중심이 (0,0)이고 절반 길이가 BOARD_HALF인 논리 좌표.
// 마찰은 실제 바닥 마찰처럼 "속도 크기와 무관하게 매초 일정량씩 줄어드는" 방식으로 적용한다.
// (속도에 비례해서 깎으면 세게 쳐도 약하게 쳐도 멈출 때까지 걸리는 시간이 거의 비슷해져서
//  "세게 칠수록 더 멀리, 더 오래 구른다"는 체감이 사라지기 때문)

// BOARD_HALF를 키우면(= 알에 비해 판이 넓어지면) 오목판과 비슷한 "돌:판" 비율이 된다.
// 체감 속도·소요 시간을 그대로 유지하기 위해 MAX_SPEED와 FRICTION_DECEL도 같은 배율로 늘렸다
// (둘의 비율 MAX_SPEED/FRICTION_DECEL = 걸리는 시간이 그대로 유지되고, 이동 거리만 늘어난다).
export const BOARD_HALF = 100;
export const MARBLE_R = 4.5;
export const FRICTION_DECEL = 100; // 마찰에 의한 감속량 (초당 world-unit)
export const MAX_SPEED = 180;
export const MAX_PULL = 50; // 당기는 거리 상한 (이 거리 이상 당겨도 세기는 더 안 커짐)
export const DT = 1 / 60;
export const MAX_STEPS = 60 * 3; // 안전장치: 최대 3초치 프레임 (실제로는 그 전에 다 멈춘다)

// 각자 자기 판 절반의 중앙에서 시작 (B는 위쪽 절반, W는 아래쪽 절반)
export function startPositions() {
  return {
    B: { x: 0, y: -BOARD_HALF / 2 },
    W: { x: 0, y: BOARD_HALF / 2 },
  };
}

function speed(p) {
  return Math.sqrt(p.vx * p.vx + p.vy * p.vy);
}

function snapshot(pos) {
  return {
    B: { x: pos.B.x, y: pos.B.y, out: pos.B.out },
    W: { x: pos.W.x, y: pos.W.y, out: pos.W.out },
  };
}

function allStopped(pos) {
  const bDone = pos.B.out || (pos.B.vx === 0 && pos.B.vy === 0);
  const wDone = pos.W.out || (pos.W.vx === 0 && pos.W.vy === 0);
  return bDone && wDone;
}

function advance(pos) {
  for (const c of ['B', 'W']) {
    const p = pos[c];
    if (p.out) {
      p.vx = 0;
      p.vy = 0;
      continue;
    }
    const spd = speed(p);
    if (spd > 0) {
      const nextSpd = Math.max(0, spd - FRICTION_DECEL * DT);
      const scale = nextSpd / spd;
      p.vx *= scale;
      p.vy *= scale;
    }
    p.x += p.vx * DT;
    p.y += p.vy * DT;
  }

  // 충돌 처리 (질량이 같은 완전탄성충돌: 충돌 법선 방향 속도 성분을 서로 교환 -> 넉백)
  if (!pos.B.out && !pos.W.out) {
    const dx = pos.W.x - pos.B.x;
    const dy = pos.W.y - pos.B.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const minDist = MARBLE_R * 2;
    if (dist > 0 && dist < minDist) {
      const nx = dx / dist;
      const ny = dy / dist;
      const overlap = (minDist - dist) / 2;
      pos.B.x -= nx * overlap;
      pos.B.y -= ny * overlap;
      pos.W.x += nx * overlap;
      pos.W.y += ny * overlap;

      const bn = pos.B.vx * nx + pos.B.vy * ny;
      const wn = pos.W.vx * nx + pos.W.vy * ny;
      pos.B.vx += (wn - bn) * nx;
      pos.B.vy += (wn - bn) * ny;
      pos.W.vx += (bn - wn) * nx;
      pos.W.vy += (bn - wn) * ny;
    }
  }

  // 판 밖 탈락 판정 (중심점 기준)
  for (const c of ['B', 'W']) {
    const p = pos[c];
    if (!p.out && (Math.abs(p.x) > BOARD_HALF || Math.abs(p.y) > BOARD_HALF)) {
      p.out = true;
    }
  }
}

/**
 * startPos: {B:{x,y}, W:{x,y}}  shooterColor: 'B'|'W'  vx,vy: 발사 속도
 * 반환: { steps: [...매 프레임 위치], final: {B:{x,y,out}, W:{x,y,out}} }
 * 같은 입력이면 어느 기기에서 실행해도 항상 같은 결과가 나온다.
 */
export function simulateDuel(startPos, shooterColor, vx, vy) {
  const pos = {
    B: { x: startPos.B.x, y: startPos.B.y, vx: 0, vy: 0, out: false },
    W: { x: startPos.W.x, y: startPos.W.y, vx: 0, vy: 0, out: false },
  };
  pos[shooterColor].vx = vx;
  pos[shooterColor].vy = vy;

  const steps = [snapshot(pos)];
  for (let i = 0; i < MAX_STEPS; i++) {
    advance(pos);
    steps.push(snapshot(pos));
    if (allStopped(pos)) break;
  }

  return {
    steps,
    final: {
      B: { x: pos.B.x, y: pos.B.y, out: pos.B.out },
      W: { x: pos.W.x, y: pos.W.y, out: pos.W.out },
    },
  };
}

/**
 * 당긴 벡터(pullDx, pullDy: 알 위치 -> 드래그 지점)로부터 발사 속도를 계산한다.
 * 당긴 거리가 세기이며, 당긴 반대 방향으로 발사된다.
 */
export function computeShotVelocity(pullDx, pullDy) {
  const dist = Math.sqrt(pullDx * pullDx + pullDy * pullDy);
  if (dist < 0.0001) return { vx: 0, vy: 0 };
  const clamped = Math.min(dist, MAX_PULL);
  const power = clamped / MAX_PULL;
  const spd = power * MAX_SPEED;
  const ux = -pullDx / dist;
  const uy = -pullDy / dist;
  return { vx: ux * spd, vy: uy * spd };
}

// ---------- 손떨림 게이지 ----------
// gaugeValue: -1(맨 아래, 힘풀림) ~ 0(정중앙, 정확) ~ +1(맨 위, 삐끗함)
export const TREMOR_DEAD_ZONE = 0.06; // 정중앙 부근은 봐준다
export const TREMOR_MAX_POWER_LOSS = 0.8; // 맨 아래에서 최대 80%까지 힘이 빠짐
export const TREMOR_MAX_DEVIATION = 1; // 맨 위에서의 최대 방향 틀어짐 계수(1 = 약 45도 상당)

/**
 * 손떨림 게이지 값(gaugeValue)에 따라 발사 속도를 보정한다.
 * 가운데(0)면 그대로, 아래쪽(-)이면 방향은 유지한 채 세기만 줄고,
 * 위쪽(+)이면 세기는 유지한 채 방향만 틀어진다.
 * 삼각함수 없이(사칙연산+제곱근만) 수직 성분을 섞어 방향을 근사적으로 회전시킨다.
 */
export function applyHandTremor(vx, vy, gaugeValue) {
  const spd = Math.sqrt(vx * vx + vy * vy);
  if (spd < 0.0001) return { vx, vy };

  const g = Math.max(-1, Math.min(1, gaugeValue));
  if (Math.abs(g) <= TREMOR_DEAD_ZONE) return { vx, vy };

  if (g < 0) {
    const t = (-g - TREMOR_DEAD_ZONE) / (1 - TREMOR_DEAD_ZONE);
    const factor = 1 - t * TREMOR_MAX_POWER_LOSS;
    return { vx: vx * factor, vy: vy * factor };
  }

  const t = (g - TREMOR_DEAD_ZONE) / (1 - TREMOR_DEAD_ZONE);
  const k = t * TREMOR_MAX_DEVIATION;
  const ux = vx / spd;
  const uy = vy / spd;
  const nx = ux - k * uy;
  const ny = uy + k * ux;
  const nlen = Math.sqrt(nx * nx + ny * ny);
  return { vx: (nx / nlen) * spd, vy: (ny / nlen) * spd };
}

/**
 * 발사 결과(shooterColor 기준)로 이번 샷의 승패를 판정한다.
 * 반환: 'shooter-win' | 'shooter-lose' | null(계속 진행, 상대 차례)
 */
export function judgeShotResult(finalPos, shooterColor) {
  const other = shooterColor === 'B' ? 'W' : 'B';
  if (finalPos[shooterColor].out) return 'shooter-lose';
  if (finalPos[other].out) return 'shooter-win';
  return null;
}
