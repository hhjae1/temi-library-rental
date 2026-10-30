// 학생 앱 (Figma "도서관 온기" 시안 기준)
// 화면: 대여 홈 → 물품 상세 → 배달 위치 선택 → temi 배달 현황 → 나의 대여 현황 (+ 이용 안내)
import { $, api, esc, OPEN_STATUSES, storage, subscribe, toast } from '/shared/api.js';
import { icon, illustration } from './illustrations.js';

const USER_KEY = 'tlr.userId';
const PLACE_KEY = 'tlr.lastPlace';

const state = {
  userId: storage.get(USER_KEY),
  catalog: [],
  stations: [],
  robot: null,
  requests: [],
  rentals: [],
  auth: null, // 도착 시 인증용 { requestId, payload, pin, qrDataUrl }
  detail: null, // 물품 상세 선택 { categoryId, itemId, quantity, guideOk }
  draft: null, // 위치 선택 중인 요청 { mode, itemId, quantity, rentalId, stationId, seat }
  showQr: false,
};

const root = $('#app');

// ── 표시용 헬퍼 ─────────────────────────────

const ROBOT_LABEL = {
  offline: 'temi 연결 끊김',
  idle: 'temi 대기 중',
  moving: 'temi 이동 중',
  arrived: 'temi 도착',
  returning: 'temi 복귀 중',
};

const STATUS_CHIP = {
  queued: ['대기 중', ''],
  moving: ['이동 중', ''],
  arrived: ['도착', ''],
  verified: ['인증 완료', ''],
  completed: ['완료', 'line'],
  failed: ['실패', 'danger'],
  cancelled: ['취소', 'warm'],
  expired: ['만료', 'danger'],
};

const RENTAL_CHIP = {
  active: ['대여 중', ''],
  returning: ['반납 진행 중', 'warm'],
  returned: ['검수 대기', 'line'],
};

const hhmm = (ms) =>
  ms ? new Date(ms).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';

const dayLabel = (ms) => {
  const d = new Date(ms);
  const today = new Date();
  const same = d.toDateString() === today.toDateString();
  return same ? `오늘 ${hhmm(ms)}` : `${d.getMonth() + 1}/${d.getDate()} ${hhmm(ms)}`;
};

// "USB-C 충전기" 처럼 종류가 있는 물품은 종류 + 묶음 이름으로 부른다
const itemLabel = (row) => (row.option_label ? `${row.item_name} ${row.category_name}` : row.item_name);
const placeLabel = (row, sep = ' · ') => `${row.floor}층${sep}${row.station_name}`;
const stationById = (id) => state.stations.find((s) => s.id === id);
const activeRequest = () => state.requests.find((r) => OPEN_STATUSES.includes(r.status));
const userQuery = () => `?userId=${encodeURIComponent(state.userId)}`;

function lastPlace() {
  try {
    return JSON.parse(storage.get(PLACE_KEY)) ?? {};
  } catch {
    return {};
  }
}

// ── 데이터 ─────────────────────────────

async function loadAll() {
  [state.catalog, state.stations, state.robot] = await Promise.all([api('/catalog'), api('/stations'), api('/robot')]);
  if (state.userId) await loadMine();
}

async function loadMine() {
  const before = activeRequest();
  [state.requests, state.rentals] = await Promise.all([api(`/requests${userQuery()}`), api(`/rentals${userQuery()}`)]);
  await loadAuth();
  notifyChange(before);
}

// temi가 출발하면 인증용 PIN·QR을 미리 받아 둔다
async function loadAuth() {
  const active = activeRequest();
  if (!active || !['moving', 'arrived'].includes(active.status)) {
    state.auth = null;
    return;
  }
  if (state.auth?.requestId === active.id) return;
  const detail = await api(`/requests/${active.id}${userQuery()}`);
  state.auth = detail.auth ? { requestId: active.id, ...detail.auth } : null;
}

function notifyChange(before) {
  if (!before) return;
  const now = state.requests.find((r) => r.id === before.id);
  if (!now || now.status === before.status) return;
  if (now.status === 'arrived') {
    toast('temi가 도착했어요! 인증번호를 temi 화면에 입력해주세요.');
    navigator.vibrate?.(200);
  } else if (now.status === 'failed' || now.status === 'expired') {
    toast(`요청이 끝났어요 · ${now.fail_reason ?? ''}`, 'error');
  }
}

