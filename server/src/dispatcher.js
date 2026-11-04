import { AT_HOME_STATES, FromRobot, RequestStatus as S, ToRobot } from './protocol.js';
import { HttpError } from './rentalService.js';

// 대기열의 요청을 로봇에 하나씩 배정하고, 로봇 보고와 시간 초과에 따라 요청 상태를 진행시킨다.
// 물품은 대여 데스크(홈베이스)에서 바구니에 담으므로, 로봇이 홈베이스에 있을 때만 다음 요청을 배정한다.
export function createDispatcher({ service, robot, config, log = console }) {
  let timer = null;

  const task = (req) => ({
    requestId: req.id,
    requestType: req.type,
    itemName: req.option_label ? `${req.item_name} ${req.category_name}` : req.item_name,
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
  function dispatch(req) {
    const r = service.markDispatched(req.id);
    robot.send({ type: ToRobot.GO_TO, ...task(r), attempt: r.attempts });
    log.info(`[dispatch] #${r.id} → ${r.temi_location} (시도 ${r.attempts})`);
  }

  function dispatchNext() {
    if (!atHome() || service.dispatched()) return;
    const next = service.nextQueued();
    if (next) dispatch(next);
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
      const unconfirmed = r.type === 'rental' ? '수령 확인 없이 만료 · 바구니 확인 필요' : '반납 확인 없이 만료 · 바구니 확인 필요';
      if (r.status === S.QUEUED && age > t.queueMs) service.transition(r.id, S.EXPIRED, '대기 시간 초과');
      else if (r.status === S.PREPARING && age > t.prepareMs) end(r, S.EXPIRED, '출발 대기 시간 초과');
      else if (r.status === S.MOVING && age > t.moveMs) end(r, S.FAILED, '로봇 도착 시간 초과');
      else if (r.status === S.ARRIVED && age > t.arrivalMs) end(r, S.EXPIRED, 'QR 인증 대기 시간 초과');
      else if (r.status === S.VERIFIED && age > t.receiveMs) end(r, S.EXPIRED, unconfirmed);
    }
  }

  const robotHandlers = {
    [FromRobot.HELLO](msg) {
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
      if (!active || active.id !== msg.requestId || active.status !== S.ARRIVED) {
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
    if (!active || active.id !== requestId || active.status !== S.VERIFIED) {
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
