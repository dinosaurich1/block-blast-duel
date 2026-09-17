const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { Redis } = require('@upstash/redis');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingTimeout: 25000, pingInterval: 10000, maxHttpBufferSize: 1e6
});

app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
  next();
});

// ============ REDIS ============
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});
const PLAYERS_KEY = 'bbd:players';
const TOURNAMENT_KEY = 'bbd:tournament';
const STATS_KEY = 'bbd:stats';
let stats = {
  totalGamesSolo: 0,
  totalGamesDuel: 0,
  totalGamesTournament: 0,
  totalScoreSolo: 0,
  maxScoreSolo: 0,
  dailyActive: {}, // { '2025-09-17': [userId1, userId2] }
  newPlayersByDay: {}, // { '2025-09-17': 5 }
  playersByGames: {}, // { 1: count, 5: count, 10: count, 20: count }
  totalEmotes: 0,
  totalSkinsBought: 0
};
let players = {};
let playersLoaded = false;
let tournament = null;

const playersReady = (async () => {
  try {
    const [playersData, tourData, statsData] = await Promise.all([
      redis.get(PLAYERS_KEY),
      redis.get(TOURNAMENT_KEY),
      redis.get(STATS_KEY)
    ]);
    let statsParsed = statsData;
    if (typeof statsData === 'string') { try { statsParsed = JSON.parse(statsData); } catch (e) { statsParsed = null; } }
    if (statsParsed && typeof statsParsed === 'object') {
      stats = Object.assign(stats, statsParsed);
    }
    // Игроки
    let parsed = playersData;
    if (typeof playersData === 'string') { try { parsed = JSON.parse(playersData); } catch (e) { parsed = null; } }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      players = parsed;
      for (const uid of Object.keys(players)) {
        const p = players[uid];
        if (typeof p !== 'object' || p === null) { delete players[uid]; continue; }
        migrateProfile(p, uid);
      }
      if (typeof p.lastGameAt !== 'number') p.lastGameAt = 0;
      if (typeof p.coinsSpent !== 'number') p.coinsSpent = 0;
      if (typeof p.emoteCount !== 'number') p.emoteCount = 0;
      if (typeof p.duelWinStreak !== 'number') p.duelWinStreak = 0;
      if (typeof p.duelBestWinStreak !== 'number') p.duelBestWinStreak = 0;
      if (typeof p.tournamentsPlayed !== 'number') p.tournamentsPlayed = 0;
      console.log('Loaded ' + Object.keys(players).length + ' profiles');
    }
    // Турнир
    let tourParsed = tourData;
    if (typeof tourData === 'string') { try { tourParsed = JSON.parse(tourData); } catch (e) { tourParsed = null; } }
    if (tourParsed && typeof tourParsed === 'object') {
      tournament = tourParsed;
      console.log('Loaded tournament: ' + tournament.id + ' (' + tournament.state + ')');
    }
    playersLoaded = true;
  } catch (e) {
    console.error('Redis load failed:', e.message);
    playersLoaded = true;
  }
})();

function migrateProfile(p, uid) {
  if (typeof p.duelWins !== 'number') p.duelWins = 0;
  if (typeof p.duelLosses !== 'number') p.duelLosses = 0;
  if (typeof p.soloGames !== 'number') p.soloGames = 0;
  if (typeof p.rating !== 'number' || !isFinite(p.rating)) p.rating = 0;
  if (typeof p.bestScore !== 'number' || !isFinite(p.bestScore)) p.bestScore = 0;
  if (typeof p.coins !== 'number' || !isFinite(p.coins)) p.coins = 0;
  if (!Array.isArray(p.skins)) p.skins = ['classic'];
  if (typeof p.activeSkin !== 'string') p.activeSkin = 'classic';
  if (!Array.isArray(p.friends)) p.friends = [];
  if (!Array.isArray(p.friendRequests)) p.friendRequests = [];
  if (!Array.isArray(p.achievements)) p.achievements = [];
  if (!Array.isArray(p.titles)) p.titles = ['rookie'];
  if (typeof p.activeTitle !== 'string') p.activeTitle = 'rookie';
  if (!Array.isArray(p.backgrounds)) p.backgrounds = ['default'];
  if (typeof p.activeBackground !== 'string') p.activeBackground = 'default';
  if (!Array.isArray(p.avatars)) p.avatars = [0, 1];
  if (typeof p.activeAvatar !== 'number') p.activeAvatar = 0;
  if (typeof p.stats !== 'object' || p.stats === null) p.stats = {};
  if (typeof p.stats.soloGames !== 'number') p.stats.soloGames = 0;
  if (typeof p.stats.totalLines !== 'number') p.stats.totalLines = 0;
  if (typeof p.stats.maxCombo !== 'number') p.stats.maxCombo = 0;
  if (typeof p.stats.duelGames !== 'number') p.stats.duelGames = 0;
  if (typeof p.stats.duelWins !== 'number') p.stats.duelWins = 0;
  if (typeof p.dailyQuests !== 'object') p.dailyQuests = null;
  if (typeof p.referredBy !== 'string') p.referredBy = null;
  if (typeof p.referralRewarded !== 'boolean') p.referralRewarded = false;
  if (typeof p.referralCount !== 'number') p.referralCount = 0;
  if (!Array.isArray(p.referrals)) p.referrals = [];
  if (typeof p.puzzleBest !== 'number') p.puzzleBest = 0;
  if (typeof p.puzzleLastDate !== 'string') p.puzzleLastDate = null;
  if (!Array.isArray(p.tournamentWins)) p.tournamentWins = [];
  if (typeof p.name !== 'string' || !p.name.trim()) p.name = 'Игрок-' + String(uid || '').slice(-4).toUpperCase();
}

let saveTimer = null;
function savePlayers() {
  if (!playersLoaded) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try { await redis.set(PLAYERS_KEY, JSON.stringify(players)); }
    catch (e) { console.error('Redis save failed:', e.message); }
  }, 800);
}
let statsSaveTimer = null;
function saveStats() {
  if (!playersLoaded) return;
  if (statsSaveTimer) clearTimeout(statsSaveTimer);
  statsSaveTimer = setTimeout(async () => {
    statsSaveTimer = null;
    try { await redis.set(STATS_KEY, JSON.stringify(stats)); }
    catch (e) { console.error('Stats save failed:', e.message); }
  }, 2000);
}

function trackActive(userId) {
  const today = todayStr();
  if (!stats.dailyActive[today]) stats.dailyActive[today] = [];
  if (stats.dailyActive[today].indexOf(userId) === -1) {
    stats.dailyActive[today].push(userId);
  }
  // Чистим старые записи (старше 60 дней)
  const cutoff = Date.now() - 60 * 24 * 3600 * 1000;
  for (const day of Object.keys(stats.dailyActive)) {
    const dayTime = new Date(day).getTime();
    if (dayTime < cutoff) delete stats.dailyActive[day];
  }
  saveStats();
}

function trackNewPlayer() {
  const today = todayStr();
  if (!stats.newPlayersByDay[today]) stats.newPlayersByDay[today] = 0;
  stats.newPlayersByDay[today]++;
  saveStats();
}

function trackGamesBucket(gamesCount) {
  const buckets = [1, 5, 10, 20, 50, 100];
  for (const b of buckets) {
    if (gamesCount === b) {
      if (!stats.playersByGames[b]) stats.playersByGames[b] = 0;
      stats.playersByGames[b]++;
    }
  }
  saveStats();
}

let tourSaveTimer = null;
function saveTournament() {
  if (!playersLoaded) return;
  if (tourSaveTimer) clearTimeout(tourSaveTimer);
  tourSaveTimer = setTimeout(async () => {
    tourSaveTimer = null;
    try {
      if (tournament) await redis.set(TOURNAMENT_KEY, JSON.stringify(tournament));
      else await redis.del(TOURNAMENT_KEY);
    } catch (e) { console.error('Tournament save failed:', e.message); }
  }, 800);
}

// ============ SEASONS ============
function getOrthodoxEaster(year) {
  const a = year % 4, b = year % 7, c = year % 19;
  const d = (19 * c + 15) % 30;
  const e = (2 * a + 4 * b - d + 34) % 7;
  const month = Math.floor((d + e + 114) / 31);
  const day = ((d + e + 114) % 31) + 1;
  const dt = new Date(year, month - 1, day);
  dt.setDate(dt.getDate() + 13);
  return dt;
}
function getSeasonalWindows() {
  const now = new Date(), y = now.getFullYear(), w = [];
  for (const yy of [y - 1, y, y + 1]) {
    w.push({
      id: 'xmas', start: new Date(yy, 11, 29), end: new Date(yy + 1, 0, 4, 23, 59, 59),
      skins: ['xmas_tree', 'xmas_snowflake', 'xmas_garland']
    });
    w.push({
      id: 'halloween', start: new Date(yy, 9, 28), end: new Date(yy, 10, 3, 23, 59, 59),
      skins: ['halloween_skull', 'halloween_bat']
    });
    const easter = getOrthodoxEaster(yy);
    const eStart = new Date(easter); eStart.setDate(eStart.getDate() - 3); eStart.setHours(0, 0, 0, 0);
    const eEnd = new Date(easter); eEnd.setDate(eEnd.getDate() + 3); eEnd.setHours(23, 59, 59, 999);
    w.push({ id: 'easter', start: eStart, end: eEnd, skins: ['easter_egg', 'easter_bunny'] });
  }
  return w;
}
function getActiveSeasonal() {
  const now = new Date(), activeSet = new Set();
  let menuTheme = 'default';
  for (const w of getSeasonalWindows()) {
    if (now >= w.start && now <= w.end) { w.skins.forEach(s => activeSet.add(s)); menuTheme = w.id; }
  }
  return { skins: Array.from(activeSet), menuTheme };
}

// ============ CONSTANTS ============
const GRACE_PERIOD = 90 * 1000;
const MAX_SOLO_SCORE = 50000;
const MAX_SOLO_GAIN = 500;
const SOLO_COIN_DIVISOR = 40;
const DUEL_WIN_COINS = 80;
const DUEL_LOSS_COINS = 15;
const STARTING_COINS = 50;
const REFERRAL_REWARD = 100;
const ROOM_EXPIRY = 10 * 60 * 1000;
const EMOTE_COOLDOWN = 3000;
const EMOTE_LIST = ['😂', '👍', '😱', '🔥', '😡', '👋'];
const TOURNAMENT_ENTRY = 100;
const TOURNAMENT_MIN_PLAYERS = 4;
const TOURNAMENT_MAX_PLAYERS = 8;
const TOURNAMENT_PRIZE_1 = 500;
const TOURNAMENT_PRIZE_2 = 250;
const TOURNAMENT_PRIZE_3 = 100;