async function run(action) {
  try {
    await action();
  } catch (err) {
    toast(err.message, 'error');
  }
}

subscribe({
  items: () => run(async () => ((state.catalog = await api('/catalog')), render())),
  robot(robot) {
    state.robot = robot;
    const pill = $('#robot-pill');
    if (pill) pill.outerHTML = robotPill();
  },
  request(req) {
    if (req.user_id === state.userId) run(async () => (await loadMine(), render()));
  },
  rental(rental) {
    if (rental.user_id === state.userId) run(async () => (await loadMine(), render()));
  },
});

// ── 공통 조각 ─────────────────────────────

const robotPill = () => {
  const s = state.robot?.state ?? 'offline';
  return `<span id="robot-pill" class="chip ${s === 'offline' ? 'danger' : ''}">${ROBOT_LABEL[s] ?? s}</span>`;
};

const brandbar = () => `
  <header class="brandbar">
    <div class="brand">${icon('book')} 도서관 온기</div>
    ${robotPill()}
  </header>`;

const navbar = (title, back = '#/') => `
  <header class="navbar">
    <button class="icon-btn" data-action="back" data-to="${back}" aria-label="뒤로">${icon('back')}</button>
    <h1>${esc(title)}</h1>
    <a class="icon-btn muted" href="#/guide" aria-label="이용 안내">${icon('help')}</a>
  </header>`;

const tabbar = (current) => {
  const tabs = [
    ['#/', 'home', '대여 홈'],
    ['#/status', 'clipboard', '대여 현황'],
    ['#/guide', 'help', '이용 안내'],
  ];
  return `<nav class="tabbar">${tabs
    .map(([href, ic, label]) => `<a href="${href}" ${href === current ? 'aria-current="page"' : ''}>${icon(ic)}${label}</a>`)
    .join('')}</nav>`;
};

// ── 화면: 로그인 ─────────────────────────────

function viewLogin() {
  return `
    ${brandbar()}
    <main class="page">
      <section class="hero">
        <h1>책에 집중하는 시간,<br />필요한 건 temi에게.</h1>
        <p class="lead">충전기, 담요, 물티슈, 상비약을\n내 좌석에서 받아보세요.</p>
      </section>
      <form class="card login" data-form="login">
        <h2 class="section-head"><span>학번으로 시작하기</span></h2>
        <p class="caption">프로토타입에서는 학번으로만 이용자를 구분해요.</p>
        <label class="input"><input name="userId" inputmode="numeric" autocomplete="off" placeholder="학번 입력" maxlength="32" required /></label>
        <button class="btn">시작하기</button>
      </form>
    </main>`;
}

// ── 화면 1: 대여 홈 ─────────────────────────────

function viewHome() {
  const active = activeRequest();
  const cards = state.catalog
    .map((c) => {
      const chip = c.needs_guide
        ? `<span class="chip">운영 안내 확인</span>`
        : c.stock > 0
          ? `<span class="chip">${c.stock}개 이용 가능</span>`
          : `<span class="chip line">모두 대여 중</span>`;
      return `
        <button class="card item-card" data-go="#/item/${c.id}" ${c.stock === 0 ? 'disabled' : ''}>
          ${illustration(c.illustration)}
          <div class="row"><strong>${esc(c.name)}</strong>${icon('arrowUpRight')}</div>
          <span class="sub">${esc(c.subtitle)}</span>
          ${chip}
        </button>`;
    })
    .join('');

  return `
    ${brandbar()}
    <main class="page">
      <section class="hero">
        <h1>책에 집중하는 시간,<br />필요한 건 temi에게.</h1>
        <p class="lead">충전기, 담요, 물티슈, 상비약을\n내 좌석에서 받아보세요.</p>
      </section>

      ${
        active
          ? `<a class="card visit" href="#/status" style="text-decoration:none;color:inherit">
              <div>
                <div class="label">진행 중인 요청</div>
                <div class="place">${esc(itemLabel(active))} · ${active.type === 'rental' ? '대여' : '반납'}</div>
              </div>
              <span class="chip">${STATUS_CHIP[active.status][0]}</span>
            </a>`
          : ''
      }

      <section class="mint-card promo">
        <div>
          <p class="eyebrow">YOUR LIBRARY MATE</p>
          <h2>조용히 다가오는<br />작은 도움, temi</h2>
          <a class="link" href="#/guide">이용 방법 알아보기 ${icon('arrowUpRight', 'sm')}</a>
        </div>
        ${illustration('temi')}
      </section>

      <section class="section-head">
        <h2>무엇이 필요하세요?</h2>
        <span class="caption">남은 수량 기준</span>
      </section>
      <div class="grid2" style="margin-top:-8px">${cards}</div>

      <div class="flow-hint">
        ${icon('route')}
        <div>
          <strong>물품 선택 → 좌석 지정 → 로봇 배달</strong>
          <span class="caption">도착 알림을 받은 뒤 직접 수령을 확인해요.</span>
        </div>
      </div>
      <p class="caption">이 화면은 서비스 프로토타입입니다. 물품 수량과 이용 조건은 실제 운영 시 달라질 수 있어요.</p>
    </main>
    ${tabbar('#/')}`;
}

