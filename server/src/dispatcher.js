import { AT_HOME_STATES, DeskState, FromRobot, RequestStatus as S, ToRobot } from './protocol.js';
import { HttpError } from './rentalService.js';

// 대기열의 요청을 로봇에 하나씩 배정하고, 로봇 보고와 시간 초과에 따라 요청 상태를 진행시킨다.
// 물품은 대여 데스크(홈베이스)에서 바구니에 담으므로, 로봇이 홈베이스에 있을 때만 다음 요청을 배정한다.
// 끝난 요청의 바구니 처리(회수·확인)가 남아 있으면 그것부터 받는다.
export function createDispatcher({ service, robot, config, log = console }) {
  let timer = null;
  let lastDeskKey = null; // 같은 데스크 지시를 2초마다 다시 보내지 않으려고 기억한다

  const task = (req) => ({
    requestId: req.id,
    requestType: req.type,
    itemName: req.option_label ? `${req.item_name} ${req.category_name}` : req.item_name,
    itemKind: req.item_kind,
    quantity: req.quantity,
    area: config.serviceArea,
    zoneName: req.zone_name,
    seat: req.seat,
    location: req.temi_location,
    simTravelSec: req.sim_travel_sec, // 시뮬레이터 전용
  });

  const atHome = () => robot.connected && AT_HOME_STATES.includes(robot.snapshot().state);
  const goHome = () => robot.send({ type: ToRobot.GO_HOME, location: config.homeLocation });

  // 첫 시도(attempt 1)는 TEMI 화면에서 출발 버튼을 눌러야 출발한다. 이동 실패 후 재시도는 바로 다시 이동한다.
  // immediate: 회수·싣기 완료 버튼 하나로 이미 출발을 누른 경우
  function dispatch(req, { immediate = false } = {}) {
    const r = service.markDispatched(req.id);
    robot.send({ type: ToRobot.GO_TO, ...task(r), attempt: r.attempts, immediate });
    log.info(`[dispatch] #${r.id} → ${r.temi_location} (시도 ${r.attempts})`);
  }

  function dispatchNext(immediateId = null) {
    if (!atHome() || service.dispatched()) return;
    const next = service.nextQueued();
    const desk = service.nextDeskTask();
    if (desk) return sendDesk(desk, next);
    lastDeskKey = null;
    if (next) dispatch(next, { immediate: next.id === immediateId });
  }

  // 회수 완료 버튼 하나로 다음 요청까지 출발할 수 있게 다음 요청을 같이 보낸다. 바구니 확인은 고른 뒤 출발 준비 화면으로 간다.
  function sendDesk(desk, next) {
    const shown = desk.desk_state === DeskState.COLLECT ? next : null;
    const key = `${desk.id}:${desk.desk_state}:${shown?.id ?? ''}`;
    if (key === lastDeskKey) return;
    lastDeskKey = key;
    robot.send({
      type: ToRobot.DESK,
      ...task(desk),
      mode: desk.desk_state,
      reason: desk.fail_reason,
      next: shown ? task(shown) : null,
    });
  }

  // 요청이 끝나면 홈베이스에 있으면 다음 요청을 배정하고, 밖에 있으면 홈베이스로 돌려보낸다
  function proceed() {
    if (!robot.connected) return;
    if (atHome()) dispatchNext();
    else goHome();
  }

  function end(req, status, reason = null) {
    service.transition(req.id, status, reason);
    robot.send({ type: ToRobot.END, requestId: req.id, status, reason });
    proceed();
  }

  function tick() {
    sweepTimeouts();
    dispatchNext();
  }

  function sweepTimeouts() {
    const now = Date.now();
    const t = config.timeouts;
    for (const { id } of service.openRequests()) {
      const r = service.getRequest(id); // 앞선 처리로 상태가 바뀌었을 수 있으니 다시 읽는다
      const age = now - r.status_changed_at;
      const rental = r.type === 'rental';
      if (r.status === S.QUEUED && age > t.queueMs) service.transition(r.id, S.EXPIRED, '대기 시간 초과');
      else if (r.status === S.PREPARING && age > t.prepareMs) end(r, S.EXPIRED, '출발 대기 시간 초과');
      else if (r.status === S.MOVING && age > t.moveMs) end(r, S.FAILED, '로봇 도착 시간 초과');
      else if (r.status === S.ARRIVED && age > t.arrivalMs) end(r, S.EXPIRED, rental ? 'QR 인증 대기 시간 초과' : '반납 확인 없이 만료 · 바구니 확인 필요');
      else if (r.status === S.VERIFIED && age > t.receiveMs) end(r, S.EXPIRED, '수령 확인 없이 만료 · 바구니 확인 필요');
    }
  }

  const robotHandlers = {
    [FromRobot.HELLO](msg) {
      lastDeskKey = null; // 다시 연결되면 화면을 다시 알려 준다
      const active = service.dispatched();
      if (active) return robot.send({ type: ToRobot.SYNC, status: active.status, ...task(active), attempt: active.attempts });
      if (!AT_HOME_STATES.includes(msg.state ?? 'idle')) return goHome(); // 밖에서 다시 연결되면 일단 데스크로
      tick();
    },

    [FromRobot.STATUS](msg) {
      if (msg.state === 'idle') return dispatchNext(); // 홈베이스에 도착 → 다음 요청
      const active = service.dispatched();
      if (!active || msg.requestId !== active.id) return; // 지난 요청 보고는 무시
      if (msg.state === 'moving' && active.status === S.PREPARING) {
        service.transition(active.id, S.MOVING); // 출발 버튼을 눌렀다
      } else if (active.status !== S.MOVING) {
        return;
      } else if (msg.state === 'arrived') {
        service.transition(active.id, S.ARRIVED);
      } else if (msg.state === 'failed') {
        if (active.attempts < config.maxMoveAttempts) {
          log.warn(`[dispatch] #${active.id} 이동 실패, 재시도: ${msg.detail ?? ''}`);
          dispatch(active);
        } else {
          end(active, S.FAILED, msg.detail ?? '로봇 이동 실패');
        }
      }
    },

    [FromRobot.VERIFY](msg) {
      const active = service.dispatched();
      let result;
      // QR 인증은 물품을 받는 대여 학생만 한다
      if (!active || active.id !== msg.requestId || active.status !== S.ARRIVED || active.type !== 'rental') {
        result = { ok: false, reason: '인증할 수 있는 요청이 없습니다.' };
      } else if (!service.matchesCode(active, msg.code)) {
        result = { ok: false, reason: 'QR 코드가 일치하지 않습니다.' };
      } else {
        service.transition(active.id, S.VERIFIED);
        result = { ok: true };
      }
      robot.send({ type: ToRobot.VERIFY_RESULT, requestId: msg.requestId, ...result });
    },

    [FromRobot.COMPLETE](msg) {
      complete(msg.requestId);
    },

    [FromRobot.COLLECTED](msg) {
      try {
        service.resolveDesk(msg.requestId, msg.found);
      } catch (err) {
        log.warn(`[robot] 데스크 처리 실패: ${err.message}`); // 이미 처리된 요청이면 화면만 풀어 준다
      }
      lastDeskKey = null;
      robot.send({ type: ToRobot.DESK_DONE, requestId: msg.requestId });
      dispatchNext(msg.nextRequestId ?? null);
    },
  };

  robot.onMessage((msg) => {
    try {
      robotHandlers[msg.type]?.(msg);
    } catch (err) {
      log.warn(`[robot] ${msg.type} 처리 실패: ${err.message}`);
    }
  });

  function complete(requestId) {
    const active = service.dispatched();
    // 대여는 QR 인증 뒤에, 반납은 도착하면 바로 완료할 수 있다
    const completable = active?.type === 'rental' ? S.VERIFIED : S.ARRIVED;
    if (!active || active.id !== requestId || active.status !== completable) {
      throw new HttpError(409, '완료할 수 있는 상태가 아닙니다.');
    }
    end(active, S.COMPLETED);
  }

  return {
    tick,
    start() {
      timer = setInterval(() => {
        try {
          tick();
        } catch (err) {
          log.error('[dispatch]', err);
        }
      }, config.sweepIntervalMs);
    },
    stop: () => clearInterval(timer),

    cancelByUser(id, userId) {
      const req = service.getOwnedRequest(id, userId);
      if (req.status === S.QUEUED) return service.transition(id, S.CANCELLED, '사용자 취소');
      if ([S.PREPARING, S.MOVING, S.ARRIVED].includes(req.status)) return end(req, S.CANCELLED, '사용자 취소');
      throw new HttpError(409, '취소할 수 없는 상태입니다.');
    },

    completeByUser(id, userId) {
      service.getOwnedRequest(id, userId);
      complete(id);
    },
  };
}