const SKIN_CATALOG = {
  classic: 0, neon: 150, bubble: 300, retro: 500,
  ice: 800, lava: 1200, galaxy: 2000, gold: 3000,
  autumn_leaf: 500, autumn_pumpkin: 600, autumn_acorn: 400,
  xmas_tree: 400, xmas_snowflake: 350, xmas_garland: 500,
  halloween_skull: 450, halloween_bat: 500,
  easter_egg: 400, easter_bunny: 500,
  champ_lightning: 0, champ_crown: 0, champ_phoenix: 0, champ_amethyst: 0
};
const BACKGROUND_CATALOG = {
  default: 0, forest: 300, ocean: 300, night: 400,
  autumn: 500, sunset: 500, pixel: 600, space: 800,
  anim_aurora: 500, anim_space: 800, anim_sunset: 500,
  anim_ocean: 500, anim_neon: 800, anim_fire: 600,
  champ_arena: 0, champ_nebula: 0, champ_hall: 0
};
const AVATAR_CATALOG = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 200, 7: 200, 8: 200, 9: 200, 10: 200, 11: 200 };
const SEASONAL_SKINS = ['xmas_tree', 'xmas_snowflake', 'xmas_garland', 'halloween_skull', 'halloween_bat', 'easter_egg', 'easter_bunny'];
const CHAMPION_SKINS = ['champ_lightning', 'champ_crown', 'champ_phoenix', 'champ_amethyst'];
const CHAMPION_BACKGROUNDS = ['champ_arena', 'champ_nebula', 'champ_hall'];

const TITLE_DEFS = [
  { id: 'rookie', name: 'Новичок', req: 'auto' },
  { id: 'first_win', name: 'Победитель', req: 'ach:first_win' },
  { id: 'veteran', name: 'Ветеран', req: 'ach:solo_10' },
  { id: 'lightning', name: 'Молниеносный', req: 'ach:combo_5' },
  { id: 'combo_king', name: 'Король комбо', req: 'ach:combo_10' },
  { id: 'collector', name: 'Коллекционер', req: 'ach:collector_all' },
  { id: 'rich', name: 'Богач', req: 'ach:rich_1000' },
  { id: 'friend', name: 'Друг', req: 'ach:friend' },
  { id: 'duelist', name: 'Дуэлянт', req: 'ach:duel_10' },
  { id: 'gladiator', name: 'Гладиатор', req: 'ach:duel_50' },
  { id: 'champion', name: 'Чемпион недели', req: 'ach:tournament_1' },
  { id: 'autumn_2025', name: 'Осень 2025', req: 'season' }
];
const ACHIEVEMENT_DEFS = [
  { id: 'first_game', name: 'Первый шаг', desc: 'Сыграйте первую игру', icon: '🎮', coins: 50 },
  { id: 'first_win', name: 'Первая победа', desc: 'Победите в дуэли', icon: '🏆', coins: 100 },
  { id: 'score_100', name: 'Разогрев', desc: '100 очков в соло', icon: '⭐', coins: 30 },
  { id: 'score_500', name: 'В ударе', desc: '500 очков в соло', icon: '🌟', coins: 80 },
  { id: 'score_1000', name: 'Тысячник', desc: '1000 очков в соло', icon: '💫', coins: 150 },
  { id: 'score_5000', name: 'Легенда', desc: '5000 очков в соло', icon: '👑', coins: 500 },
  { id: 'combo_5', name: 'Комбо-мастер', desc: 'Комбо x5', icon: '🔥', coins: 100 },
  { id: 'combo_10', name: 'Комбо-бог', desc: 'Комбо x10', icon: '⚡', coins: 300 },
  { id: 'solo_10', name: 'Тренировка', desc: '10 соло-игр', icon: '🎯', coins: 50 },
  { id: 'solo_100', name: 'Марафонец', desc: '100 соло-игр', icon: '🏃', coins: 300 },
  { id: 'duel_10', name: 'Дуэлянт', desc: '10 побед в дуэли', icon: '⚔️', coins: 200 },
  { id: 'duel_50', name: 'Гладиатор', desc: '50 побед в дуэли', icon: '🗡️', coins: 1000 },
  { id: 'friend', name: 'Не один', desc: 'Добавить друга', icon: '👫', coins: 50 },
  { id: 'rich_1000', name: 'Богач', desc: 'Накопить 1000 монет', icon: '💰', coins: 100 },
  { id: 'buy_first_skin', name: 'Модник', desc: 'Купить первый скин', icon: '🎨', coins: 100 },
  { id: 'collector_all', name: 'Коллекционер', desc: 'Собрать все скины', icon: '🏅', coins: 2000 },
  { id: 'referral_1', name: 'Друг друга', desc: 'Пригласить друга', icon: '🤝', coins: 100 },
  { id: 'tournament_1', name: 'Чемпион', desc: 'Победить в турнире', icon: '🏆', coins: 300 },
  { id: 'sunrise', name: 'Проснись и пой', desc: '50 соло-игр', icon: '🌅', coins: 100 },
  { id: 'marathon_plus', name: 'Марафонец+', desc: '200 соло-игр', icon: '🏃', coins: 500 },
  { id: 'sniper', name: 'Снайпер', desc: '3000 очков в соло', icon: '🎯', coins: 200 },
  { id: 'combo_master', name: 'Мастер комбо', desc: 'Комбо x15', icon: '💎', coins: 500 },
  { id: 'duel_100', name: 'Дуэлянт 3', desc: '100 побед в дуэлях', icon: '⚔️', coins: 500 },
  { id: 'win_streak_5', name: 'Серия побед', desc: '5 побед подряд', icon: '🔥', coins: 300 },
  { id: 'domination', name: 'Разгром', desc: 'Победить с разницей 500+', icon: '💀', coins: 150 },
  { id: 'friends_5', name: 'Душа компании', desc: '5 друзей', icon: '👥', coins: 200 },
  { id: 'mentor', name: 'Наставник', desc: '5 рефералов', icon: '📣', coins: 500 },
  { id: 'speaker', name: 'Оратор', desc: 'Отправить 100 эмодзи', icon: '💌', coins: 50 },
  { id: 'shopaholic', name: 'Шопоголик', desc: 'Потратить 5000 монет', icon: '🛒', coins: 500 },
  { id: 'tournaments_10', name: 'Турнирный боец', desc: '10 турниров', icon: '🏟️', coins: 500 }
];
const QUEST_POOL = [
  { type: 'play_solo', target: 3, reward: 60, text: 'Сыграй 3 соло-игры' },
  { type: 'play_solo', target: 5, reward: 100, text: 'Сыграй 5 соло-игр' },
  { type: 'play_duel', target: 2, reward: 80, text: 'Сыграй 2 дуэли' },
  { type: 'win_duel', target: 1, reward: 100, text: 'Победи в дуэли' },
  { type: 'win_duel', target: 2, reward: 180, text: 'Победи в 2 дуэлях' },
  { type: 'lines', target: 20, reward: 80, text: 'Очисти 20 линий' },
  { type: 'lines', target: 50, reward: 150, text: 'Очисти 50 линий' },
  { type: 'combo', target: 3, reward: 100, text: 'Собери комбо x3' },
  { type: 'score_solo', target: 300, reward: 60, text: 'Набери 300 очков' },
  { type: 'score_solo', target: 800, reward: 120, text: 'Набери 800 очков' }
];
const RANKS = [
  { min: 0, name: 'Новичок', icon: '🌱' }, { min: 200, name: 'Бронза', icon: '🥉' },
  { min: 600, name: 'Серебро', icon: '🥈' }, { min: 1500, name: 'Золото', icon: '🥇' },
  { min: 3000, name: 'Платина', icon: '💎' }, { min: 5000, name: 'Алмаз', icon: '💠' },
  { min: 8000, name: 'Мастер', icon: '👑' }, { min: 12000, name: 'Грандмастер', icon: '⚜️' }
];
function getRank(rating) {
  let r = RANKS[0];
  for (const rk of RANKS) { if (rating >= rk.min) r = rk; else break; }
  return r;
}

