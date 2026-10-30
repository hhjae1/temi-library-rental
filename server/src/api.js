import express from 'express';
import QRCode from 'qrcode';
import { RequestStatus as S, qrPayload } from './protocol.js';
import { HttpError } from './rentalService.js';

const wrap = (fn) => (req, res, next) =>
  Promise.resolve()
    .then(() => fn(req))
    .then((data) => res.json(data ?? { ok: true }))
    .catch(next);

const idOf = (value) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, '잘못된 ID입니다.');
  return n;
};

// TODO: 학교 계정 로그인으로 교체. 지금은 학번 문자열로만 사용자를 구분한다.
const userIdOf = (value) => {
  const s = String(value ?? '').trim();
  if (!s || s.length > 32) throw new HttpError(400, '학번(userId)이 필요합니다.');
  return s;
};

export function createApi({ service, dispatcher, robot }) {
  const api = express.Router();
  api.use(express.json());

  api.get('/catalog', wrap(() => service.catalog()));
  api.get('/items', wrap(() => service.listItems()));
  api.get('/stations', wrap(() => service.listStations()));
  api.get('/robot', wrap(() => robot.snapshot()));

  api.get('/requests', wrap((req) => service.listRequests({ userId: userIdOf(req.query.userId) })));

  // 본인 요청 상세. 로봇이 이동 중이거나 도착했을 때 인증용 QR·PIN을 함께 준다.
  api.get(
    '/requests/:id',
    wrap(async (req) => {
      const row = service.getOwnedRequest(idOf(req.params.id), userIdOf(req.query.userId));
      const out = service.toPublic(row);
      if (row.status === S.MOVING || row.status === S.ARRIVED) {
        const payload = qrPayload(row.qr_token);
        out.auth = { payload, pin: row.pin, qrDataUrl: await QRCode.toDataURL(payload, { margin: 1, width: 320 }) };
      }
      return out;
    }),
  );

  api.post(
    '/requests',
    wrap((req) => {
      const { type, itemId, rentalId, stationId, seat, quantity = 1 } = req.body ?? {};
      const userId = userIdOf(req.body?.userId);
      let created;
      if (type === 'rental') {
        created = service.createRentalRequest({ userId, itemId: idOf(itemId), quantity, stationId: idOf(stationId), seat });
      } else if (type === 'return') {
        created = service.createReturnRequest({ userId, rentalId: idOf(rentalId), stationId: idOf(stationId), seat });
      } else {
        throw new HttpError(400, "type은 'rental' 또는 'return'이어야 합니다.");
      }
      dispatcher.tick();
      return service.toPublic(service.getRequest(created.id));
    }),
  );

  api.post(
    '/requests/:id/cancel',
    wrap((req) => dispatcher.cancelByUser(idOf(req.params.id), userIdOf(req.body?.userId))),
  );
  api.post(
    '/requests/:id/complete',
    wrap((req) => dispatcher.completeByUser(idOf(req.params.id), userIdOf(req.body?.userId))),
  );

  api.get(
    '/rentals',
    wrap((req) => service.listRentals({ userId: req.query.userId?.trim(), status: req.query.status })),
  );

  // ── 관리자 ── TODO: 관리자 인증
  api.get('/admin/requests', wrap(() => service.listRequests()));
  api.put('/admin/items/:id', wrap((req) => service.setStock(idOf(req.params.id), req.body?.stock)));
  api.post('/admin/rentals/:id/inspect', wrap((req) => service.inspectRental(idOf(req.params.id))));

  api.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: '잘못된 JSON입니다.' });
    console.error(err);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  });

  return api;
}