// ── 화면 2: 물품 상세 및 선택 ─────────────────────────────

function viewItem(categoryId) {
  const c = state.catalog.find((x) => x.id === categoryId);
  if (!c) return redirect('#/');
  if (state.detail?.categoryId !== c.id) {
    const first = c.items.find((i) => i.stock > 0) ?? c.items[0];
    state.detail = { categoryId: c.id, itemId: first?.id, quantity: 1, guideOk: false };
  }
  const d = state.detail;
  const selected = c.items.find((i) => i.id === d.itemId);
  const maxQty = Math.max(1, Math.min(c.max_quantity, selected?.stock ?? 1));
  d.quantity = Math.min(d.quantity, maxQty);
  const busy = Boolean(activeRequest());
  const canGo = selected && selected.stock >= d.quantity && !busy && (!c.needs_guide || d.guideOk);
  const verb = c.kind === 'consumable' ? '요청' : '대여';

  const options =
    c.items.length > 1
      ? `<section class="section-head"><h2>${esc(c.option_label ?? '종류')}</h2><span class="caption">이용 가능 수량</span></section>
         <div class="options" role="radiogroup" style="margin-top:-8px">
           ${c.items
             .map(
               (i) => `
             <button class="option" role="radio" aria-checked="${i.id === d.itemId}" data-action="pick" data-id="${i.id}" ${i.stock === 0 ? 'disabled' : ''}>
               <span class="radio">${i.id === d.itemId ? icon('check') : ''}</span>
               <span><span class="name">${esc(i.name)}</span>${i.detail ? `<span class="detail">${esc(i.detail)}</span>` : ''}</span>
               <span class="stock">${i.stock > 0 ? `${i.stock}개` : '품절'}</span>
             </button>`,
             )
             .join('')}
         </div>`
      : `<div class="kv"><span>남은 수량</span><b>${selected?.stock ?? 0}개</b></div>`;

  return `
    ${navbar(`${c.name} ${verb}`)}
    <main class="page has-cta">
      <div class="hero-art">${illustration(c.illustration)}</div>
      <section>
        <div class="title-row">
          <h1 class="title md">${esc(c.title)}</h1>
          ${c.stock > 0 ? `<span class="chip">${c.kind === 'consumable' ? '바로 제공' : '대여 가능'}</span>` : '<span class="chip line">모두 대여 중</span>'}
        </div>
        <p class="lead">${esc(c.description)}</p>
      </section>
      ${options}
      <div class="qty-row">
        <div>
          <strong>${verb} 수량</strong>
          <div class="caption">${esc(selected?.name ?? '')} 선택됨</div>
        </div>
        <div class="stepper">
          <button data-action="qty" data-step="-1" aria-label="수량 줄이기" ${d.quantity <= 1 ? 'disabled' : ''}>${icon('minus')}</button>
          <output aria-live="polite">${d.quantity}</output>
          <button data-action="qty" data-step="1" aria-label="수량 늘리기" ${d.quantity >= maxQty ? 'disabled' : ''}>${icon('plus')}</button>
        </div>
      </div>
      ${c.notice ? `<div class="notice">${icon('info')}<span>${esc(c.notice)}</span></div>` : ''}
      ${
        c.needs_guide
          ? `<label class="check-line"><input type="checkbox" id="guide-ok" ${d.guideOk ? 'checked' : ''} /> 운영 안내를 확인했어요</label>`
          : ''
      }
    </main>
    <div class="cta">
      ${busy ? '<p class="caption">진행 중인 요청이 끝나면 새로 신청할 수 있어요.</p>' : ''}
      <button class="btn" data-action="to-location" ${canGo ? '' : 'disabled'}>좌석 선택하기</button>
    </div>`;
}

