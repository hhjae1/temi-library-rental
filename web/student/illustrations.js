// Figma 시안의 물품·temi 일러스트를 단순화한 SVG. categories.illustration 키로 고른다.

const shadow = (cx, cy, rx) => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="5" fill="#D9DED9"/>`;

const ART = {
  charger: `
    ${shadow(52, 82, 36)}
    <rect x="34" y="12" width="5" height="16" rx="2" fill="#C9AE8A"/>
    <rect x="47" y="12" width="5" height="16" rx="2" fill="#C9AE8A"/>
    <rect x="24" y="26" width="38" height="46" rx="8" fill="#fff" stroke="#DCE3DF" stroke-width="2"/>
    <rect x="35" y="47" width="14" height="5" rx="2.5" fill="#2D6E62"/>
    <path d="M62 50 C 74 50, 70 34, 84 34 C 100 34, 104 52, 90 56 C 80 59, 72 54, 74 46" fill="none" stroke="#2D6E62" stroke-width="4" stroke-linecap="round"/>`,
  blanket: `
    ${shadow(60, 82, 38)}
    <rect x="24" y="22" width="72" height="26" rx="9" fill="#EFE7D7"/>
    <rect x="24" y="44" width="72" height="26" rx="9" fill="#C3AA86"/>
    <rect x="24" y="40" width="72" height="10" fill="#E6DCC8"/>
    <rect x="38" y="22" width="8" height="48" fill="#BFD8CD"/>`,
  wipes: `
    ${shadow(60, 82, 38)}
    <rect x="24" y="30" width="72" height="42" rx="10" fill="#EFE7D7"/>
    <rect x="34" y="16" width="52" height="8" rx="2" fill="#C3AA86"/>
    <rect x="34" y="27" width="52" height="8" rx="2" fill="#C3AA86"/>
    <rect x="34" y="38" width="52" height="8" rx="2" fill="#C3AA86"/>
    <rect x="40" y="50" width="40" height="14" rx="4" fill="#fff"/>`,
  medicine: `
    ${shadow(60, 82, 38)}
    <rect x="24" y="30" width="72" height="42" rx="10" fill="#EFE7D7"/>
    <rect x="34" y="16" width="52" height="8" rx="2" fill="#A9C9BD"/>
    <rect x="34" y="27" width="52" height="8" rx="2" fill="#A9C9BD"/>
    <rect x="34" y="38" width="52" height="8" rx="2" fill="#A9C9BD"/>
    <rect x="40" y="50" width="40" height="14" rx="4" fill="#DDEBE5"/>`,
  temi: `
    ${shadow(60, 84, 34)}
    <rect x="48" y="40" width="24" height="34" fill="#C8D3CE"/>
    <rect x="34" y="44" width="52" height="5" rx="2.5" fill="#C9AE8A"/>
    <rect x="28" y="72" width="64" height="12" rx="6" fill="#fff" stroke="#DCE3DF" stroke-width="1.5"/>
    <rect x="52" y="76" width="16" height="3" rx="1.5" fill="#24594F"/>
    <g transform="rotate(-6 60 24)">
      <rect x="32" y="6" width="56" height="38" rx="7" fill="#24594F"/>
      <rect x="37" y="11" width="46" height="28" rx="4" fill="#2D7A6C"/>
      <rect x="49" y="21" width="5" height="7" rx="2.5" fill="#fff"/>
      <rect x="66" y="21" width="5" height="7" rx="2.5" fill="#fff"/>
    </g>`,
};

export function illustration(key, className = '') {
  return `<svg class="art ${className}" viewBox="0 0 120 92" aria-hidden="true">${ART[key] ?? ART.wipes}</svg>`;
}

// 단순 선 아이콘 (lucide 스타일)
const ICONS = {
  book: '<path d="M4 19.5V5a2 2 0 0 1 2-2h5v17H6a2 2 0 0 0-2 2"/><path d="M20 19.5V5a2 2 0 0 0-2-2h-5v17h5a2 2 0 0 1 2 2"/>',
  back: '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  arrowUpRight: '<path d="M7 17 17 7"/><path d="M7 7h10v10"/>',
  arrowRight: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  home: '<path d="m3 10 9-7 9 7v10a2 2 0 0 1-2 2h-4v-7H9v7H5a2 2 0 0 1-2-2z"/>',
  clipboard: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M9 12h6"/><path d="M9 16h6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  checkCircle: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  route: '<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>',
  hand: '<path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v2"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.4l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15"/>',
  chat: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  bookOpen: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  truck: '<path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.62L18.3 9.38A1 1 0 0 0 17.52 9H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/>',
  dots: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
  minus: '<path d="M5 12h14"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3z"/><path d="M21 14v7h-7"/>',
};

export function icon(name, className = '') {
  return `<svg class="icon ${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}
