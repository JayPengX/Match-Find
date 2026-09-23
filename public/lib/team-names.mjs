// ---- public/lib/team-names.mjs ----
// Traditional Chinese names for every team ESPN's `/teams` endpoint lists
// for each league, keyed by ESPN's own `abbreviation` (stable and short,
// unlike `displayName` which has punctuation/spacing quirks that are easy
// to get wrong when hand-typing a lookup key). Best-effort, common
// Taiwanese sports-media naming - not pulled from any API, since no free
// service reliably provides these. A team missing from its league's map
// (a promoted/relegated or newly added club ESPN hasn't been re-checked
// against) just falls back to English-only in the UI rather than breaking
// anything - see teamNameZh below.

export const TEAM_NAMES_ZH = {
  nba: {
    ATL: '亞特蘭大老鷹',
    BOS: '波士頓塞爾提克',
    BKN: '布魯克林籃網',
    CHA: '夏洛特黃蜂',
    CHI: '芝加哥公牛',
    CLE: '克里夫蘭騎士',
    DAL: '達拉斯獨行俠',
    DEN: '丹佛金塊',
    DET: '底特律活塞',
    GS: '金州勇士',
    HOU: '休士頓火箭',
    IND: '印第安納溜馬',
    LAC: '洛杉磯快艇',
    LAL: '洛杉磯湖人',
    MEM: '曼菲斯灰熊',
    MIA: '邁阿密熱火',
    MIL: '密爾瓦基公鹿',
    MIN: '明尼蘇達灰狼',
    NO: '紐奧良鵜鶘',
    NY: '紐約尼克',
    OKC: '奧克拉荷馬雷霆',
    ORL: '奧蘭多魔術',
    PHI: '費城76人',
    PHX: '鳳凰城太陽',
    POR: '波特蘭拓荒者',
    SAC: '沙加緬度國王',
    SA: '聖安東尼奧馬刺',
    TOR: '多倫多暴龍',
    UTAH: '猶他爵士',
    WSH: '華盛頓巫師'
  },
  mlb: {
    ARI: '亞利桑那響尾蛇',
    ATH: '運動家',
    ATL: '亞特蘭大勇士',
    BAL: '巴爾的摩金鶯',
    BOS: '波士頓紅襪',
    CHC: '芝加哥小熊',
    CHW: '芝加哥白襪',
    CIN: '辛辛那提紅人',
    CLE: '克里夫蘭守護者',
    COL: '科羅拉多落磯',
    DET: '底特律老虎',
    HOU: '休士頓太空人',
    KC: '堪薩斯市皇家',
    LAA: '洛杉磯天使',
    LAD: '洛杉磯道奇',
    MIA: '邁阿密馬林魚',
    MIL: '密爾瓦基釀酒人',
    MIN: '明尼蘇達雙城',
    NYM: '紐約大都會',
    NYY: '紐約洋基',
    PHI: '費城人',
    PIT: '匹茲堡海盜',
    SD: '聖地牙哥教士',
    SF: '舊金山巨人',
    SEA: '西雅圖水手',
    STL: '聖路易紅雀',
    TB: '坦帕灣光芒',
    TEX: '德州遊騎兵',
    TOR: '多倫多藍鳥',
    WSH: '華盛頓國民'
  },
  // English Premier League. ESPN's teams list includes clubs from more than
  // one recent season (promotion/relegation churn) - harmless to list them
  // all here, only whichever ones actually have fixtures ever get rendered.
  epl: {
    BOU: '伯恩茅斯',
    ARS: '阿森納',
    AVL: '阿斯頓維拉',
    BRE: '布倫特福',
    BHA: '布萊頓',
    CHE: '切爾西',
    COV: '考文垂城',
    CRY: '水晶宮',
    EVE: '埃弗頓',
    FUL: '富勒姆',
    HUL: '赫爾城',
    IPS: '伊普斯維奇',
    LEE: '里茲聯',
    LIV: '利物浦',
    MNC: '曼城',
    MAN: '曼聯',
    NEW: '紐卡索聯',
    NFO: '諾丁漢森林',
    SUN: '桑德蘭',
    TOT: '托特納姆熱刺'
  }
};

export function teamNameZh(leagueId, abbreviation) {
  return TEAM_NAMES_ZH[leagueId]?.[abbreviation] || '';
}

// F1 has no per-team competitor breakdown in ESPN's scoreboard response
// (see match-builder.mjs's fetchF1Matches) - the "name" worth translating is
// the Grand Prix itself. ESPN's event name always carries a title-sponsor
// prefix that changes season to season (e.g. "Qatar Airways Azerbaijan
// Grand Prix"), so this matches by whichever known location name appears
// LAST in the string, right before "Grand Prix" - a sponsor prefix is
// always prepended, never appended, so the real location is reliably the
// right-most match even when a sponsor's own name (e.g. "Qatar Airways")
// collides with an unrelated country in this table (e.g. "Qatar").
const F1_LOCATION_ZH = {
  Australian: '澳洲',
  Chinese: '中國',
  Japanese: '日本',
  Bahrain: '巴林',
  'Saudi Arabian': '沙烏地阿拉伯',
  Miami: '邁阿密',
  'Emilia Romagna': '艾米利亞羅馬涅',
  Monaco: '摩納哥',
  Canadian: '加拿大',
  Spanish: '西班牙',
  Austrian: '奧地利',
  British: '英國',
  Belgian: '比利時',
  Hungarian: '匈牙利',
  Dutch: '荷蘭',
  Italian: '義大利',
  Azerbaijan: '亞塞拜然',
  Singapore: '新加坡',
  'United States': '美國',
  'Mexico City': '墨西哥城',
  'São Paulo': '聖保羅',
  'Las Vegas': '拉斯維加斯',
  Qatar: '卡達',
  'Abu Dhabi': '阿布達比'
};

export function f1RaceNameZh(eventName) {
  const withoutSuffix = String(eventName || '').replace(/\s*Grand Prix\s*$/i, '');
  let best = '';
  let bestIndex = -1;
  for (const [location, zh] of Object.entries(F1_LOCATION_ZH)) {
    const index = withoutSuffix.lastIndexOf(location);
    if (index > bestIndex) {
      bestIndex = index;
      best = zh;
    }
  }
  return best ? `${best}大獎賽` : '';
}