// ── 화면 3: 배달 위치 선택 및 요청 확인 ─────────────────────────────

function viewLocation() {
  const d = state.draft;
  if (!d) return redirect('#/');
  const isRental = d.mode === 'rental';
  const floors = [...new Set(state.stations.map((s) => s.floor))];
  const station = stationById(d.stationId) ?? state.stations[0];
  d.stationId = station.id;
  const rooms = state.stations.filter((s) => s.floor === station.floor);

  return `
    ${navbar(isRental ? '배달 위치 선택' : '반납 위치 선택', isRental ? `#/item/${d.categoryId}` : '#/status')}
    <main class="page has-cta">
      <section>
        <span class="chip">${isRental ? '대여 요청 전 확인' : '반납 요청 전 확인'}</span>
        <h1 class="title md" style="margin-top:10px">${isRental ? '어디로 가져다드릴까요?' : '어디로 찾아갈까요?'}</h1>
        <p class="lead">지금 이용 중인 열람실과 좌석을 알려주세요.</p>
      </section>

      <div class="field">
        <span>도서관 층</span>
        <div class="segmented">
          ${floors.map((f) => `<button data-action="floor" data-floor="${f}" aria-pressed="${f === station.floor}">${f}층</button>`).join('')}
        </div>
      </div>

      <label class="field">
        <span>열람실</span>
        <div class="select">
          <select id="room">${rooms.map((s) => `<option value="${s.id}" ${s.id === station.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
          ${icon('chevronDown')}
        </div>
      </label>

      <label class="field">
        <span>좌석 번호</span>
        <div class="input">
          <input id="seat" inputmode="numeric" autocomplete="off" maxlength="10" placeholder="예: 128" value="${esc(d.seat ?? '')}" />
          <span class="suffix">번 좌석</span>
        </div>
        <span class="caption">좌석에 표시된 번호를 입력해주세요.</span>
      </label>

      <section class="card summary">
        <h3>${icon('clipboard')} 요청 내용을 확인해주세요</h3>
        <div class="kv"><span>${isRental ? '대여 물품' : '반납 물품'}</span><b>${esc(d.label)} · ${d.quantity}개</b></div>
        <div class="divider"></div>
        <div class="kv"><span>${isRental ? '배달 장소' : '방문 장소'}</span><b>${esc(placeLabel({ floor: station.floor, station_name: station.name }))}</b></div>
        <div class="kv"><span>좌석</span><b id="sum-seat">${d.seat ? `${esc(d.seat)}번` : '-'}</b></div>
      </section>
      <p class="caption">요청 후 진행 상황은 대여 현황에서 볼 수 있어요.\n배달 가능 여부는 운영 조건에 따라 달라질 수 있어요.</p>
    </main>
    <div class="cta">
      <button class="btn" id="submit" data-action="submit" ${d.seat ? '' : 'disabled'}>
        ${isRental ? '이 좌석으로 대여 요청' : '이 좌석에서 반납 요청'}
      </button>
    </div>`;
}

// ── 화면 4: temi 배달 진행 및 수령 확인 ─────────────────────────────

function viewDelivery(r) {
  const isRental = r.type === 'rental';
  const copy = {
    queued: {
      chip: '요청 접수 · 대기 중',
      title: '요청을 접수했어요',
      lead: '앞선 요청이 끝나면 temi가 출발해요.\n자리에서 편하게 기다려주세요.',
    },
    moving: {
      chip: isRental ? '배달 중' : '방문 중',
      title: 'temi가 가고 있어요',
      lead: '좌석 근처에 도착하면 알려드릴게요.\n도착하면 아래 인증번호를 temi에 입력해요.',
    },
    arrived: {
      chip: '도착 · 인증 대기',
      title: 'temi가 도착했어요',
      lead: 'temi 화면에 인증번호를 입력하거나\nQR 코드를 보여주세요.',
    },
    verified: {
      chip: isRental ? '도착 · 수령 대기' : '도착 · 반납 대기',
      title: isRental ? '물품을 꺼내주세요' : '물품을 넣어주세요',
      lead: isRental
        ? '좌석 주변의 로봇에서 물품을 꺼내주세요.\n아직 수령이 확인되지 않았어요.'
        : '로봇 바구니에 물품을 넣고\n반납 완료를 눌러주세요.',
    },
  }[r.status];

  const stage = { queued: 0, moving: 1, arrived: 2, verified: 2 }[r.status];
  const steps = [
    ['요청 접수', hhmm(r.created_at), 'dots'],
    [isRental ? '배달 중' : '방문 중', r.dispatched_at ? `${hhmm(r.dispatched_at)} 출발` : '', 'truck'],
    ['도착', hhmm(r.arrived_at), 'pin'],
  ]
    .map(([label, time, ic], i) => {
      const cls = i < stage ? 'done' : i === stage ? 'now' : '';
      return `<li class="${cls}"><span class="dot">${icon(i < stage ? 'check' : ic)}</span><b>${label}</b><time>${time}</time></li>`;
    })
    .join('');

  const auth =
    r.status === 'arrived' && state.auth?.requestId === r.id
      ? `<section class="card auth">
          <h3>temi 화면에 인증번호를 입력해주세요</h3>
          <div class="pin" aria-label="인증번호 ${esc(state.auth.pin)}">${[...state.auth.pin].map((n) => `<span>${n}</span>`).join('')}</div>
          <button class="link" data-action="toggle-qr">${icon('qr', 'sm')} ${state.showQr ? 'QR 닫기' : 'QR로 인증하기'}</button>
          ${
            state.showQr
              ? `<img src="${state.auth.qrDataUrl}" alt="인증용 QR 코드" />
                 <p class="caption">temi 카메라에 QR 코드를 보여주세요.</p>
                 <p class="dev-code" title="시뮬레이터의 'QR 스캔 흉내' 칸에 붙여 넣으세요">개발용 코드: ${esc(state.auth.payload)}</p>`
              : ''
          }
        </section>`
      : r.status === 'verified'
        ? `<section class="card verified">${icon('checkCircle')} temi에서 인증됐어요</section>`
        : '';

  const cta = {
    queued: `<button class="btn ghost danger" data-action="cancel" data-id="${r.id}">요청 취소</button>`,
    moving: `<button class="btn ghost danger" data-action="cancel" data-id="${r.id}">요청 취소</button>`,
    arrived: `<button class="btn" disabled>temi에서 인증하면 ${isRental ? '수령' : '반납'}할 수 있어요</button>`,
    verified: `<button class="btn" data-action="complete" data-id="${r.id}">${isRental ? '물품을 받았어요' : '반납을 완료했어요'}</button>`,
  }[r.status];

  return `
    ${navbar(isRental ? 'temi 배달 현황' : 'temi 방문 현황')}
    <main class="page has-cta">
      <section>
        <span class="chip">${copy.chip}</span>
        <h1 class="title" style="margin-top:10px">${copy.title}</h1>
        <p class="lead">${copy.lead}</p>
      </section>

      <section class="mint-card delivery">
        <div class="where">
          ${illustration('temi')}
          <div>
            <div class="label">${isRental ? '배달 위치' : '방문 위치'}</div>
            <div class="room">${esc(placeLabel(r, ' '))}</div>
            <div class="seat">${esc(r.seat)}번 좌석</div>
          </div>
        </div>
        <ol class="steps">${steps}</ol>
      </section>

      <section class="card summary">
        <div class="kv"><span>${isRental ? '받을 물품' : '돌려줄 물품'}</span><b>${esc(itemLabel(r))} · ${r.quantity}개</b></div>
        <div class="divider"></div>
        <div class="warn-line">${icon('hand', 'sm')} ${isRental ? "수령 확인 전에는 '대여 중'이 아니에요." : '관리자 검수가 끝나야 반납이 완료돼요.'}</div>
      </section>

      ${auth}

      <section class="field">
        <h2 class="section-head" style="font-size:16px">물품을 ${isRental ? '받은' : '넣은'} 뒤 확인해주세요</h2>
        <ol class="numbered">
          ${
            isRental
              ? '<li>물품 종류와 수량이 맞는지 확인해요.</li><li>아래 버튼을 누르면 대여가 시작돼요.</li>'
              : '<li>바구니에 물품을 넣었는지 확인해요.</li><li>아래 버튼을 누르면 반납이 접수돼요.</li>'
          }
        </ol>
      </section>
      <button class="link muted center" data-action="help" data-id="${r.id}">${icon('chat', 'sm')} 로봇이 보이지 않거나 물품이 다른가요?</button>
    </main>
    <div class="cta">${cta}</div>`;
}

// ── 화면 5: 나의 대여 현황 및 반납 요청 ─────────────────────────────

function viewRentals() {
  const rentals = state.rentals.filter((t) => RENTAL_CHIP[t.status]);
  const last = state.requests[0];
  const recentFail =
    last && ['failed', 'expired', 'cancelled'].includes(last.status) && Date.now() - last.updated_at < 10 * 60_000;

  const cards = rentals
    .map((t) => {
      const [chipLabel, chipCls] = RENTAL_CHIP[t.status];
      const card = `
        <section class="card rental-card">
          <div class="head"><span class="chip ${chipCls}">${chipLabel}</span><span class="caption">${dayLabel(t.rented_at)} 수령 확인</span></div>
          <div class="body">
            ${illustration(t.illustration)}
            <div>
              <div class="name">${esc(itemLabel(t))}</div>
              <div class="caption">${t.item_detail ? `${esc(t.item_detail)} · ` : ''}${t.quantity}개</div>
            </div>
          </div>
          <div class="divider"></div>
          <div class="kv"><span>수령 장소</span><b>${t.station_name ? `${esc(placeLabel(t))} · ${esc(t.seat)}번` : '-'}</b></div>
          <div class="ok-line">${icon('checkCircle', 'sm')} ${
            t.status === 'returned' ? '반납이 접수됐어요. 관리자 검수를 기다리고 있어요.' : '수령 확인이 완료되어 대여가 시작됐어요.'
          }</div>
        </section>`;
      if (t.status !== 'active') return card;
      return `${card}
        <section class="section-head"><h2>다 쓰셨나요?</h2><span class="chip line">반납 요청 전</span></section>
        <div class="mint-card visit" style="margin-top:-8px">
          <div>
            <div class="label">로봇이 방문할 위치</div>
            <div class="place">${icon('pin', 'sm')} ${t.station_name ? `${esc(placeLabel(t, ' '))} · ${esc(t.seat)}번 좌석` : '위치를 선택해주세요'}</div>
          </div>
          <button class="link" data-action="return-change" data-id="${t.id}">위치 변경</button>
        </div>
        <button class="btn" data-action="return-here" data-id="${t.id}" ${activeRequest() ? 'disabled' : ''}>이 좌석에서 반납 요청 ${icon('arrowRight')}</button>
        <p class="caption" style="text-align:center;white-space:pre-line">반납 요청만으로 반납이 완료되지는 않아요.\n로봇 도착 후 물품을 전달하고 반납 상태를 확인해주세요.</p>`;
    })
    .join('');

  const history = state.requests.slice(0, 8);

  return `
    ${navbar('나의 대여 현황')}
    <main class="page">
      <section>
        <h1 class="title">편안히 이용하세요</h1>
        <p class="lead">수령을 확인한 물품을 여기서 관리해요.</p>
      </section>
      ${
        recentFail
          ? `<div class="notice danger">${icon('info')}<span><strong>최근 요청이 ${STATUS_CHIP[last.status][0]}됐어요</strong>${esc(last.fail_reason ?? '')}</span></div>`
          : ''
      }
      ${
        cards ||
        `<section class="card empty">
          ${illustration('temi')}
          <p>대여 중인 물품이 없어요.</p>
          <a class="btn sm" href="#/" style="text-decoration:none">물품 둘러보기</a>
        </section>`
      }
      <div class="notice">${icon('bookOpen')}<span><strong>이용 조건을 확인해주세요</strong>대여 시간·반납 방식 등 세부 조건은\n도서관의 실제 운영 안내를 확인해주세요.</span></div>
      ${
        history.length
          ? `<section class="section-head"><h2>최근 이용 기록</h2></section>
             <ul class="card history" style="list-style:none;margin:-8px 0 0">
               ${history
                 .map(
                   (r) => `<li>
                     <span>${r.type === 'rental' ? '대여' : '반납'} · ${esc(itemLabel(r))}<br /><span class="caption">${dayLabel(r.created_at)}${r.fail_reason ? ` · ${esc(r.fail_reason)}` : ''}</span></span>
                     <span class="chip ${STATUS_CHIP[r.status][1]}">${STATUS_CHIP[r.status][0]}</span>
                   </li>`,
                 )
                 .join('')}
             </ul>`
          : ''
      }
    </main>
    ${tabbar('#/status')}`;
}

// ── 화면: 이용 안내 ─────────────────────────────

function viewGuide() {
  return `
    ${navbar('이용 안내')}
    <main class="page">
      <section>
        <h1 class="title">이렇게 이용해요</h1>
        <p class="lead">자리를 비우지 않고 필요한 물품을 받고 돌려줄 수 있어요.</p>
      </section>
      <section class="card">
        <ol class="numbered">
          <li>대여 홈에서 필요한 물품과 수량을 골라요.</li>
          <li>지금 앉은 열람실과 좌석 번호를 입력해요.</li>
          <li>temi가 도착하면 temi 화면에 인증번호를 입력하거나 QR을 보여줘요.</li>
          <li>바구니에서 물품을 꺼내고 '물품을 받았어요'를 눌러요.</li>
          <li>다 쓰면 대여 현황에서 반납을 요청해요.</li>
        </ol>
      </section>
      <div class="notice">${icon('info')}<span>도서관에서는 temi 음성 안내를 작게 사용해요.\n화면 안내를 함께 확인해주세요.</span></div>
      <div class="notice">${icon('info')}<span>상비약은 운영 안내에 따라 제공 여부가 달라질 수 있어요.\n증상이 심하면 안내 데스크에 문의해주세요.</span></div>
      <section class="card visit">
        <div><div class="label">이용자</div><div class="place">${esc(state.userId)}</div></div>
        <button class="link muted" data-action="logout">로그아웃</button>
      </section>
    </main>
    ${tabbar('#/guide')}`;
}

// ── 라우팅·렌더 ─────────────────────────────

function redirect(hash) {
  queueMicrotask(() => (location.hash = hash));
  return '';
}

function render() {
  // 다시 그려도 입력 중인 칸의 포커스와 커서를 유지한다
  const focused = document.activeElement?.id;
  const caret = document.activeElement?.selectionStart;

  const hash = location.hash || '#/';
  let html;
  if (!state.userId) html = viewLogin();
  else if (hash.startsWith('#/item/')) html = viewItem(Number(hash.split('/')[2]));
  else if (hash === '#/location') html = viewLocation();
  else if (hash === '#/status') html = activeRequest() ? viewDelivery(activeRequest()) : viewRentals();
  else if (hash === '#/guide') html = viewGuide();
  else html = viewHome();
  root.innerHTML = html;

  if (focused) {
    const el = document.getElementById(focused);
    el?.focus();
    if (caret != null) el?.setSelectionRange?.(caret, caret);
  }
}

window.addEventListener('hashchange', () => {
  state.showQr = false;
  render();
  window.scrollTo(0, 0);
});

// ── 동작 ─────────────────────────────

function startDraft(draft) {
  const place = lastPlace();
  state.draft = {
    stationId: stationById(place.stationId) ? place.stationId : state.stations[0]?.id,
    seat: place.seat ?? '',
    ...draft,
  };
  location.hash = '#/location';
}

async function submitReturn(rental, stationId, seat) {
  await api('/requests', { method: 'POST', body: { userId: state.userId, type: 'return', rentalId: rental.id, stationId, seat } });
  storage.set(PLACE_KEY, JSON.stringify({ stationId, seat }));
  location.hash = '#/status';
}

const actions = {
  back(el) {
    location.hash = el.dataset.to;
  },
  pick(el) {
    state.detail.itemId = Number(el.dataset.id);
    state.detail.quantity = 1;
    render();
  },
  qty(el) {
    state.detail.quantity += Number(el.dataset.step);
    render();
  },
  'to-location'() {
    const c = state.catalog.find((x) => x.id === state.detail.categoryId);
    const item = c.items.find((i) => i.id === state.detail.itemId);
    startDraft({
      mode: 'rental',
      categoryId: c.id,
      itemId: item.id,
      quantity: state.detail.quantity,
      label: c.option_label ? `${item.name} ${c.name}` : item.name,
    });
  },
  floor(el) {
    const floor = Number(el.dataset.floor);
    state.draft.stationId = state.stations.find((s) => s.floor === floor).id;
    render();
  },
  async submit() {
    const d = state.draft;
    const seat = d.seat.trim();
    if (d.mode === 'rental') {
      await api('/requests', {
        method: 'POST',
        body: { userId: state.userId, type: 'rental', itemId: d.itemId, quantity: d.quantity, stationId: d.stationId, seat },
      });
      storage.set(PLACE_KEY, JSON.stringify({ stationId: d.stationId, seat }));
      state.detail = null;
      location.hash = '#/status';
    } else {
      await submitReturn({ id: d.rentalId }, d.stationId, seat);
    }
    state.draft = null;
  },
  async cancel(el) {
    if (!confirm('요청을 취소할까요?')) return;
    await api(`/requests/${el.dataset.id}/cancel`, { method: 'POST', body: { userId: state.userId } });
  },
  async complete(el) {
    await api(`/requests/${el.dataset.id}/complete`, { method: 'POST', body: { userId: state.userId } });
    toast('완료했어요. 편안히 이용하세요!');
  },
  'toggle-qr'() {
    state.showQr = !state.showQr;
    render();
  },
  help(el) {
    const r = state.requests.find((x) => x.id === Number(el.dataset.id));
    const cancellable = ['queued', 'moving', 'arrived'].includes(r?.status);
    const sheet = $('#sheet');
    sheet.innerHTML = `
      <form method="dialog" class="sheet-body">
        <h3>도움이 필요하신가요?</h3>
        <ol class="numbered">
          <li>temi는 열람실 지정 지점에 멈춰요. 좌석 주변 통로를 확인해주세요.</li>
          <li>물품이 다르면 받지 말고 안내 데스크에 알려주세요.</li>
          <li>계속 오지 않으면 요청을 취소하고 다시 신청할 수 있어요.</li>
        </ol>
        ${cancellable ? `<button class="btn ghost danger" value="cancel-request">요청 취소</button>` : ''}
        <button class="btn" value="close">닫기</button>
      </form>`;
    sheet.showModal();
    sheet.addEventListener(
      'close',
      () => {
        if (sheet.returnValue === 'cancel-request') {
          run(() => api(`/requests/${r.id}/cancel`, { method: 'POST', body: { userId: state.userId } }));
        }
      },
      { once: true },
    );
  },
  async 'return-here'(el) {
    const t = state.rentals.find((x) => x.id === Number(el.dataset.id));
    if (!t.station_id) return actions['return-change'](el);
    await submitReturn(t, t.station_id, t.seat);
  },
  'return-change'(el) {
    const t = state.rentals.find((x) => x.id === Number(el.dataset.id));
    startDraft({
      mode: 'return',
      rentalId: t.id,
      quantity: t.quantity,
      label: itemLabel(t),
      ...(t.station_id ? { stationId: t.station_id, seat: t.seat } : {}),
    });
  },
  logout() {
    storage.set(USER_KEY, null);
    Object.assign(state, { userId: null, requests: [], rentals: [], auth: null, draft: null, detail: null });
    location.hash = '#/';
    render();
  },
};

root.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (go) {
    location.hash = go.dataset.go;
    return;
  }
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  run(() => actions[el.dataset.action](el));
});

root.addEventListener('change', (e) => {
  if (e.target.id === 'room') {
    state.draft.stationId = Number(e.target.value);
    render();
  } else if (e.target.id === 'guide-ok') {
    state.detail.guideOk = e.target.checked;
    render();
  }
});

// 좌석 번호는 타이핑 중 전체를 다시 그리지 않고 요약·버튼만 갱신한다
root.addEventListener('input', (e) => {
  if (e.target.id !== 'seat') return;
  state.draft.seat = e.target.value;
  const seat = e.target.value.trim();
  $('#sum-seat').textContent = seat ? `${seat}번` : '-';
  $('#submit').disabled = !seat;
});

root.addEventListener('submit', (e) => {
  if (e.target.dataset.form !== 'login') return;
  e.preventDefault();
  state.userId = new FormData(e.target).get('userId').trim();
  storage.set(USER_KEY, state.userId);
  run(async () => (await loadMine(), render()));
});

run(async () => {
  await loadAll();
  render();
});
