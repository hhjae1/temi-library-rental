import { FromRobot, RequestStatus as S, ToRobot } from './protocol.js';
import { HttpError } from './rentalService.js';

// 대기열의 요청을 로봇에 하나씩 배정하고, 로봇 보고와 시간 초과에 따라 요청 상태를 진행시킨다.
export function createDispatcher({ service, robot, config, log = console }) {
  let timer = null;

  const task = (req) => ({
    requestId: req.id,
    requestType: req.type,
    itemName: req.option_label ? `${req.item_name} ${req.category_name}` : req.item_name,
    quantity: req.quantity,
    stationName: `${req.floor}층 ${req.station_name}`,
    seat: req.seat,
    location: req.temi_location,
    simTravelSec: req.sim_travel_sec, // 시뮬레이터 전용
  });

  function dispatch(req) {
    const r = service.markDispatched(req.id);
    robot.send({ type: ToRobot.GO_TO, ...task(r), attempt: r.attempts });
    log.info(`[dispatch] #${r.id} → ${r.temi_location} (시도 ${r.attempts})`);
  }

  // 처리 중인 요청이 끝나면 다음 요청 지점으로 바로 가거나 홈으로 복귀한다
  function proceed() {
    if (!robot.connected) return;
    const next = service.nextQueued();
    if (next) dispatch(next);
    else robot.send({ type: ToRobot.GO_HOME, location: config.homeLocation });
  }

  function end(req, status, reason = null) {
    service.transition(req.id, status, reason);
    robot.send({ type: ToRobot.END, requestId: req.id, status, reason });
    proceed();
  }

  function tick() {
    sweepTimeouts();
    if (robot.connected && !service.dispatched()) {
      const next = service.nextQueued();
      if (next) dispatch(next);
    }
  }

  function sweepTimeouts() {
    const now = Date.now();
    const t = config.timeouts;
    for (const r of service.openRequests()) {
      const age = now - r.status_changed_at;
      if (r.status === S.QUEUED && age > t.queueMs) service.transition(r.id, S.EXPIRED, '대기 시간 초과');
      else if (r.status === S.MOVING && age > t.moveMs) end(r, S.FAILED, '로봇 도착 시간 초과');
      else if (r.status === S.ARRIVED && age > t.arrivalMs) end(r, S.EXPIRED, '인증 대기 시간 초과');
      else if (r.status === S.VERIFIED && age > t.receiveMs) end(r, S.COMPLETED, '완료 확인 없이 자동 처리');
    }
  }

  const robotHandlers = {
    [FromRobot.HELLO](msg) {
      const active = service.dispatched();
      if (active) return robot.send({ type: ToRobot.SYNC, status: active.status, ...task(active) });
      if (msg.state && msg.state !== 'idle' && !service.nextQueued()) {
        robot.send({ type: ToRobot.GO_HOME, location: config.homeLocation });
      }
      tick();
    },

    [FromRobot.STATUS](msg) {
      const active = service.dispatched();
      if (!active || msg.requestId !== active.id || active.status !== S.MOVING) return; // 지난 요청 보고는 무시
      if (msg.state === 'arrived') {
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
        result = { ok: false, reason: '코드가 일치하지 않습니다.' };
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
      if (req.status === S.MOVING || req.status === S.ARRIVED) return end(req, S.CANCELLED, '사용자 취소');
      throw new HttpError(409, '취소할 수 없는 상태입니다.');
    },

    completeByUser(id, userId) {
      service.getOwnedRequest(id, userId);
      complete(id);
    },
  };
}
