// 학생 앱·관리자·시뮬레이터가 함께 쓰는 헬퍼

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `요청 실패 (${res.status})`);
  return data;
}

// 서버 이벤트(request, items, rental, robot) 구독
export function subscribe(handlers) {
  const source = new EventSource('/api/events');
  for (const [event, fn] of Object.entries(handlers)) {
    source.addEventListener(event, (e) => fn(JSON.parse(e.data)));
  }
  return source;
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

export const $ = (selector, root = document) => root.querySelector(selector);

export const REQUEST_STATUS_LABEL = {
  queued: '대기 중',
  moving: '이동 중',
  arrived: '도착',
  verified: '인증 완료',
  completed: '완료',
  failed: '실패',
  cancelled: '취소',
  expired: '만료',
};

export const REQUEST_TYPE_LABEL = { rental: '대여', return: '반납' };

export const RENTAL_STATUS_LABEL = {
  active: '대여 중',
  returning: '반납 진행 중',
  returned: '검수 대기',
  inspected: '반납 완료',
  consumed: '소모품',
};

export const ROBOT_STATE_LABEL = {
  offline: '로봇 연결 끊김',
  idle: '로봇 대기 중',
  moving: '로봇 이동 중',
  arrived: '로봇 도착',
  returning: '로봇 복귀 중',
};

export const ITEM_KIND_LABEL = { rental: '대여', consumable: '소모품' };

export const OPEN_STATUSES = ['queued', 'moving', 'arrived', 'verified'];

export function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return d.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function toast(message, kind = 'info') {
  let box = $('#toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toasts';
    box.setAttribute('role', 'status');
    document.body.append(box);
  }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  box.append(el);
  setTimeout(() => el.remove(), 3500);
}

export const storage = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      /* 저장 불가 환경(시크릿 창 등)에서는 무시 */
    }
  },
};
