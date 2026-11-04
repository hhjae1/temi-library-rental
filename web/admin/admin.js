import {
  $,
  api,
  esc,
  fmtTime,
  ITEM_KIND_LABEL,
  REQUEST_STATUS_LABEL,
  REQUEST_TYPE_LABEL,
  ROBOT_STATE_LABEL,
  subscribe,
  toast,
} from '/shared/api.js';

// TODO: 관리자 인증. 지금은 누구나 접근 가능하다.

const itemLabel = (row) => (row.option_label ? `${row.item_name} ${row.category_name}` : row.item_name);
const placeLabel = (row) => (row.seat ? `${row.seat}번 좌석 (${row.zone_name})` : '-');

// 끝난 요청 중 temi 데스크에서 처리를 기다리는 것
const DESK_LABEL = { collect: '· 회수 대기', check: '· 바구니 확인 대기' };

function renderRobot(robot) {
  const el = $('#robot');
  el.textContent = `${ROBOT_STATE_LABEL[robot.state] ?? robot.state}${robot.requestId ? ` · 요청 #${robot.requestId}` : ''}`;
  el.className = `pill ${robot.connected ? 'on' : 'off'}`;
}

function renderItems(items) {
  $('#items').innerHTML = `
    <tr><th>물품</th><th>종류</th><th>재고</th><th></th></tr>
    ${items
      .map(
        (i) => `<tr>
          <td>${esc(i.category_name)} · ${esc(i.name)}</td>
          <td>${ITEM_KIND_LABEL[i.kind]}</td>
          <td><input type="number" min="0" value="${i.stock}" data-stock="${i.id}" aria-label="${esc(i.name)} 재고" /></td>
          <td><button class="btn" data-save="${i.id}">저장</button></td>
        </tr>`,
      )
      .join('')}`;
}

function renderRequests(requests) {
  $('#requests').innerHTML = `
    <tr><th>ID</th><th>유형</th><th>학번</th><th>물품</th><th>수량</th><th>위치</th><th>상태</th><th>시도</th><th>사유</th><th>신청 시각</th></tr>
    ${requests
      .map(
        (r) => `<tr>
          <td>#${r.id}</td><td>${REQUEST_TYPE_LABEL[r.type]}</td><td>${esc(r.user_id)}</td><td>${esc(itemLabel(r))}</td>
          <td>${r.quantity}</td><td>${esc(placeLabel(r))}</td><td><span class="badge s-${r.status}">${REQUEST_STATUS_LABEL[r.status]}</span>${DESK_LABEL[r.desk_state] ? ` ${DESK_LABEL[r.desk_state]}` : ''}</td>
          <td>${r.attempts}</td><td>${esc(r.fail_reason ?? '')}</td><td>${fmtTime(r.created_at)}</td>
        </tr>`,
      )
      .join('')}`;
}

const loadItems = async () => renderItems(await api('/items'));
const loadRequests = async () => renderRequests(await api('/admin/requests'));

document.addEventListener('click', async (e) => {
  const save = e.target.closest('[data-save]');
  try {
    if (save) {
      const id = save.dataset.save;
      const stock = Number($(`[data-stock="${id}"]`).value);
      await api(`/admin/items/${id}`, { method: 'PUT', body: { stock } });
      toast('재고를 저장했습니다.');
    }
  } catch (err) {
    toast(err.message, 'error');
  }
});

subscribe({
  robot: renderRobot,
  items: renderItems,
  request: loadRequests,
});

renderRobot(await api('/robot'));
await Promise.all([loadItems(), loadRequests()]);
