import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// 스키마가 바뀌면 올린다. 버전이 다르면 개발용 DB를 새로 만든다 (프로토타입 단계).
const SCHEMA_VERSION = 3;

const SCHEMA = `
-- 홈 화면에 보이는 물품 묶음 (충전기, 담요 ...)
CREATE TABLE IF NOT EXISTS categories (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,     -- 홈 카드 이름
  title         TEXT NOT NULL,     -- 상세 화면 제목
  subtitle      TEXT NOT NULL,     -- 홈 카드 보조 문구
  description   TEXT NOT NULL,
  option_label  TEXT,              -- 종류 선택 제목 (예: 충전기 종류)
  notice        TEXT,              -- 상세 화면 안내 박스
  illustration  TEXT NOT NULL,     -- 앱 일러스트 키
  kind          TEXT NOT NULL CHECK (kind IN ('rental', 'consumable')),
  needs_guide   INTEGER NOT NULL DEFAULT 0, -- 운영 안내 확인 후 요청 (상비약)
  max_quantity  INTEGER NOT NULL DEFAULT 1,
  sort          INTEGER NOT NULL DEFAULT 0
);

-- 실제 재고 단위 (USB-C 충전기, Lightning 충전기 ...)
CREATE TABLE IF NOT EXISTS items (
  id           INTEGER PRIMARY KEY,
  category_id  INTEGER NOT NULL REFERENCES categories(id),
  name         TEXT NOT NULL,
  detail       TEXT,
  stock        INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0)
);

-- 좌석 번호 범위별로 temi가 찾아갈 지점. 학생은 좌석 번호만 입력하고, 서버가 범위로 지점을 고른다.
-- temi_location은 TEMI 맵에 저장한 위치 이름과 같아야 한다. temi는 이 지점에 멈추고 화면에 좌석 번호를 띄운다.
CREATE TABLE IF NOT EXISTS zones (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,     -- 관리자용 구역 이름 (A구역 ...)
  seat_from       INTEGER NOT NULL,
  seat_to         INTEGER NOT NULL,
  temi_location   TEXT NOT NULL UNIQUE,
  sim_travel_sec  INTEGER NOT NULL DEFAULT 8,
  active          INTEGER NOT NULL DEFAULT 1,
  CHECK (seat_from <= seat_to)
);

CREATE TABLE IF NOT EXISTS rentals (
  id            INTEGER PRIMARY KEY,
  user_id       TEXT NOT NULL,
  item_id       INTEGER NOT NULL REFERENCES items(id),
  quantity      INTEGER NOT NULL DEFAULT 1,
  zone_id       INTEGER REFERENCES zones(id),
  seat          TEXT,
  status        TEXT NOT NULL,
  rented_at     INTEGER NOT NULL,
  returned_at   INTEGER,
  inspected_at  INTEGER
);

CREATE TABLE IF NOT EXISTS requests (
  id                 INTEGER PRIMARY KEY,
  type               TEXT NOT NULL CHECK (type IN ('rental', 'return')),
  user_id            TEXT NOT NULL,
  item_id            INTEGER NOT NULL REFERENCES items(id),
  quantity           INTEGER NOT NULL DEFAULT 1,
  zone_id            INTEGER NOT NULL REFERENCES zones(id),
  seat               TEXT NOT NULL,
  rental_id          INTEGER REFERENCES rentals(id),
  status             TEXT NOT NULL,
  qr_token           TEXT NOT NULL,
  pin                TEXT NOT NULL,
  attempts           INTEGER NOT NULL DEFAULT 0,
  fail_reason        TEXT,
  created_at         INTEGER NOT NULL,
  dispatched_at      INTEGER,           -- 로봇에 배정된 시각 (출발 준비 시작)
  departed_at        INTEGER,           -- TEMI 화면에서 출발 버튼을 누른 시각
  arrived_at         INTEGER,
  updated_at         INTEGER NOT NULL,
  status_changed_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS requests_status ON requests(status);
CREATE INDEX IF NOT EXISTS requests_user ON requests(user_id);
CREATE INDEX IF NOT EXISTS rentals_user ON rentals(user_id);
`;

export function openDb(file, { seed = true } = {}) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  if (db.prepare('PRAGMA user_version').get().user_version !== SCHEMA_VERSION) resetSchema(db);
  db.exec(SCHEMA);
  if (seed && db.prepare('SELECT COUNT(*) AS n FROM items').get().n === 0) seedDb(db);
  return db;
}

function resetSchema(db) {
  db.exec('PRAGMA foreign_keys = OFF;');
  for (const { name } of db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all()) {
    db.exec(`DROP TABLE IF EXISTS "${name}"`);
  }
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}; PRAGMA foreign_keys = ON;`);
}

// 현장 조사 전 예시 데이터 (Figma 시안 기준). 실제 품목·수량·열람실은 확인 후 교체한다.
function seedDb(db) {
  const category = db.prepare(`
    INSERT INTO categories (name, title, subtitle, description, option_label, notice, illustration, kind, needs_guide, max_quantity, sort)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const item = db.prepare('INSERT INTO items (category_id, name, detail, stock) VALUES (?, ?, ?, ?)');
  const add = (c, items) => {
    const id = Number(category.run(...c).lastInsertRowid);
    for (const i of items) item.run(id, ...i);
  };

  add(
    ['충전기', '휴대폰 충전기', 'C타입 · 8핀 · Micro 5핀', '배터리 걱정은 잠시 내려놓고,\n내 기기에 맞는 충전기를 골라주세요.',
      '충전기 종류', '충전 단자 모양을 확인해주세요.\n구성품과 이용 조건은 운영 안내를 확인해주세요.', 'charger', 'rental', 0, 2, 1],
    [['USB-C', 'C타입', 3], ['Lightning', '8핀', 2], ['Micro USB', 'Micro 5핀', 1]],
  );
  add(
    ['담요', '무릎 담요', '포근한 무릎 담요', '찬 바람이 느껴질 때,\n자리에서 바로 받아 덮으세요.',
      null, '사용한 담요는 반납 요청으로 돌려주세요.', 'blanket', 'rental', 0, 1, 2],
    [['무릎 담요', null, 4]],
  );
  add(
    ['물티슈', '물티슈', '소량 제공 · 필요 시 요청', '필요한 만큼만 소량으로 가져다드려요.',
      null, '소모품이라 반납하지 않아도 돼요.', 'wipes', 'consumable', 0, 2, 3],
    [['휴대용 물티슈', null, 8]],
  );
  add(
    ['상비약', '상비약', '운영 안내 확인 후 요청', '간단한 응급 용품만 제공해요.',
      null, '의약품은 도서관 운영 안내에 따라 제공 여부가 달라질 수 있어요.\n증상이 심하면 안내 데스크에 문의해주세요.', 'medicine', 'consumable', 1, 1, 4],
    [['밴드', '일회용 밴드', 5]],
  );

  // 좌석 범위와 지점 이름은 예시. 인문자료실 좌석 배치를 조사한 뒤 바꾸고, 같은 이름으로 TEMI 맵에 위치를 저장한다.
  const zone = db.prepare('INSERT INTO zones (name, seat_from, seat_to, temi_location, sim_travel_sec) VALUES (?, ?, ?, ?, ?)');
  for (const row of [
    ['A구역', 1, 40, 'humanities-a', 6],
    ['B구역', 41, 80, 'humanities-b', 9],
    ['C구역', 81, 120, 'humanities-c', 12],
  ]) zone.run(...row);
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
