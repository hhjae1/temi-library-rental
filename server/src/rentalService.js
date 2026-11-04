import { randomBytes, randomInt } from 'node:crypto';
import { transaction } from './db.js';
import {
  DeskState,
  DISPATCHED_STATUSES,
  OPEN_STATUSES,
  RentalStatus,
  RequestStatus as S,
  TERMINAL_STATUSES,
  qrPayload,
} from './protocol.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const inList = (values) => values.map((v) => `'${v}'`).join(',');

const ITEM_COLUMNS = `
  i.name AS item_name, i.detail AS item_detail, i.category_id,
  c.name AS category_name, c.option_label, c.kind AS item_kind, c.illustration`;

const REQUEST_SELECT = `
  SELECT r.*, ${ITEM_COLUMNS},
         z.name AS zone_name, z.temi_location, z.sim_travel_sec
  FROM requests r
  JOIN items i ON i.id = r.item_id
  JOIN categories c ON c.id = i.category_id
  JOIN zones z ON z.id = r.zone_id`;

const RENTAL_SELECT = `
  SELECT t.*, ${ITEM_COLUMNS}, z.name AS zone_name
  FROM rentals t
  JOIN items i ON i.id = t.item_id
  JOIN categories c ON c.id = i.category_id
  LEFT JOIN zones z ON z.id = t.zone_id`;