const online = new Map();
const gameSessions = new Map();
const waiting = [];
const customRooms = new Map();
const ri = (n) => Math.floor(Math.random() * n);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v | 0));

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// ============ PUZZLE OF THE DAY ============
function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return h;
}
function seededRandom(seed) {
  let s = seed;
  return function () {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}
function genPuzzleSequence(dateStr, count) {
  const rand = seededRandom(hashCode('puzzle_' + dateStr));
  const COLORS = ['#ff4757', '#ffa502', '#ffdd59', '#2ed573', '#1e90ff', '#a55eea', '#ff6b81', '#00d2d3'];
  const seq = [];
  for (let i = 0; i < count; i++) {
    const t = [];
    for (let j = 0; j < 3; j++) t.push({ s: Math.floor(rand() * 28), c: COLORS[Math.floor(rand() * COLORS.length)] });
    seq.push(t);
  }
  return seq;
}

function genSequence(count) {
  const seq = [];
  const COLORS = ['#ff4757', '#ffa502', '#ffdd59', '#2ed573', '#1e90ff', '#a55eea', '#ff6b81', '#00d2d3'];
  for (let i = 0; i < count; i++) {
    const t = [];
    for (let j = 0; j < 3; j++) t.push({ s: ri(28), c: COLORS[ri(COLORS.length)] });
    seq.push(t);
  }
  return seq;
}

function sanitizeName(name) {
  if (typeof name !== 'string') return null;
  name = name.trim().slice(0, 18);
  if (name.length < 2) return null;
  return name.replace(/[\x00-\x1F\x7F]/g, '').replace(/\s+/g, ' ').trim();
}

function publicProfile(userId) {
  const p = players[userId];
  if (!p) return null;
  return {
    userId, name: p.name, rating: p.rating, bestScore: p.bestScore,
    coins: p.coins || 0,
    skins: (p.skins || []).slice(),
    activeSkin: p.activeSkin || 'classic',
    friends: (p.friends || []).slice(),
    achievements: (p.achievements || []).slice(),
    titles: (p.titles || ['rookie']).slice(),
    activeTitle: p.activeTitle || 'rookie',
    backgrounds: (p.backgrounds || ['default']).slice(),
    activeBackground: p.activeBackground || 'default',
    avatars: (p.avatars || [0, 1]).slice(),
    activeAvatar: typeof p.activeAvatar === 'number' ? p.activeAvatar : 0,
    referralCount: p.referralCount || 0,
    referredBy: p.referredBy || null,
    referralRewarded: !!p.referralRewarded,
    puzzleBest: p.puzzleBest || 0,
    coinsSpent: p.coinsSpent || 0,
    emoteCount: p.emoteCount || 0,
    duelWinStreak: p.duelWinStreak || 0,
    duelBestWinStreak: p.duelBestWinStreak || 0,
    tournamentsPlayed: p.tournamentsPlayed || 0,
    puzzleLastDate: p.puzzleLastDate || null,
    tournamentWins: (p.tournamentWins || []).slice(),
    duelWins: p.duelWins || 0, duelLosses: p.duelLosses || 0, soloGames: p.soloGames || 0,
    rank: getRank(p.rating),
    seasonal: getActiveSeasonal()
  };
}

function calcDuelDelta(myRating, oppRating, iWon) {
  const expected = 1 / (1 + Math.pow(10, (oppRating - myRating) / 400));
  const raw = iWon ? (1 - expected) : expected;
  return Math.max(1, Math.min(10, Math.round(20 * raw)));
}

function ensureProfile(userId) {
  if (!players[userId]) {
    players[userId] = {
      name: 'Игрок-' + String(userId).slice(-4).toUpperCase(),
      rating: 0, bestScore: 0, coins: STARTING_COINS,
      skins: ['classic'], activeSkin: 'classic',
      friends: [], friendRequests: [],
      achievements: [], titles: ['rookie'], activeTitle: 'rookie',
      backgrounds: ['default'], activeBackground: 'default',
      avatars: [0, 1], activeAvatar: 0,
      stats: { soloGames: 0, totalLines: 0, maxCombo: 0, duelGames: 0, duelWins: 0 },
      dailyQuests: null,
      referredBy: null, referralRewarded: false, referralCount: 0, referrals: [],
      puzzleBest: 0, puzzleLastDate: null, tournamentWins: [],
      coinsSpent: 0, emoteCount: 0,
      duelWinStreak: 0, duelBestWinStreak: 0,
      tournamentsPlayed: 0,
      duelWins: 0, duelLosses: 0, soloGames: 0,
      updatedAt: Date.now()
    };
    savePlayers();
  }
  const p = players[userId];
  migrateProfile(p, userId);
  return p;
}

function unlockAchievement(userId, achId) {
  const p = players[userId];
  if (!p || !Array.isArray(p.achievements)) return null;
  if (p.achievements.includes(achId)) return null;
  const def = ACHIEVEMENT_DEFS.find(a => a.id === achId);
  if (!def) return null;
  p.achievements.push(achId);
  p.coins = (p.coins || 0) + def.coins;
  p.updatedAt = Date.now();
  for (const t of TITLE_DEFS) {
    if (t.req === 'ach:' + achId && !p.titles.includes(t.id)) p.titles.push(t.id);
  }
  savePlayers();
  const o = online.get(userId);
  if (o && o.socket) o.socket.emit('achievementUnlocked', { id: achId, name: def.name, icon: def.icon, coins: def.coins });
  return def;
}

function checkAchievements(userId, context) {
  const p = players[userId];
  if (!p) return;
  if (context.gamePlayed) unlockAchievement(userId, 'first_game');
  const score = context.soloScore || 0;
  if (score >= 100) unlockAchievement(userId, 'score_100');
  if (score >= 500) unlockAchievement(userId, 'score_500');
  if (score >= 1000) unlockAchievement(userId, 'score_1000');
  if (score >= 5000) unlockAchievement(userId, 'score_5000');
  const combo = context.maxCombo || 0;
  if (combo >= 5) unlockAchievement(userId, 'combo_5');
  if (combo >= 10) unlockAchievement(userId, 'combo_10');
  const soloGames = p.stats.soloGames || 0;
  if (soloGames >= 10) unlockAchievement(userId, 'solo_10');
  if (soloGames >= 100) unlockAchievement(userId, 'solo_100');
  const duelWins = p.stats.duelWins || 0;
  if (duelWins >= 1) unlockAchievement(userId, 'first_win');
  if (duelWins >= 10) unlockAchievement(userId, 'duel_10');
  if (duelWins >= 50) unlockAchievement(userId, 'duel_50');
  if ((p.coins || 0) >= 1000) unlockAchievement(userId, 'rich_1000');
  const allSkins = Object.keys(SKIN_CATALOG);
  if (allSkins.every(s => (p.skins || []).includes(s))) unlockAchievement(userId, 'collector_all');
  // Новые проверки
  if (soloGames >= 50) unlockAchievement(userId, 'sunrise');
  if (soloGames >= 200) unlockAchievement(userId, 'marathon_plus');
  if (score >= 3000) unlockAchievement(userId, 'sniper');
  if (combo >= 15) unlockAchievement(userId, 'combo_master');
  if ((p.duelWins || 0) >= 100) unlockAchievement(userId, 'duel_100');
  if ((p.duelBestWinStreak || 0) >= 5) unlockAchievement(userId, 'win_streak_5');
  if ((p.friends || []).length >= 5) unlockAchievement(userId, 'friends_5');
  if ((p.referralCount || 0) >= 5) unlockAchievement(userId, 'mentor');
  if ((p.emoteCount || 0) >= 100) unlockAchievement(userId, 'speaker');
  if ((p.coinsSpent || 0) >= 5000) unlockAchievement(userId, 'shopaholic');
  if ((p.tournamentsPlayed || 0) >= 10) unlockAchievement(userId, 'tournaments_10');
}

function applyReferral(newUserId, referrerId) {
  if (!newUserId || !referrerId || newUserId === referrerId) return;
  const newP = players[newUserId], refP = players[referrerId];
  if (!newP || !refP || newP.referredBy) return;
  newP.referredBy = referrerId;
  newP.updatedAt = Date.now();
  savePlayers();
}

function grantReferralIfNeeded(userId) {
  const p = players[userId];
  if (!p || !p.referredBy || p.referralRewarded) return null;
  const refP = players[p.referredBy];
  if (!refP) { p.referralRewarded = true; savePlayers(); return null; }
  p.coins = (p.coins || 0) + REFERRAL_REWARD;
  refP.coins = (refP.coins || 0) + REFERRAL_REWARD;
  refP.referralCount = (refP.referralCount || 0) + 1;
  if (!Array.isArray(refP.referrals)) refP.referrals = [];
  refP.referrals.push(userId);
  p.referralRewarded = true;
  p.updatedAt = Date.now();
  refP.updatedAt = Date.now();
  savePlayers();
  unlockAchievement(p.referredBy, 'referral_1');
  const refO = online.get(p.referredBy);
  if (refO && refO.socket) refO.socket.emit('referralRewarded', { bonus: REFERRAL_REWARD, fromName: p.name, count: refP.referralCount });
  return { bonus: REFERRAL_REWARD, referrer: p.referredBy };
}

function getOrCreateDailyQuests(userId) {
  const p = players[userId];
  if (!p) return null;
  const today = todayStr();
  if (p.dailyQuests && p.dailyQuests.date === today) return p.dailyQuests;
  const pool = QUEST_POOL.slice();
  const quests = [];
  for (let i = 0; i < 3 && pool.length > 0; i++) {
    const idx = ri(pool.length);
    const q = pool.splice(idx, 1)[0];
    quests.push({ id: 'q_' + Date.now() + '_' + i, type: q.type, target: q.target, reward: q.reward, text: q.text, progress: 0, claimed: false });
  }
  p.dailyQuests = { date: today, quests };
  savePlayers();
  return p.dailyQuests;
}

function updateQuestProgress(userId, event, amount) {
  const p = players[userId];
  if (!p) return;
  const dq = getOrCreateDailyQuests(userId);
  if (!dq || !Array.isArray(dq.quests)) return;
  let changed = false;
  for (const q of dq.quests) {
    if (q.claimed || q.progress >= q.target) continue;
    let match = false;
    if (event === 'play_solo' && q.type === 'play_solo') match = true;
    if (event === 'play_duel' && q.type === 'play_duel') match = true;
    if (event === 'win_duel' && q.type === 'win_duel') match = true;
    if (event === 'lines' && q.type === 'lines') match = true;
    if (event === 'combo' && q.type === 'combo') match = true;
    if (event === 'score_solo' && q.type === 'score_solo') match = true;
    if (match) {
      if (event === 'combo') q.progress = Math.max(q.progress, amount);
      else q.progress += amount;
      if (q.progress > q.target) q.progress = q.target;
      changed = true;
    }
  }
  if (changed) {
    savePlayers();
    const o = online.get(userId);
    if (o && o.socket) o.socket.emit('questsUpdated', dq);
  }
}

function cleanupOnline(userId) {
  const o = online.get(userId);
  if (!o) return;
  if (o.disconnectTimer) { clearTimeout(o.disconnectTimer); o.disconnectTimer = null; }
  if (o.opponentId) {
    const opp = online.get(o.opponentId);
    if (opp && opp.socket) { opp.socket.emit('oppLeft'); opp.opponentId = null; opp.roomId = null; }
  }
  online.delete(userId);
}

const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genRoomCode() {
  let code = '';
  for (let i = 0; i < 6; i++) code += ROOM_CHARS[ri(ROOM_CHARS.length)];
  return code;
}
setInterval(() => {
  const now = Date.now();
  for (const [code, r] of customRooms) if (now - r.createdAt > ROOM_EXPIRY) customRooms.delete(code);
}, 60000);

function startMatch(hostId, guestId, hostSocket, guestSocket, options) {
  options = options || {};
  const hostO = online.get(hostId);
  const guestO = online.get(guestId);
  if (!hostO || !guestO) return false;
  const roomId = 'room_' + hostId + '_' + Date.now();
  hostSocket.join(roomId); guestSocket.join(roomId);
  hostO.roomId = roomId; hostO.opponentId = guestId; hostO.score = 0;
  hostO.matchType = options.type || 'duel';
  hostO.tournamentMatchId = options.tournamentMatchId || null;
  guestO.roomId = roomId; guestO.opponentId = hostId; guestO.score = 0;
  guestO.matchType = options.type || 'duel';
  guestO.tournamentMatchId = options.tournamentMatchId || null;
  const sequence = options.sequence || genSequence(300);
  hostSocket.emit('matchFound', {
    sequence, playerIndex: 0,
    oppName: players[guestId] ? players[guestId].name : 'Соперник',
    oppRating: players[guestId] ? players[guestId].rating : 0,
    oppAvatar: players[guestId] ? players[guestId].activeAvatar || 0 : 0,
    matchType: options.type || 'duel',
    tournamentMatchId: options.tournamentMatchId || null,
    tournamentRoundLabel: options.tournamentRoundLabel || null
  });
  guestSocket.emit('matchFound', {
    sequence, playerIndex: 1,
    oppName: players[hostId] ? players[hostId].name : 'Соперник',
    oppRating: players[hostId] ? players[hostId].rating : 0,
    oppAvatar: players[hostId] ? players[hostId].activeAvatar || 0 : 0,
    matchType: options.type || 'duel',
    tournamentMatchId: options.tournamentMatchId || null,
    tournamentRoundLabel: options.tournamentRoundLabel || null
  });
  return true;
}

function grantChampionReward(userId, rewardId) {
  const p = players[userId];
  if (!p) return false;
  if (CHAMPION_SKINS.indexOf(rewardId) !== -1) {
    if (!p.skins.includes(rewardId)) p.skins.push(rewardId);
  } else if (CHAMPION_BACKGROUNDS.indexOf(rewardId) !== -1) {
    if (!p.backgrounds.includes(rewardId)) p.backgrounds.push(rewardId);
  } else return false;
  p.updatedAt = Date.now();
  savePlayers();
  const o = online.get(userId);
  if (o && o.socket) o.socket.emit('championReward', { id: rewardId });
  return true;
}

function buildLeaderboard(type, userId) {
  type = (type === 'solo' || type === 'duel') ? type : 'overall';
  const entries = Object.keys(players).map(uid => ({
    userId: uid, name: players[uid].name, rating: players[uid].rating,
    bestScore: players[uid].bestScore,
    duelWins: players[uid].duelWins || 0, duelLosses: players[uid].duelLosses || 0,
    soloGames: players[uid].soloGames || 0,
    activeAvatar: players[uid].activeAvatar || 0
  }));
  let sortKey;
  if (type === 'solo') sortKey = (a, b) => (b.bestScore - a.bestScore) || (b.rating - a.rating);
  else if (type === 'duel') sortKey = (a, b) => (b.duelWins - a.duelWins) || (b.rating - a.rating);
  else sortKey = (a, b) => b.rating - a.rating;
  const allSorted = entries.slice().sort(sortKey);
  const top = allSorted.slice(0, 50).map((e, i) => ({
    ...e, position: i + 1, rank: getRank(e.rating), isMe: e.userId === userId
  }));
  let myPosition = null;
  if (userId && players[userId]) {
    const idx = allSorted.findIndex(x => x.userId === userId);
    myPosition = idx >= 0 ? idx + 1 : null;
  }
  return { list: top, myPosition, total: allSorted.length, type };
}

// ============ TOURNAMENT ============
function getTournamentIdForDate(d) {
  // ID по дате воскресенья этой недели
  const day = d.getDay(); // 0 = вс
  const sunday = new Date(d);
  if (day !== 0) sunday.setDate(sunday.getDate() + (7 - day));
  return 'tour_' + sunday.getFullYear() + '_' + String(sunday.getMonth() + 1).padStart(2, '0') + '_' + String(sunday.getDate()).padStart(2, '0');
}

function getTournamentSunday() {
  const now = new Date();
  const mskNow = new Date(now.getTime() + 3 * 3600 * 1000);
  const day = mskNow.getUTCDay();
  let diff = (7 - day) % 7;
  if (day === 0) {
    const h = mskNow.getUTCHours();
    if (h >= 18) diff = 7;
  }
  const sunday = new Date(mskNow);
  sunday.setUTCDate(sunday.getUTCDate() + diff);
  sunday.setUTCHours(18, 0, 0, 0);
  return new Date(sunday.getTime() - 3 * 3600 * 1000);
}

function createNewTournament() {
  const sunday = getTournamentSunday();
  const id = getTournamentIdForDate(sunday);
  return {
    id,
    state: 'registration',
    startTime: sunday.getTime(),
    players: [],
    bracket: null,
    createdAt: Date.now(),
    finishedAt: null,
    winner: null,
    second: null,
    semifinalists: []
  };
}

function ensureTournament() {
  const now = Date.now();
  const expectedId = getTournamentIdForDate(getTournamentSunday());
  // Если турнира нет — создаём
  if (!tournament) {
    tournament = createNewTournament();
    saveTournament();
    return;
  }
  // Если турнир устаревший (прошло >1 дня после старта и он finished/cancelled) — сбрасываем
  if (tournament.id !== expectedId) {
    if (tournament.state === 'finished' || tournament.state === 'cancelled') {
      tournament = createNewTournament();
      saveTournament();
    }
  }
}

function registerForTournament(userId) {
  const p = ensureProfile(userId);
  if (!tournament) return { error: 'no_tournament' };
  if (tournament.state !== 'registration') return { error: 'registration_closed' };
  if (tournament.players.length >= TOURNAMENT_MAX_PLAYERS) return { error: 'tournament_full' };
  if (tournament.players.find(x => x.userId === userId)) return { error: 'already_registered' };
  if ((p.coins || 0) < TOURNAMENT_ENTRY) return { error: 'not_enough_coins' };
  p.coins -= TOURNAMENT_ENTRY;
  p.updatedAt = Date.now();
  tournament.players.push({ userId, name: p.name, rating: p.rating, joinedAt: Date.now() });
  p.tournamentsPlayed = (p.tournamentsPlayed || 0) + 1;
  savePlayers();
  saveTournament();
  return { ok: true, coins: p.coins };
}

function unregisterFromTournament(userId) {
  const p = ensureProfile(userId);
  if (!tournament || tournament.state !== 'registration') return { error: 'too_late' };
  const idx = tournament.players.findIndex(x => x.userId === userId);
  if (idx === -1) return { error: 'not_registered' };
  tournament.players.splice(idx, 1);
  p.coins = (p.coins || 0) + TOURNAMENT_ENTRY;
  p.updatedAt = Date.now();
  savePlayers();
  saveTournament();
  return { ok: true, coins: p.coins };
}

function buildBracket(playersList) {
  // Перемешиваем случайно
  const shuffled = playersList.slice().sort(() => Math.random() - 0.5);
  // Дополняем до 8 фейковыми bye
  const N = 8;
  const slots = shuffled.slice();
  const byes = [];
  while (slots.length < N) {
    byes.push(null);
    slots.push(null);
  }
  const matches = [];
  for (let i = 0; i < N; i += 2) {
    const p1 = slots[i] ? slots[i].userId : null;
    const p2 = slots[i + 1] ? slots[i + 1].userId : null;
    const status = (p1 && p2) ? 'waiting' : 'done';
    const winner = p1 && !p2 ? p1 : (!p1 && p2 ? p2 : null);
    matches.push({
      id: 'r1_m' + (i / 2 + 1),
      p1, p2, winner, status,
      roomId: null,
      startedAt: status === 'done' ? Date.now() : null,
      finishedAt: status === 'done' ? Date.now() : null
    });
  }
  return { round1: matches, round2: null, round3: null };
}

function getRoundLabel(roundIndex) {
  if (roundIndex === 1) return '¼ финала';
  if (roundIndex === 2) return '½ финала';
  if (roundIndex === 3) return 'Финал';
  return 'Матч';
}

function getNextRoundIndex(roundIndex) { return roundIndex + 1; }
function getNextRoundKey(roundIndex) {
  if (roundIndex === 1) return 'round2';
  if (roundIndex === 2) return 'round3';
  return null;
}
function getPrevRoundKey(roundIndex) {
  if (roundIndex === 2) return 'round1';
  if (roundIndex === 3) return 'round2';
  return null;
}

function buildNextRound(roundIndex) {
  const prevKey = getPrevRoundKey(roundIndex);
  if (!prevKey) return null;
  const prev = tournament.bracket[prevKey];
  if (!prev) return null;
  const matches = [];
  for (let i = 0; i < prev.length; i += 2) {
    const m1 = prev[i], m2 = prev[i + 1];
    const p1 = m1.winner || null;
    const p2 = m2.winner || null;
    const status = (p1 && p2) ? 'waiting' : 'done';
    const winner = p1 && !p2 ? p1 : (!p1 && p2 ? p2 : null);
    matches.push({
      id: 'r' + roundIndex + '_m' + (i / 2 + 1),
      p1, p2, winner, status,
      roomId: null,
      startedAt: status === 'done' ? Date.now() : null,
      finishedAt: status === 'done' ? Date.now() : null
    });
  }
  return matches;
}

function startTournament() {
  if (!tournament) return;
  if (tournament.players.length < TOURNAMENT_MIN_PLAYERS) {
    // Отмена + возврат
    for (const entry of tournament.players) {
      const p = players[entry.userId];
      if (p) { p.coins = (p.coins || 0) + TOURNAMENT_ENTRY; p.updatedAt = Date.now(); }
      const o = online.get(entry.userId);
      if (o && o.socket) o.socket.emit('tournamentCancelled', { reason: 'not_enough_players' });
    }
    savePlayers();
    tournament.state = 'cancelled';
    tournament.finishedAt = Date.now();
    saveTournament();
    return;
  }
  tournament.state = 'running';
  tournament.startedAt = Date.now();
  tournament.bracket = buildBracket(tournament.players);
  saveTournament();
  // Уведомляем всех участников
  for (const entry of tournament.players) {
    const o = online.get(entry.userId);
    if (o && o.socket) o.socket.emit('tournamentStarted', { tournament: getTournamentForClient() });
  }
}

function getTournamentForClient() {
  if (!tournament) return null;
  return {
    id: tournament.id,
    state: tournament.state,
    startTime: tournament.startTime,
    players: tournament.players.map(p => ({ userId: p.userId, name: p.name, rating: p.rating })),
    bracket: tournament.bracket,
    winner: tournament.winner,
    second: tournament.second,
    semifinalists: tournament.semifinalists,
    entryFee: TOURNAMENT_ENTRY,
    prize1: TOURNAMENT_PRIZE_1,
    prize2: TOURNAMENT_PRIZE_2,
    prize3: TOURNAMENT_PRIZE_3
  };
}

function findMatchInRound(roundIndex, matchId) {
  const key = 'round' + roundIndex;
  if (!tournament || !tournament.bracket) return null;
  const round = tournament.bracket[key];
  if (!round) return null;
  return round.find(m => m.id === matchId);
}

function tryStartTournamentMatch(match, roundIndex) {
  if (!match || match.status !== 'waiting') return false;
  if (!match.p1 || !match.p2) return false;
  const o1 = online.get(match.p1);
  const o2 = online.get(match.p2);
  if (!o1 || !o1.socket || !o1.socket.connected) return false;
  if (!o2 || !o2.socket || !o2.socket.connected) return false;
  if (o1.roomId || o2.roomId) return false; // кто-то занят
  const sequence = genSequence(300);
  const ok = startMatch(match.p1, match.p2, o1.socket, o2.socket, {
    type: 'tournament',
    tournamentMatchId: match.id,
    tournamentRoundLabel: getRoundLabel(roundIndex),
    sequence
  });
  if (ok) {
    match.status = 'playing';
    match.startedAt = Date.now();
    saveTournament();
  }
  return ok;
}

function advanceTournament(loserId, winnerId) {
  if (!tournament || tournament.state !== 'running' || !tournament.bracket) return;
  // Находим матч, где проиграл loserId
  const rounds = [1, 2, 3];
  for (const r of rounds) {
    const key = 'round' + r;
    const round = tournament.bracket[key];
    if (!round) continue;
    for (const m of round) {
      if (m.status === 'playing' && ((m.p1 === loserId && m.p2 === winnerId) || (m.p2 === loserId && m.p1 === winnerId))) {
        m.winner = winnerId;
        m.status = 'done';
        m.finishedAt = Date.now();
        saveTournament();
        // Проверяем, все ли матчи раунда завершены
        const allDone = round.every(x => x.status === 'done');
        if (allDone) {
          if (r === 3) {
            // Финал завершён
            finishTournament(winnerId, m.p1 === winnerId ? m.p2 : m.p1);
          } else {
            // Строим следующий раунд
            const nextKey = getNextRoundKey(r);
            if (!tournament.bracket[nextKey]) {
              tournament.bracket[nextKey] = buildNextRound(r + 1);
              saveTournament();
            }
          }
        }
        return;
      }
    }
  }
}

function finishTournament(winnerId, secondId) {
  if (!tournament) return;
  tournament.state = 'finished';
  tournament.finishedAt = Date.now();
  tournament.winner = winnerId;
  tournament.second = secondId;
  // Собираем полуфиналистов
  const r2 = tournament.bracket.round2 || [];
  const semis = [];
  for (const m of r2) {
    const l = m.p1 === m.winner ? m.p2 : m.p1;
    if (l && l !== winnerId && l !== secondId) semis.push(l);
  }
  tournament.semifinalists = semis;
  // Призы
  const prizeSkinList = CHAMPION_SKINS.concat(CHAMPION_BACKGROUNDS);
  const w = players[winnerId];
  if (w) {
    w.coins = (w.coins || 0) + TOURNAMENT_PRIZE_1;
    if (!Array.isArray(w.tournamentWins)) w.tournamentWins = [];
    w.tournamentWins.push(tournament.id);
    // Случайная чемпионская награда из тех, которых ещё нет
    const owned = (w.skins || []).concat(w.backgrounds || []);
    const available = prizeSkinList.filter(x => !owned.includes(x));
    if (available.length > 0) {
      const pick = available[ri(available.length)];
      grantChampionReward(winnerId, pick);
    } else {
      w.coins += TOURNAMENT_PRIZE_1; // дублируем приз
    }
    w.updatedAt = Date.now();
    unlockAchievement(winnerId, 'tournament_1');
  }
  const s = players[secondId];
  if (s) { s.coins = (s.coins || 0) + TOURNAMENT_PRIZE_2; s.updatedAt = Date.now(); }
  for (const sid of semis) {
    const sp = players[sid];
    if (sp) { sp.coins = (sp.coins || 0) + TOURNAMENT_PRIZE_3; sp.updatedAt = Date.now(); }
  }
  savePlayers();
  saveTournament();
  // Уведомляем всех
  for (const entry of tournament.players) {
    const o = online.get(entry.userId);
    if (o && o.socket) o.socket.emit('tournamentFinished', { tournament: getTournamentForClient() });
  }
}

function tickTournament() {
  ensureTournament();
  if (!tournament) return;
  const now = Date.now();
  // Автостарт в момент начала
  if (tournament.state === 'registration' && now >= tournament.startTime) {
    startTournament();
    return;
  }
  // Автостарт матчей раунда, если оба игрока онлайн
  if (tournament.state === 'running' && tournament.bracket) {
    for (const r of [1, 2, 3]) {
      const key = 'round' + r;
      const round = tournament.bracket[key];
      if (!round) continue;
      for (const m of round) {
        if (m.status === 'waiting') tryStartTournamentMatch(m, r);
      }
    }
  }
}
setInterval(tickTournament, 20000);

// ============ REST ============
app.get('/api/leaderboard', (req, res) => {
  try {
    const type = String(req.query.type || 'overall');
    const userId = req.query.userId ? String(req.query.userId) : null;
    res.set('Cache-Control', 'no-store');
    res.json(buildLeaderboard(type, userId));
  } catch (e) { res.status(500).json({ error: 'server_error' }); }
});
app.get('/api/season', (req, res) => { res.set('Cache-Control', 'no-store'); res.json(getActiveSeasonal()); });
app.get('/api/tournament', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(getTournamentForClient());
});
app.get('/api/puzzle', (req, res) => {
  try {
    const dateStr = todayStr();
    const sequence = genPuzzleSequence(dateStr, 500);
    res.set('Cache-Control', 'no-store');
    res.json({ date: dateStr, sequence });
  } catch (e) { res.status(500).json({ error: 'server_error' }); }
});
app.get('/admin/stats', (req, res) => {
  const secret = process.env.ADMIN_SECRET || 'change-me';
  if (req.query.key !== secret) {
    res.status(403).send('Forbidden. Use ?key=YOUR_ADMIN_SECRET');
    return;
  }

  const today = todayStr();
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);

  const activeToday = (stats.dailyActive[today] || []).length;
  let activeWeek = 0, activeMonth = 0;
  for (const day of Object.keys(stats.dailyActive)) {
    if (day >= weekAgo) activeWeek += stats.dailyActive[day].length;
    if (day >= monthAgo) activeMonth += stats.dailyActive[day].length;
  }

  const totalPlayers = Object.keys(players).length;
  const totalGames = stats.totalGamesSolo + stats.totalGamesDuel + stats.totalGamesTournament;
  const avgScore = stats.totalGamesSolo > 0 ? Math.round(stats.totalScoreSolo / stats.totalGamesSolo) : 0;

  const totalCoins = Object.keys(players).reduce((s, uid) => s + (players[uid].coins || 0), 0);
  const totalSkinsOwned = Object.keys(players).reduce((s, uid) => s + (players[uid].skins || []).length, 0);

  const html = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<title>Block Blast Duel — Аналитика</title>
<style>
body { font-family: system-ui, sans-serif; background: #0a0520; color: #fff; padding: 20px; max-width: 900px; margin: 0 auto; }
h1 { color: #a55eea; margin-bottom: 20px; }
h2 { color: #1e90ff; margin: 25px 0 10px; font-size: 18px; }
.card { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 15px; margin-bottom: 10px; display: inline-block; margin-right: 10px; min-width: 140px; }
.card .value { font-size: 28px; font-weight: 900; color: #ffd93b; }
.card .label { font-size: 11px; color: rgba(255,255,255,0.6); text-transform: uppercase; letter-spacing: 1px; margin-top: 4px; }
table { width: 100%; border-collapse: collapse; margin-top: 10px; }
th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.08); font-size: 13px; }
th { color: rgba(255,255,255,0.5); text-transform: uppercase; font-size: 10px; letter-spacing: 1px; }
td.num { font-variant-numeric: tabular-nums; color: #ffd93b; font-weight: 700; }
</style>
</head>
<body>
<h1>📊 Block Blast Duel — Аналитика</h1>

<h2>Общее</h2>
<div>
<div class="card"><div class="value">${totalPlayers}</div><div class="label">Всего игроков</div></div>
<div class="card"><div class="value">${online.size}</div><div class="label">Онлайн сейчас</div></div>
<div class="card"><div class="value">${totalGames}</div><div class="label">Сыграно игр</div></div>
<div class="card"><div class="value">${avgScore}</div><div class="label">Средний счёт</div></div>
<div class="card"><div class="value">${stats.maxScoreSolo}</div><div class="label">Макс. счёт</div></div>
<div class="card"><div class="value">${totalCoins}</div><div class="label">Монет у игроков</div></div>
</div>

<h2>Активность</h2>
<div>
<div class="card"><div class="value">${activeToday}</div><div class="label">Сегодня</div></div>
<div class="card"><div class="value">${activeWeek}</div><div class="label">За 7 дней</div></div>
<div class="card"><div class="value">${activeMonth}</div><div class="label">За 30 дней</div></div>
</div>

<h2>По режимам</h2>
<table>
<tr><th>Режим</th><th>Игр</th></tr>
<tr><td>Соло</td><td class="num">${stats.totalGamesSolo}</td></tr>
<tr><td>Дуэли</td><td class="num">${stats.totalGamesDuel}</td></tr>
<tr><td>Турниры</td><td class="num">${stats.totalGamesTournament}</td></tr>
</table>

<h2>Вовлечение (сколько игроков доходит до N игр)</h2>
<table>
<tr><th>Игр сыграно</th><th>Игроков дошло</th></tr>
${[1, 5, 10, 20, 50, 100].map(b => `<tr><td>${b}</td><td class="num">${stats.playersByGames[b] || 0}</td></tr>`).join('')}
</table>

<h2>Новые игроки по дням</h2>
<table>
<tr><th>Дата</th><th>Новых</th><th>Активных</th></tr>
${Object.keys(stats.newPlayersByDay).sort().reverse().slice(0, 14).map(d =>
    `<tr><td>${d}</td><td class="num">${stats.newPlayersByDay[d]}</td><td class="num">${(stats.dailyActive[d] || []).length}</td></tr>`
  ).join('')}
</table>

<h2>Прочее</h2>
<div>
<div class="card"><div class="value">${stats.totalEmotes}</div><div class="label">Эмодзи отправлено</div></div>
<div class="card"><div class="value">${stats.totalSkinsBought}</div><div class="label">Скинов куплено</div></div>
<div class="card"><div class="value">${totalSkinsOwned}</div><div class="label">Скинов у игроков</div></div>
</div>

<p style="margin-top:30px;color:rgba(255,255,255,0.4);font-size:12px;">
Обновлено: ${new Date().toISOString()} · МСК: ${new Date(Date.now() + 3 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19)}
</p>
</body>
</html>`;
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});
app.get('/health', (req, res) => {
  res.status(200).json({
    ok: true, uptime: Math.floor(process.uptime()),
    players: Object.keys(players).length,
    online: online.size, rooms: customRooms.size,
    redisLoaded: playersLoaded,
    season: getActiveSeasonal(),
    tournament: tournament ? { id: tournament.id, state: tournament.state, players: tournament.players.length } : null
  });
});

// ============ SOCKET ============
io.on('connection', (socket) => {

  socket.on('syncProfile', async ({ userId, name, localRating, localBest, ref }, cb) => {
    await playersReady;
    if (!userId || typeof userId !== 'string' || userId.length > 64) { if (cb) cb({ error: 'bad_user_id' }); return; }
    let p = players[userId];
    const isNew = !p;
    const incomingName = sanitizeName(name);
    if (isNew) {
      p = {
        name: incomingName || ('Игрок-' + String(userId).slice(-4).toUpperCase()),
        rating: clamp(localRating || 0, 0, 100000),
        bestScore: clamp(localBest || 0, 0, MAX_SOLO_SCORE),
        coins: STARTING_COINS,
        skins: ['classic'], activeSkin: 'classic',
        friends: [], friendRequests: [],
        achievements: [], titles: ['rookie'], activeTitle: 'rookie',
        backgrounds: ['default'], activeBackground: 'default',
        avatars: [0, 1], activeAvatar: 0,
        stats: { soloGames: 0, totalLines: 0, maxCombo: 0, duelGames: 0, duelWins: 0 },
        dailyQuests: null,
        referredBy: null, referralRewarded: false, referralCount: 0, referrals: [],
        puzzleBest: 0, puzzleLastDate: null, tournamentWins: [],
        duelWins: 0, duelLosses: 0, soloGames: 0,
        updatedAt: Date.now()
      };
      players[userId] = p;
      trackNewPlayer();
      if (ref && typeof ref === 'string' && ref !== userId) applyReferral(userId, ref);
    } else if (incomingName && incomingName !== p.name) {
      p.name = incomingName; p.updatedAt = Date.now();
    }
    migrateProfile(p, userId);
    getOrCreateDailyQuests(userId);
    trackActive(userId);
    savePlayers();
    socket.data.userId = userId;
    if (cb) cb({ profile: publicProfile(userId), isNew, season: getActiveSeasonal(), tournament: getTournamentForClient() });
  });

  socket.on('setName', async ({ userId, name }, cb) => {
    await playersReady;
    if (!userId) { if (cb) cb({ error: 'no_user' }); return; }
    const p = ensureProfile(userId);
    const nn = sanitizeName(name);
    if (!nn) { if (cb) cb({ error: 'bad_name' }); return; }
    p.name = nn; p.updatedAt = Date.now();
    savePlayers();
    if (cb) cb({ profile: publicProfile(userId) });
  });

  // ---- SHOP ----
  socket.on('buySkin', async ({ userId, skinId }, cb) => {
    await playersReady;
    if (!userId) { if (cb) cb({ error: 'no_user' }); return; }
    const p = ensureProfile(userId);
    if (!(skinId in SKIN_CATALOG)) { if (cb) cb({ error: 'unknown_skin' }); return; }
    if (CHAMPION_SKINS.indexOf(skinId) !== -1) { if (cb) cb({ error: 'champion_only' }); return; }
    if (p.skins.includes(skinId)) { if (cb) cb({ error: 'already_owned' }); return; }
    if (SEASONAL_SKINS.indexOf(skinId) !== -1) {
      const act = getActiveSeasonal();
      if (act.skins.indexOf(skinId) === -1) { if (cb) cb({ error: 'not_available' }); return; }
    }
    const cost = SKIN_CATALOG[skinId];
    if ((p.coins || 0) < cost) { if (cb) cb({ error: 'not_enough_coins' }); return; }
    p.coins -= cost; p.skins.push(skinId);
    p.coinsSpent = (p.coinsSpent || 0) + cost;
    stats.totalSkinsBought = (stats.totalSkinsBought || 0) + 1;
    saveStats();
    if (skinId.startsWith('autumn_') && !p.titles.includes('autumn_2025')) p.titles.push('autumn_2025');
    p.updatedAt = Date.now();
    if (p.skins.length >= 2) unlockAchievement(userId, 'buy_first_skin');
    checkAchievements(userId, {});
    savePlayers();
    if (cb) cb({ profile: publicProfile(userId) });
  });
  socket.on('setActiveSkin', async ({ userId, skinId }, cb) => {
    await playersReady;
    if (!userId) { if (cb) cb({ error: 'no_user' }); return; }
    const p = ensureProfile(userId);
    if (!p.skins.includes(skinId)) { if (cb) cb({ error: 'not_owned' }); return; }
    p.activeSkin = skinId; p.updatedAt = Date.now(); savePlayers();
    if (cb) cb({ profile: publicProfile(userId) });
  });
  socket.on('buyBackground', async ({ userId, bgId }, cb) => {
    await playersReady;
    if (!userId) { if (cb) cb({ error: 'no_user' }); return; }
    const p = ensureProfile(userId);
    if (!(bgId in BACKGROUND_CATALOG)) { if (cb) cb({ error: 'unknown_bg' }); return; }
    if (CHAMPION_BACKGROUNDS.indexOf(bgId) !== -1) { if (cb) cb({ error: 'champion_only' }); return; }
    if (p.backgrounds.includes(bgId)) { if (cb) cb({ error: 'already_owned' }); return; }
    const cost = BACKGROUND_CATALOG[bgId];
    if ((p.coins || 0) < cost) { if (cb) cb({ error: 'not_enough_coins' }); return; }
    p.coins -= cost; p.backgrounds.push(bgId);
    p.updatedAt = Date.now(); savePlayers();
    if (cb) cb({ profile: publicProfile(userId) });
  });
  socket.on('setActiveBackground', async ({ userId, bgId }, cb) => {
    await playersReady;
    if (!userId) { if (cb) cb({ error: 'no_user' }); return; }
    const p = ensureProfile(userId);
    if (!p.backgrounds.includes(bgId)) { if (cb) cb({ error: 'not_owned' }); return; }
    p.activeBackground = bgId; p.updatedAt = Date.now(); savePlayers();
    if (cb) cb({ profile: publicProfile(userId) });
  });
  socket.on('buyAvatar', async ({ userId, avatarId }, cb) => {
    await playersReady;
    if (!userId) { if (cb) cb({ error: 'no_user' }); return; }
    const p = ensureProfile(userId);
    if (!(avatarId in AVATAR_CATALOG)) { if (cb) cb({ error: 'unknown_avatar' }); return; }
    if (p.avatars.includes(avatarId)) { if (cb) cb({ error: 'already_owned' }); return; }
    const cost = AVATAR_CATALOG[avatarId];
    if ((p.coins || 0) < cost) { if (cb) cb({ error: 'not_enough_coins' }); return; }
    p.coins -= cost;

    p.avatars.push(avatarId); p.updatedAt = Date.now(); savePlayers();
    if (cb) cb({ profile: publicProfile(userId) });
  });
  socket.on('setActiveAvatar', async ({ userId, avatarId }, cb) => {
    await playersReady;
    if (!userId) { if (cb) cb({ error: 'no_user' }); return; }
    const p = ensureProfile(userId);
    if (!p.avatars.includes(avatarId)) { if (cb) cb({ error: 'not_owned' }); return; }
    p.activeAvatar = avatarId; p.updatedAt = Date.now(); savePlayers();
    if (cb) cb({ profile: publicProfile(userId) });
  });
  socket.on('setActiveTitle', async ({ userId, titleId }, cb) => {
    await playersReady;
    if (!userId) { if (cb) cb({ error: 'no_user' }); return; }
    const p = ensureProfile(userId);
    if (!p.titles.includes(titleId)) { if (cb) cb({ error: 'not_owned' }); return; }
    p.activeTitle = titleId; p.updatedAt = Date.now(); savePlayers();
    if (cb) cb({ profile: publicProfile(userId) });
  });
  // ---- SOLO GAME SESSION (античит) ----
  socket.on('startSoloGame', async ({ userId, mode }, cb) => {
    await playersReady;
    if (!userId) { if (cb) cb({ error: 'no_user' }); return; }
    const sessionId = 'gs_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    gameSessions.set(sessionId, {
      userId,
      mode: mode || 'classic',
      startedAt: Date.now()
    });
    // Чистим старые сессии раз в 100 созданий
    if (gameSessions.size > 500) {
      const cutoff = Date.now() - 3600 * 1000;
      const arr = Array.from(gameSessions.entries());
      for (let i = 0; i < arr.length; i++) {
        if (arr[i][1].startedAt < cutoff) gameSessions.delete(arr[i][0]);
      }
    }
    if (cb) cb({ sessionId });
  });
  socket.on('getAchievements', async ({ userId }, cb) => {
    await playersReady;
    const p = players[userId];
    if (!p) { if (cb) cb({ list: ACHIEVEMENT_DEFS, unlocked: [] }); return; }
    if (cb) cb({ list: ACHIEVEMENT_DEFS, unlocked: (p.achievements || []).slice() });
  });
  socket.on('getQuests', async ({ userId }, cb) => {
    await playersReady;
    if (!userId) { if (cb) cb({ error: 'no_user' }); return; }
    const dq = getOrCreateDailyQuests(userId);
    if (cb) cb(dq);
  });
  socket.on('claimQuest', async ({ userId, questId }, cb) => {
    await playersReady;
    if (!userId || !questId) { if (cb) cb({ error: 'bad_input' }); return; }
    const p = players[userId];
    if (!p) { if (cb) cb({ error: 'no_user' }); return; }
    const dq = p.dailyQuests;
    if (!dq || dq.date !== todayStr()) { if (cb) cb({ error: 'no_quests' }); return; }
    const q = dq.quests.find(x => x.id === questId);
    if (!q) { if (cb) cb({ error: 'not_found' }); return; }
    if (q.claimed) { if (cb) cb({ error: 'already_claimed' }); return; }
    if (q.progress < q.target) { if (cb) cb({ error: 'not_complete' }); return; }
    q.claimed = true;
    p.coins = (p.coins || 0) + q.reward;
    p.updatedAt = Date.now();
    checkAchievements(userId, {});
    savePlayers();
    if (cb) cb({ ok: true, reward: q.reward, profile: publicProfile(userId), quests: dq });
  });

  // ---- SOLO (с режимами) ----
  socket.on('submitSoloResult', async ({ userId, score, maxCombo, linesCleared, mode, sessionId }, cb) => {
    await playersReady;
    if (!userId) { if (cb) cb({ error: 'no_user' }); return; }

    // === АНТИЧИТ ===
    const session = gameSessions.get(sessionId);
    if (!session) {
      if (cb) cb({ error: 'invalid_session' });
      return;
    }
    if (session.userId !== userId) {
      gameSessions.delete(sessionId);
      if (cb) cb({ error: 'session_mismatch' });
      return;
    }
    const elapsedMs = Date.now() - session.startedAt;
    const elapsedSec = elapsedMs / 1000;
    gameSessions.delete(sessionId);

    if (elapsedSec < 3) {
      if (cb) cb({ error: 'too_fast' });
      return;
    }
    if (elapsedSec > 3600) {
      if (cb) cb({ error: 'session_expired' });
      return;
    }
    const maxAllowed = Math.floor(elapsedSec * 100);
    if (score > maxAllowed) {
      console.warn(`Anti-cheat: ${userId} tried score=${score} in ${elapsedSec}s (max=${maxAllowed})`);
      if (cb) cb({ error: 'score_too_high' });
      return;
    }

    const p = ensureProfile(userId);
    const now = Date.now();
    if (p.lastGameAt && now - p.lastGameAt < 5000) {
      if (cb) cb({ error: 'too_frequent' });
      return;
    }
    p.lastGameAt = now;
    // === КОНЕЦ АНТИЧИТА ===
    mode = mode || 'classic';
    score = clamp(score, 0, MAX_SOLO_SCORE);
    maxCombo = clamp(maxCombo || 0, 0, 100);
    linesCleared = clamp(linesCleared || 0, 0, 10000);

    let ratingMult = 1.0, coinMult = 1.0;
    if (mode === 'speedrun') { ratingMult = 0.7; coinMult = 1.2; }
    else if (mode === 'zen') { ratingMult = 0; coinMult = 1.0; }
    else if (mode === 'puzzle') {
      ratingMult = 1.0; coinMult = 1.5;
      // Только раз в день
      const today = todayStr();
      if (p.puzzleLastDate === today) { if (cb) cb({ error: 'puzzle_already_played' }); return; }
      p.puzzleLastDate = today;
      if (score > (p.puzzleBest || 0)) p.puzzleBest = score;
    }

    const gain = Math.min(MAX_SOLO_GAIN, Math.floor((score / 8) * ratingMult));
    const coinsGain = Math.floor((score / SOLO_COIN_DIVISOR) * coinMult);

    const prevRank = getRank(p.rating);
    p.rating += gain;
    p.coins = (p.coins || 0) + coinsGain;
    p.soloGames = (p.soloGames || 0) + 1;
    p.stats.soloGames = (p.stats.soloGames || 0) + 1;
    p.stats.totalLines = (p.stats.totalLines || 0) + linesCleared;
    if (maxCombo > (p.stats.maxCombo || 0)) p.stats.maxCombo = maxCombo;
    p.updatedAt = Date.now();
    if (score > p.bestScore) p.bestScore = score;
    stats.totalGamesSolo++;
    stats.totalScoreSolo += score;
    if (score > stats.maxScoreSolo) stats.maxScoreSolo = score;
    trackGamesBucket(p.stats.soloGames || 0);
    saveStats();

    updateQuestProgress(userId, 'play_solo', 1);
    if (linesCleared > 0) updateQuestProgress(userId, 'lines', linesCleared);
    if (maxCombo > 0) updateQuestProgress(userId, 'combo', maxCombo);
    if (score > 0) updateQuestProgress(userId, 'score_solo', score);
    checkAchievements(userId, { gamePlayed: true, soloScore: score, maxCombo });

    const refResult = grantReferralIfNeeded(userId);
    let refBonus = 0;
    if (refResult) refBonus = refResult.bonus;

    savePlayers();
    const newRank = getRank(p.rating);
    const rankUp = newRank.name !== prevRank.name;
    if (cb) cb({ profile: publicProfile(userId), gain, coinsGain, refBonus, mode, rankUp: rankUp ? newRank : null });
  });

  socket.on('getLeaderboard', ({ userId, type }, cb) => {
    try { if (cb) cb(buildLeaderboard(type, userId)); }
    catch (e) { if (cb) cb({ list: [], myPosition: null, total: 0, type }); }
  });

  // ---- TOURNAMENT ----
  socket.on('tournamentStatus', async ({ userId }, cb) => {
    await playersReady;
    ensureTournament();
    if (cb) cb({ tournament: getTournamentForClient() });
  });

  socket.on('tournamentRegister', async ({ userId }, cb) => {
    await playersReady;
    ensureTournament();
    if (!userId) { if (cb) cb({ error: 'no_user' }); return; }
    const result = registerForTournament(userId);
    if (result.error) { if (cb) cb(result); return; }
    // Оповещаем всех зарегистрированных + показываем новичка
    for (const entry of tournament.players) {
      const o = online.get(entry.userId);
      if (o && o.socket) o.socket.emit('tournamentUpdated', { tournament: getTournamentForClient() });
    }
    if (cb) cb({ ok: true, profile: publicProfile(userId), tournament: getTournamentForClient() });
  });

  socket.on('tournamentUnregister', async ({ userId }, cb) => {
    await playersReady;
    ensureTournament();
    if (!userId) { if (cb) cb({ error: 'no_user' }); return; }
    const result = unregisterFromTournament(userId);
    if (result.error) { if (cb) cb(result); return; }
    for (const entry of tournament.players) {
      const o = online.get(entry.userId);
      if (o && o.socket) o.socket.emit('tournamentUpdated', { tournament: getTournamentForClient() });
    }
    if (cb) cb({ ok: true, profile: publicProfile(userId), tournament: getTournamentForClient() });
  });

  // ============ FRIENDS ============
  socket.on('findPlayer', async ({ userId, query }, cb) => {
    await playersReady;
    if (!userId || !query) { if (cb) cb({ error: 'bad_input' }); return; }
    query = String(query).trim().toLowerCase();
    if (query.length < 2) { if (cb) cb({ error: 'too_short' }); return; }
    const me = players[userId];
    const myFriends = me ? (me.friends || []) : [];
    const results = [];
    for (const uid of Object.keys(players)) {
      if (uid === userId) continue;
      const p = players[uid];
      if (uid.toLowerCase().includes(query) || p.name.toLowerCase().includes(query)) {
        results.push({
          userId: uid, name: p.name, rating: p.rating,
          rank: getRank(p.rating), activeAvatar: p.activeAvatar || 0,
          isOnline: online.has(uid), isFriend: myFriends.includes(uid)
        });
        if (results.length >= 10) break;
      }
    }
    if (cb) cb({ results });
  });
  socket.on('sendFriendRequest', async ({ userId, targetId }, cb) => {
    await playersReady;
    if (!userId || !targetId || userId === targetId) { if (cb) cb({ error: 'bad_input' }); return; }
    const me = players[userId]; const target = players[targetId];
    if (!me || !target) { if (cb) cb({ error: 'not_found' }); return; }
    if (me.friends.includes(targetId)) { if (cb) cb({ error: 'already_friends' }); return; }
    if (target.friendRequests.includes(userId)) { if (cb) cb({ ok: true }); return; }
    target.friendRequests.push(userId);
    target.updatedAt = Date.now(); savePlayers();
    const targetO = online.get(targetId);
    if (targetO && targetO.socket) targetO.socket.emit('friendRequestReceived', { fromId: userId, fromName: me.name });
    if (cb) cb({ ok: true });
  });
  socket.on('acceptFriendRequest', async ({ userId, fromId }, cb) => {
    await playersReady;
    if (!userId || !fromId) { if (cb) cb({ error: 'bad_input' }); return; }
    const me = players[userId]; const from = players[fromId];
    if (!me || !from) { if (cb) cb({ error: 'not_found' }); return; }
    me.friendRequests = me.friendRequests.filter(id => id !== fromId);
    if (!me.friends.includes(fromId)) me.friends.push(fromId);
    if (!from.friends.includes(userId)) from.friends.push(userId);
    me.updatedAt = Date.now(); from.updatedAt = Date.now();
    unlockAchievement(userId, 'friend');
    unlockAchievement(fromId, 'friend');
    savePlayers();
    const fromO = online.get(fromId);
    if (fromO && fromO.socket) fromO.socket.emit('friendRequestAccepted', { byId: userId, byName: me.name });
    if (cb) cb({ ok: true });
  });
  socket.on('declineFriendRequest', async ({ userId, fromId }, cb) => {
    await playersReady;
    const me = players[userId]; if (!me) { if (cb) cb({ error: 'not_found' }); return; }
    me.friendRequests = me.friendRequests.filter(id => id !== fromId);
    me.updatedAt = Date.now(); savePlayers();
    if (cb) cb({ ok: true });
  });
  socket.on('removeFriend', async ({ userId, friendId }, cb) => {
    await playersReady;
    const me = players[userId]; const friend = players[friendId];
    if (me) { me.friends = me.friends.filter(id => id !== friendId); me.updatedAt = Date.now(); }
    if (friend) { friend.friends = friend.friends.filter(id => id !== userId); friend.updatedAt = Date.now(); }
    savePlayers();
    if (cb) cb({ ok: true });
  });
  socket.on('getFriends', async ({ userId }, cb) => {
    await playersReady;
    const me = players[userId];
    if (!me) { if (cb) cb({ error: 'not_found' }); return; }
    const friends = (me.friends || []).map(fid => {
      const f = players[fid]; if (!f) return null;
      return {
        userId: fid, name: f.name, rating: f.rating,
        rank: getRank(f.rating), isOnline: online.has(fid),
        activeAvatar: f.activeAvatar || 0
      };
    }).filter(Boolean);
    const requests = (me.friendRequests || []).map(fid => {
      const f = players[fid]; if (!f) return null;
      return { userId: fid, name: f.name, rating: f.rating, rank: getRank(f.rating), activeAvatar: f.activeAvatar || 0 };
    }).filter(Boolean);
    if (cb) cb({ friends, requests });
  });
  socket.on('inviteFriendToMatch', async ({ userId, friendId }, cb) => {
    await playersReady;
    const me = players[userId]; const friend = players[friendId];
    if (!me || !friend) { if (cb) cb({ error: 'not_found' }); return; }
    if (!me.friends.includes(friendId)) { if (cb) cb({ error: 'not_friends' }); return; }
    const friendO = online.get(friendId);
    if (!friendO || !friendO.socket) { if (cb) cb({ error: 'offline' }); return; }
    friendO.socket.emit('matchInviteReceived', { fromId: userId, fromName: me.name, fromRating: me.rating });
    if (cb) cb({ ok: true });
  });
  socket.on('acceptMatchInvite', async ({ userId, fromId }) => {
    await playersReady;
    const fromO = online.get(fromId);
    if (!fromO || !fromO.socket) return;
    let myO = online.get(userId);
    if (!myO) { myO = { socket, opponentId: null, roomId: null, disconnectTimer: null, score: 0 }; online.set(userId, myO); }
    else { if (myO.disconnectTimer) { clearTimeout(myO.disconnectTimer); myO.disconnectTimer = null; } myO.socket = socket; }
    if (myO.roomId || fromO.roomId) return;
    startMatch(fromId, userId, fromO.socket, socket);
  });
  socket.on('declineMatchInvite', ({ userId, fromId }, cb) => {
    const fromO = online.get(fromId);
    if (fromO && fromO.socket) fromO.socket.emit('matchInviteDeclined', { byId: userId });
    if (cb) cb({ ok: true });
  });

  // ---- EMOTE ----
  socket.on('emote', ({ emoji }) => {
    const userId = socket.data.userId;
    if (!userId) return;
    if (EMOTE_LIST.indexOf(emoji) === -1) return;
    const o = online.get(userId);
    if (!o) return;
    const now = Date.now();
    if (o.lastEmoteAt && now - o.lastEmoteAt < EMOTE_COOLDOWN) return;
    o.lastEmoteAt = now;
    if (o.opponentId) {
      const opp = online.get(o.opponentId);
      if (opp && opp.socket) opp.socket.emit('oppEmote', { emoji });
    }
    stats.totalEmotes = (stats.totalEmotes || 0) + 1;
    saveStats();
    const p = players[userId];
    if (p) {
      p.emoteCount = (p.emoteCount || 0) + 1;
      if (p.emoteCount === 100) {
        checkAchievements(userId, {});
      }
    }
  });

  // ---- GAME ----
  socket.on('register', async ({ userId, wasInGame }) => {
    await playersReady;
    if (!userId) return;
    socket.data.userId = userId;
    ensureProfile(userId);
    const wasOnline = online.has(userId) && online.get(userId).socket;
    let o = online.get(userId);
    if (!o) { o = { socket, opponentId: null, roomId: null, disconnectTimer: null, score: 0 }; online.set(userId, o); }
    else { if (o.disconnectTimer) { clearTimeout(o.disconnectTimer); o.disconnectTimer = null; } o.socket = socket; }
    if (!wasOnline) {
      const myFriends = players[userId].friends || [];
      for (const fid of myFriends) {
        const fO = online.get(fid);
        if (fO && fO.socket) fO.socket.emit('friendOnline', { userId, name: players[userId].name });
      }
    }
    if (o.roomId && o.opponentId && online.has(o.opponentId)) {
      socket.join(o.roomId);
      const opp = online.get(o.opponentId);
      socket.emit('matchRestored', { oppScore: opp ? opp.score : 0 });
      if (opp && opp.socket) opp.socket.emit('oppReconnected');
    } else if (wasInGame) socket.emit('noGame');
  });

  socket.on('findMatch', async () => {
    await playersReady;
    const userId = socket.data.userId;
    if (!userId) return;
    ensureProfile(userId);
    let o = online.get(userId);
    if (!o) { o = { socket, opponentId: null, roomId: null, disconnectTimer: null, score: 0 }; online.set(userId, o); }
    if (o.roomId && o.opponentId) {
      const opp = online.get(o.opponentId);
      socket.emit('matchRestored', { oppScore: opp ? opp.score : 0 });
      return;
    }
    const idx = waiting.indexOf(socket);
    if (idx >= 0) waiting.splice(idx, 1);
    if (waiting.length > 0) {
      const oppSocket = waiting.shift();
      const oppUserId = oppSocket.data.userId;
      const oppO = oppUserId ? online.get(oppUserId) : null;
      if (!oppO || !oppSocket.connected || !oppUserId) { waiting.push(socket); socket.emit('waiting'); return; }
      startMatch(userId, oppUserId, socket, oppSocket);
    } else { waiting.push(socket); socket.emit('waiting'); }
  });

  socket.on('createRoom', async ({ userId }, cb) => {
    await playersReady;
    if (!userId) { if (cb) cb({ error: 'no_user' }); return; }
    ensureProfile(userId);
    socket.data.userId = userId;
    let o = online.get(userId);
    if (!o) { o = { socket, opponentId: null, roomId: null, disconnectTimer: null, score: 0 }; online.set(userId, o); }
    else { if (o.disconnectTimer) { clearTimeout(o.disconnectTimer); o.disconnectTimer = null; } o.socket = socket; }
    for (const [c, r] of customRooms) if (r.hostId === userId) customRooms.delete(c);
    let code, attempts = 0;
    do { code = genRoomCode(); attempts++; } while (customRooms.has(code) && attempts < 10);
    if (customRooms.has(code)) { if (cb) cb({ error: 'retry' }); return; }
    customRooms.set(code, { hostId: userId, createdAt: Date.now() });
    socket.data.hostedRoomCode = code;
    if (cb) cb({ code });
  });
  socket.on('cancelRoom', () => {
    const code = socket.data.hostedRoomCode;
    if (code && customRooms.has(code)) customRooms.delete(code);
    socket.data.hostedRoomCode = null;
  });
  socket.on('joinRoom', async ({ userId, code }, cb) => {
    await playersReady;
    if (!userId || !code) { if (cb) cb({ error: 'bad_input' }); return; }
    code = String(code).toUpperCase().trim();
    ensureProfile(userId);
    socket.data.userId = userId;
    const room = customRooms.get(code);
    if (!room) { if (cb) cb({ error: 'not_found' }); return; }
    if (room.hostId === userId) { if (cb) cb({ error: 'self' }); return; }
    const hostO = online.get(room.hostId);
    if (!hostO || !hostO.socket || !hostO.socket.connected) { if (cb) cb({ error: 'host_offline' }); return; }
    let guestO = online.get(userId);
    if (!guestO) { guestO = { socket, opponentId: null, roomId: null, disconnectTimer: null, score: 0 }; online.set(userId, guestO); }
    else { if (guestO.disconnectTimer) { clearTimeout(guestO.disconnectTimer); guestO.disconnectTimer = null; } guestO.socket = socket; }
    const ok = startMatch(room.hostId, userId, hostO.socket, socket);
    if (!ok) { if (cb) cb({ error: 'match_failed' }); return; }
    customRooms.delete(code);
    if (cb) cb({ ok: true });
  });

  socket.on('progress', ({ score }) => {
    const userId = socket.data.userId; if (!userId) return;
    const o = online.get(userId); if (!o) return;
    o.score = score | 0;
    if (o.opponentId) {
      const opp = online.get(o.opponentId);
      if (opp && opp.socket) opp.socket.emit('oppProgress', { score: o.score });
    }
  });

  socket.on('gameOver', async () => {
    await playersReady;
    const loserId = socket.data.userId;
    if (!loserId) return;
    const o = online.get(loserId);
    if (!o) return;
    const winnerId = o.opponentId;

    // Турнирный матч?
    if (o.matchType === 'tournament' && o.tournamentMatchId && winnerId) {
      const prevRoom = o.roomId;
      if (prevRoom) socket.leave(prevRoom);
      o.opponentId = null; o.roomId = null; o.matchType = 'duel'; o.tournamentMatchId = null;
      const winnerO = online.get(winnerId);
      if (winnerO) { winnerO.opponentId = null; winnerO.roomId = null; winnerO.matchType = 'duel'; winnerO.tournamentMatchId = null; }
      const loserSocket = socket;
      const winnerSocket = winnerO ? winnerO.socket : null;
      if (winnerSocket) winnerSocket.emit('youWon', { tournament: true });
      loserSocket.emit('youLost', { tournament: true });
      advanceTournament(loserId, winnerId);
      return;
    }

    let winnerDelta = 0, loserDelta = 0, winnerCoins = 0, loserCoins = 0;
    let winnerNewRating = null, loserNewRating = null;

    if (winnerId && players[winnerId] && players[loserId]) {
      const winner = players[winnerId];
      const loser = players[loserId];
      winnerDelta = calcDuelDelta(winner.rating, loser.rating, true);
      loserDelta = calcDuelDelta(loser.rating, winner.rating, false);
      winner.rating += winnerDelta;
      winner.duelWins = (winner.duelWins || 0) + 1;
      winner.duelWinStreak = (winner.duelWinStreak || 0) + 1;
      if (winner.duelWinStreak > (winner.duelBestWinStreak || 0)) winner.duelBestWinStreak = winner.duelWinStreak;
      winner.stats.duelWins = (winner.stats.duelWins || 0) + 1;
      winner.stats.duelGames = (winner.stats.duelGames || 0) + 1;
      winner.coins = (winner.coins || 0) + DUEL_WIN_COINS;
      winnerCoins = DUEL_WIN_COINS;
      winner.updatedAt = Date.now();
      winnerNewRating = winner.rating;
      loser.rating = Math.max(0, loser.rating - loserDelta);
      loser.duelWinStreak = 0;
      loser.duelLosses = (loser.duelLosses || 0) + 1;
      loser.stats.duelGames = (loser.stats.duelGames || 0) + 1;
      loser.coins = (loser.coins || 0) + DUEL_LOSS_COINS;
      loserCoins = DUEL_LOSS_COINS;
      loser.updatedAt = Date.now();
      loserNewRating = loser.rating;

      updateQuestProgress(winnerId, 'play_duel', 1);
      updateQuestProgress(winnerId, 'win_duel', 1);
      updateQuestProgress(loserId, 'play_duel', 1);
      checkAchievements(winnerId, { gamePlayed: true });
      // Разгром: победитель набрал на 500+ больше
      const winnerO = online.get(winnerId);
      const loserO = online.get(loserId);
      const wScore = winnerO ? (winnerO.score || 0) : 0;
      const lScore = loserO ? (loserO.score || 0) : 0;
      if (wScore - lScore >= 500) unlockAchievement(winnerId, 'domination');
      checkAchievements(loserId, { gamePlayed: true });
      grantReferralIfNeeded(winnerId);
      grantReferralIfNeeded(loserId);
      savePlayers();
      stats.totalGamesDuel++;
      saveStats();
    }

    const opp = winnerId ? online.get(winnerId) : null;
    if (opp && opp.socket) {
      opp.socket.emit('youWon', { ratingDelta: winnerDelta, newRating: winnerNewRating, coinsGained: winnerCoins });
      opp.opponentId = null; opp.roomId = null; opp.matchType = 'duel'; opp.tournamentMatchId = null;
    }
    socket.emit('youLost', { ratingDelta: -loserDelta, newRating: loserNewRating, coinsGained: loserCoins });
    o.opponentId = null; o.roomId = null; o.matchType = 'duel'; o.tournamentMatchId = null;
  });

  socket.on('leaveGame', () => {
    const userId = socket.data.userId; if (!userId) return;
    const o = online.get(userId); if (!o) return;
    if (o.roomId) socket.leave(o.roomId);
    if (o.opponentId) {
      const opp = online.get(o.opponentId);
      if (opp && opp.socket) { opp.socket.emit('oppLeft'); opp.opponentId = null; opp.roomId = null; opp.matchType = 'duel'; opp.tournamentMatchId = null; }
    }
    o.opponentId = null; o.roomId = null; o.matchType = 'duel'; o.tournamentMatchId = null;
  });

  socket.on('disconnect', () => {
    const userId = socket.data.userId;
    if (userId) {
      const o = online.get(userId);
      if (o && o.socket === socket) {
        o.socket = null;
        const idx = waiting.indexOf(socket);
        if (idx >= 0) waiting.splice(idx, 1);
        o.disconnectTimer = setTimeout(() => {
          const p = players[userId];
          if (p && Array.isArray(p.friends)) {
            for (const fid of p.friends) {
              const fO = online.get(fid);
              if (fO && fO.socket) fO.socket.emit('friendOffline', { userId });
            }
          }
          cleanupOnline(userId);
        }, GRACE_PERIOD);
      }
    }
    const code = socket.data.hostedRoomCode;
    if (code && customRooms.has(code)) customRooms.delete(code);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Block Blast Duel v9 on http://localhost:' + PORT));