// 재고·요청·대여 기록을 다루는 도메인 로직. 로봇과의 통신은 dispatcher가 맡는다.
export function createRentalService(db, bus) {
  const sql = {
    categories: db.prepare('SELECT * FROM categories ORDER BY sort, id'),
    items: db.prepare(`SELECT i.*, c.name AS category_name, c.kind FROM items i JOIN categories c ON c.id = i.category_id ORDER BY c.sort, i.id`),
    item: db.prepare(`SELECT i.*, c.max_quantity FROM items i JOIN categories c ON c.id = i.category_id WHERE i.id = ?`),
    reserveItem: db.prepare('UPDATE items SET stock = stock - ? WHERE id = ? AND stock >= ?'),
    restockItem: db.prepare('UPDATE items SET stock = stock + ? WHERE id = ?'),
    setStock: db.prepare('UPDATE items SET stock = ? WHERE id = ?'),
    zones: db.prepare('SELECT * FROM zones WHERE active = 1 ORDER BY seat_from, id'),
    zoneForSeat: db.prepare('SELECT * FROM zones WHERE active = 1 AND ? BETWEEN seat_from AND seat_to ORDER BY id LIMIT 1'),

    request: db.prepare(`${REQUEST_SELECT} WHERE r.id = ?`),
    requestsOfUser: db.prepare(`${REQUEST_SELECT} WHERE r.user_id = ? ORDER BY r.id DESC LIMIT 50`),
    recentRequests: db.prepare(`${REQUEST_SELECT} ORDER BY r.id DESC LIMIT 100`),
    openRequests: db.prepare(`${REQUEST_SELECT} WHERE r.status IN (${inList(OPEN_STATUSES)}) ORDER BY r.id`),
    nextQueued: db.prepare(`${REQUEST_SELECT} WHERE r.status = 'queued' ORDER BY r.id LIMIT 1`),
    dispatched: db.prepare(`${REQUEST_SELECT} WHERE r.status IN (${inList(DISPATCHED_STATUSES)}) ORDER BY r.id LIMIT 1`),
    openCountOfUser: db.prepare(
      `SELECT COUNT(*) AS n FROM requests WHERE user_id = ? AND status IN (${inList(OPEN_STATUSES)})`,
    ),
    insertRequest: db.prepare(`
      INSERT INTO requests (type, user_id, item_id, quantity, zone_id, seat, rental_id, status, qr_token, pin,
                            created_at, updated_at, status_changed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`),
    setStatus: db.prepare(
      'UPDATE requests SET status = ?, fail_reason = ?, updated_at = ?, status_changed_at = ? WHERE id = ?',
    ),
    setArrivedAt: db.prepare('UPDATE requests SET arrived_at = ? WHERE id = ?'),
    setDeskState: db.prepare('UPDATE requests SET desk_state = ? WHERE id = ?'),
    resolveDesk: db.prepare(`UPDATE requests SET desk_state = 'done', desk_found = ?, desk_resolved_at = ?, fail_reason = ? WHERE id = ?`),
    nextDeskTask: db.prepare(`${REQUEST_SELECT} WHERE r.desk_state IN ('collect', 'check') ORDER BY r.id LIMIT 1`),
    setDepartedAt: db.prepare('UPDATE requests SET departed_at = ? WHERE id = ?'),
    // 배정되면 출발 준비 상태가 된다. 실제 이동은 TEMI 화면의 출발 버튼(status: moving) 이후
    markDispatched: db.prepare(
      `UPDATE requests SET status = 'preparing', attempts = attempts + 1, dispatched_at = ?, updated_at = ?, status_changed_at = ?
       WHERE id = ?`,
    ),
    linkRental: db.prepare('UPDATE requests SET rental_id = ? WHERE id = ?'),

    rental: db.prepare(`${RENTAL_SELECT} WHERE t.id = ?`),
    insertRental: db.prepare(
      'INSERT INTO rentals (user_id, item_id, quantity, zone_id, seat, status, rented_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ),
    setRentalStatus: db.prepare('UPDATE rentals SET status = ? WHERE id = ?'),
    markReturned: db.prepare(`UPDATE rentals SET status = 'returned', returned_at = ? WHERE id = ?`),
    markInspected: db.prepare(`UPDATE rentals SET status = 'inspected', inspected_at = ? WHERE id = ?`),
  };

  // QR 토큰과 PIN은 본인 조회(GET /api/requests/:id)에서만 내려준다.
  const toPublic = (row) => {
    if (!row) return row;
    const { qr_token, pin, ...rest } = row;
    return rest;
  };

  const emitRequest = (id) => bus.emit('request', toPublic(sql.request.get(id)));
  const emitItems = () => bus.emit('items', sql.items.all());
  const emitRental = (id) => bus.emit('rental', sql.rental.get(id));

  function getRequest(id) {
    const row = sql.request.get(id);
    if (!row) throw new HttpError(404, '없는 요청입니다.');
    return row;
  }

  function getOwnedRequest(id, userId) {
    const row = sql.request.get(id);
    if (!row || row.user_id !== userId) throw new HttpError(404, '없는 요청입니다.');
    return row;
  }

  // 학생은 좌석 번호만 입력한다. 번호가 속한 구역이 temi가 찾아갈 지점이다.
  function placeOf(value) {
    const text = String(value ?? '').trim();
    if (!/^[0-9]{1,4}$/.test(text)) throw new HttpError(400, '좌석 번호를 숫자로 입력해주세요.');
    const seat = String(Number(text)); // "007" → "7"
    const zone = sql.zoneForSeat.get(Number(seat));
    if (!zone) throw new HttpError(400, `${seat}번은 서비스 구역의 좌석이 아니에요. 좌석 번호를 확인해주세요.`);
    return { seat, zoneId: zone.id };
  }

  // 1차 프로토타입은 사용자당 진행 중인 요청 1건만 허용한다.
  function requireNoOpenRequest(userId) {
    if (sql.openCountOfUser.get(userId).n > 0) {
      throw new HttpError(409, '진행 중인 요청이 끝난 뒤 다시 신청해 주세요.');
    }
  }

  function insertRequest({ type, userId, itemId, quantity, zoneId, seat, rentalId = null }) {
    const now = Date.now();
    const token = randomBytes(12).toString('hex');
    const pin = String(randomInt(0, 10_000)).padStart(4, '0');
    return Number(
      sql.insertRequest.run(type, userId, itemId, quantity, zoneId, seat, rentalId, token, pin, now, now, now)
        .lastInsertRowid,
    );
  }

  function catalog() {
    const items = sql.items.all();
    return sql.categories.all().map((c) => {
      const options = items.filter((i) => i.category_id === c.id);
      return { ...c, needs_guide: Boolean(c.needs_guide), stock: options.reduce((n, i) => n + i.stock, 0), items: options };
    });
  }

  function createRentalRequest({ userId, itemId, quantity = 1, seat }) {
    const item = sql.item.get(itemId);
    if (!item) throw new HttpError(404, '없는 물품입니다.');
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > item.max_quantity) {
      throw new HttpError(400, `한 번에 ${item.max_quantity}개까지 신청할 수 있어요.`);
    }
    const place = placeOf(seat);
    requireNoOpenRequest(userId);
    const id = transaction(db, () => {
      // 재고를 신청 시점에 예약한다. 실패·취소·만료되면 transition()에서 복구된다.
      if (sql.reserveItem.run(quantity, itemId, quantity).changes === 0) throw new HttpError(409, '남은 재고가 부족해요.');
      return insertRequest({ type: 'rental', userId, itemId, quantity, ...place });
    });
    emitItems();
    emitRequest(id);
    return toPublic(sql.request.get(id));
  }

  function createReturnRequest({ userId, rentalId, seat }) {
    const rental = sql.rental.get(rentalId);
    if (!rental || rental.user_id !== userId) throw new HttpError(404, '없는 대여 기록입니다.');
    if (rental.status !== RentalStatus.ACTIVE) throw new HttpError(409, '반납할 수 있는 상태가 아닙니다.');
    const place = placeOf(seat);
    requireNoOpenRequest(userId);
    const id = transaction(db, () => {
      sql.setRentalStatus.run(RentalStatus.RETURNING, rentalId);
      return insertRequest({
        type: 'return', userId, itemId: rental.item_id, quantity: rental.quantity, ...place, rentalId,
      });
    });
    emitRental(rentalId);
    emitRequest(id);
    return toPublic(sql.request.get(id));
  }

  // 요청이 끝날 때 바구니에 물건이 있는지 정한다. temi에는 바구니를 볼 센서가 없어 끝난 상황으로 판단한다.
  //  대여: 출발했는데 못 건넸으면 있음, 인증 후 대여 완료 없이 시간이 지나면 모름
  //  반납: 반납 완료면 있음, 도착 후 반납 완료 없이 시간이 지나면 모름, 그 밖에는 없음
  function deskStateFor(req, to) {
    if (!TERMINAL_STATUSES.includes(to)) return null;
    if (req.type === 'return') {
      if (to === S.COMPLETED) return DeskState.COLLECT;
      return to === S.EXPIRED && req.status === S.ARRIVED ? DeskState.CHECK : null;
    }
    if (to === S.COMPLETED) return null;
    if (req.status === S.VERIFIED) return DeskState.CHECK;
    return req.departed_at ? DeskState.COLLECT : null;
  }

  // 상태 전이와 그에 따른 재고·대여 기록 변경을 한 트랜잭션으로 처리한다.
  // 바구니 처리가 남은 요청의 재고·대여 기록은 데스크에서 resolveDesk()로 정한다.
  function transition(id, to, reason = null) {
    const req = getRequest(id);
    if (TERMINAL_STATUSES.includes(req.status)) throw new HttpError(409, '이미 종료된 요청입니다.');
    let rentalId = req.rental_id;
    const desk = deskStateFor(req, to);
    transaction(db, () => {
      const now = Date.now();
      sql.setStatus.run(to, reason, now, now, id);
      if (desk) sql.setDeskState.run(desk, id);
      if (to === S.MOVING) sql.setDepartedAt.run(now, id);
      if (to === S.ARRIVED) sql.setArrivedAt.run(now, id);
      if (to === S.COMPLETED) {
        if (req.type === 'rental') {
          const status = req.item_kind === 'consumable' ? RentalStatus.CONSUMED : RentalStatus.ACTIVE;
          rentalId = Number(
            sql.insertRental.run(req.user_id, req.item_id, req.quantity, req.zone_id, req.seat, status, now).lastInsertRowid,
          );
          sql.linkRental.run(rentalId, id);
        } else {
          sql.markReturned.run(now, req.rental_id);
        }
      } else if (TERMINAL_STATUSES.includes(to) && !desk) {
        if (req.type === 'rental') sql.restockItem.run(req.quantity, req.item_id);
        else sql.setRentalStatus.run(RentalStatus.ACTIVE, req.rental_id);
      }
    });
    emitRequest(id);
    if (TERMINAL_STATUSES.includes(to)) {
      if (req.type === 'rental' && to !== S.COMPLETED && !desk) emitItems();
      if (rentalId) emitRental(rentalId);
    }
    return sql.request.get(id);
  }

  function markDispatched(id) {
    const now = Date.now();
    sql.markDispatched.run(now, now, now, id);
    emitRequest(id);
    return sql.request.get(id);
  }

  function matchesCode(req, code) {
    const value = String(code ?? '').trim();
    return value !== '' && (value === qrPayload(req.qr_token) || value === req.pin);
  }

  function listRentals({ userId, status } = {}) {
    const where = [];
    const params = [];
    if (userId) {
      where.push('t.user_id = ?');
      params.push(userId);
    }
    if (status) {
      where.push('t.status = ?');
      params.push(status);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return db.prepare(`${RENTAL_SELECT} ${clause} ORDER BY t.id DESC LIMIT 100`).all(...params);
  }

  // 데스크에서 회수 완료, 또는 물건 있음·없음을 눌렀을 때. 여기서 재고와 대여 기록을 확정한다.
  function resolveDesk(id, found) {
    const req = getRequest(id);
    if (req.desk_state !== DeskState.COLLECT && req.desk_state !== DeskState.CHECK) {
      throw new HttpError(409, '회수할 요청이 아닙니다.');
    }
    const checking = req.desk_state === DeskState.CHECK;
    if (checking && typeof found !== 'boolean') throw new HttpError(400, '물건이 있는지 골라주세요.');
    const inBasket = checking ? found : true;
    const rental = req.type === 'rental';
    const now = Date.now();
    let rentalId = req.rental_id;
    const result = rental
      ? (inBasket ? '바구니에 있음, 재고 복구' : '학생이 가져감, 대여 처리')
      : (inBasket ? '바구니에 있음, 반납 처리' : '바구니에 없음, 계속 대여 중');
    const reason = checking ? `${String(req.fail_reason ?? '').replace(' · 바구니 확인 필요', '')} · ${result}` : req.fail_reason;
    transaction(db, () => {
      sql.resolveDesk.run(inBasket ? 1 : 0, now, reason, id);
      if (rental && inBasket) {
        sql.restockItem.run(req.quantity, req.item_id);
      } else if (rental) {
        const status = req.item_kind === 'consumable' ? RentalStatus.CONSUMED : RentalStatus.ACTIVE;
        rentalId = Number(
          sql.insertRental.run(req.user_id, req.item_id, req.quantity, req.zone_id, req.seat, status, now).lastInsertRowid,
        );
        sql.linkRental.run(rentalId, id);
      } else if (inBasket) {
        if (checking) sql.markReturned.run(now, req.rental_id);
        sql.markInspected.run(now, req.rental_id);
        sql.restockItem.run(req.quantity, req.item_id);
      } else {
        sql.setRentalStatus.run(RentalStatus.ACTIVE, req.rental_id);
      }
    });
    emitRequest(id);
    if (inBasket) emitItems();
    if (rentalId) emitRental(rentalId);
    return sql.request.get(id);
  }

  function setStock(itemId, stock) {
    if (!Number.isInteger(stock) || stock < 0) throw new HttpError(400, '재고는 0 이상의 정수여야 합니다.');
    if (sql.setStock.run(stock, itemId).changes === 0) throw new HttpError(404, '없는 물품입니다.');
    emitItems();
    return sql.item.get(itemId);
  }

  return {
    toPublic,
    catalog,
    listItems: () => sql.items.all(),
    listZones: () => sql.zones.all(),
    listRequests: ({ userId } = {}) =>
      (userId ? sql.requestsOfUser.all(userId) : sql.recentRequests.all()).map(toPublic),
    openRequests: () => sql.openRequests.all(),
    nextQueued: () => sql.nextQueued.get(),
    dispatched: () => sql.dispatched.get(),
    nextDeskTask: () => sql.nextDeskTask.get(),
    getRequest,
    getOwnedRequest,
    createRentalRequest,
    createReturnRequest,
    transition,
    markDispatched,
    matchesCode,
    listRentals,
    resolveDesk,
    setStock,
  };
}
