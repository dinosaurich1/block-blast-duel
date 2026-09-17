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
let players = {};
let playersLoaded = false;

const playersReady = (async () => {
  try {
    const data = await redis.get(PLAYERS_KEY);
    let parsed = data;
    if (typeof data === 'string') { try { parsed = JSON.parse(data); } catch (e) { parsed = null; } }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      players = parsed;
      for (const uid of Object.keys(players)) {
        const p = players[uid];
        if (typeof p !== 'object' || p === null) { delete players[uid]; continue; }
        migrateProfile(p, uid);
      }
      console.log('Loaded ' + Object.keys(players).length + ' profiles');
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

// ============ SEASONS ============
function getOrthodoxEaster(year) {
  const a = year % 4;
  const b = year % 7;
  const c = year % 19;
  const d = (19 * c + 15) % 30;
  const e = (2 * a + 4 * b - d + 34) % 7;
  const month = Math.floor((d + e + 114) / 31);
  const day = ((d + e + 114) % 31) + 1;
  const dt = new Date(year, month - 1, day);
  dt.setDate(dt.getDate() + 13);
  return dt;
}
function getSeasonalWindows() {
  const now = new Date();
  const y = now.getFullYear();
  const w = [];
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
  const now = new Date();
  const activeSet = new Set();
  let menuTheme = 'default';
  for (const w of getSeasonalWindows()) {
    if (now >= w.start && now <= w.end) {
      w.skins.forEach(s => activeSet.add(s));
      menuTheme = w.id;
    }
  }
  return { skins: Array.from(activeSet), menuTheme: menuTheme };
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
  { id: 'referral_1', name: 'Друг друга', desc: 'Пригласить друга по ссылке', icon: '🤝', coins: 100 }
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
const waiting = [];
const customRooms = new Map();
const ri = (n) => Math.floor(Math.random() * n);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v | 0));

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
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
}

function applyReferral(newUserId, referrerId) {
  if (!newUserId || !referrerId) return;
  if (newUserId === referrerId) return;
  const newP = players[newUserId];
  const refP = players[referrerId];
  if (!newP || !refP) return;
  if (newP.referredBy) return;
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
  if (refO && refO.socket) {
    refO.socket.emit('referralRewarded', { bonus: REFERRAL_REWARD, fromName: p.name, count: refP.referralCount });
  }
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
  p.dailyQuests = { date: today, quests: quests };
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

function startMatch(hostId, guestId, hostSocket, guestSocket) {
  const hostO = online.get(hostId);
  const guestO = online.get(guestId);
  if (!hostO || !guestO) return false;
  const roomId = 'room_' + hostId + '_' + Date.now();
  hostSocket.join(roomId); guestSocket.join(roomId);
  hostO.roomId = roomId; hostO.opponentId = guestId; hostO.score = 0;
  guestO.roomId = roomId; guestO.opponentId = hostId; guestO.score = 0;
  const sequence = genSequence(300);
  hostSocket.emit('matchFound', {
    sequence, playerIndex: 0,
    oppName: players[guestId] ? players[guestId].name : 'Соперник',
    oppRating: players[guestId] ? players[guestId].rating : 0,
    oppAvatar: players[guestId] ? players[guestId].activeAvatar || 0 : 0
  });
  guestSocket.emit('matchFound', {
    sequence, playerIndex: 1,
    oppName: players[hostId] ? players[hostId].name : 'Соперник',
    oppRating: players[hostId] ? players[hostId].rating : 0,
    oppAvatar: players[hostId] ? players[hostId].activeAvatar || 0 : 0
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
app.get('/health', (req, res) => {
  res.status(200).json({
    ok: true, uptime: Math.floor(process.uptime()),
    players: Object.keys(players).length,
    online: online.size, rooms: customRooms.size,
    redisLoaded: playersLoaded,
    season: getActiveSeasonal()
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
        duelWins: 0, duelLosses: 0, soloGames: 0,
        updatedAt: Date.now()
      };
      players[userId] = p;
      if (ref && typeof ref === 'string' && ref !== userId) {
        applyReferral(userId, ref);
      }
    } else if (incomingName && incomingName !== p.name) {
      p.name = incomingName; p.updatedAt = Date.now();
    }
    migrateProfile(p, userId);
    getOrCreateDailyQuests(userId);
    savePlayers();
    socket.data.userId = userId;
    if (cb) cb({ profile: publicProfile(userId), isNew: isNew, season: getActiveSeasonal() });
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
    p.coins -= cost; p.backgrounds.push(bgId); p.updatedAt = Date.now(); savePlayers();
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
    p.coins -= cost; p.avatars.push(avatarId); p.updatedAt = Date.now(); savePlayers();
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

  socket.on('submitSoloResult', async ({ userId, score, maxCombo, linesCleared }, cb) => {
    await playersReady;
    if (!userId) { if (cb) cb({ error: 'no_user' }); return; }
    const p = ensureProfile(userId);
    score = clamp(score, 0, MAX_SOLO_SCORE);
    maxCombo = clamp(maxCombo || 0, 0, 100);
    linesCleared = clamp(linesCleared || 0, 0, 10000);
    const gain = Math.min(MAX_SOLO_GAIN, Math.floor(score / 8));
    const coinsGain = Math.floor(score / SOLO_COIN_DIVISOR);

    const prevRank = getRank(p.rating);
    p.rating += gain;
    p.coins = (p.coins || 0) + coinsGain;
    p.soloGames = (p.soloGames || 0) + 1;
    p.stats.soloGames = (p.stats.soloGames || 0) + 1;
    p.stats.totalLines = (p.stats.totalLines || 0) + linesCleared;
    if (maxCombo > (p.stats.maxCombo || 0)) p.stats.maxCombo = maxCombo;
    p.updatedAt = Date.now();
    if (score > p.bestScore) p.bestScore = score;

    updateQuestProgress(userId, 'play_solo', 1);
    if (linesCleared > 0) updateQuestProgress(userId, 'lines', linesCleared);
    if (maxCombo > 0) updateQuestProgress(userId, 'combo', maxCombo);
    if (score > 0) updateQuestProgress(userId, 'score_solo', score);
    checkAchievements(userId, { gamePlayed: true, soloScore: score, maxCombo: maxCombo });

    const refResult = grantReferralIfNeeded(userId);
    let refBonus = 0;
    if (refResult) refBonus = refResult.bonus;

    savePlayers();
    const newRank = getRank(p.rating);
    const rankUp = newRank.name !== prevRank.name;
    if (cb) cb({ profile: publicProfile(userId), gain, coinsGain, refBonus, rankUp: rankUp ? newRank : null });
  });

  socket.on('getLeaderboard', ({ userId, type }, cb) => {
    try { if (cb) cb(buildLeaderboard(type, userId)); }
    catch (e) { if (cb) cb({ list: [], myPosition: null, total: 0, type }); }
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
      if (opp && opp.socket) {
        opp.socket.emit('oppEmote', { emoji: emoji });
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

    let winnerDelta = 0, loserDelta = 0, winnerCoins = 0, loserCoins = 0;
    let winnerNewRating = null, loserNewRating = null;

    if (winnerId && players[winnerId] && players[loserId]) {
      const winner = players[winnerId];
      const loser = players[loserId];
      winnerDelta = calcDuelDelta(winner.rating, loser.rating, true);
      loserDelta = calcDuelDelta(loser.rating, winner.rating, false);
      winner.rating += winnerDelta;
      winner.duelWins = (winner.duelWins || 0) + 1;
      winner.stats.duelWins = (winner.stats.duelWins || 0) + 1;
      winner.stats.duelGames = (winner.stats.duelGames || 0) + 1;
      winner.coins = (winner.coins || 0) + DUEL_WIN_COINS;
      winnerCoins = DUEL_WIN_COINS;
      winner.updatedAt = Date.now();
      winnerNewRating = winner.rating;
      loser.rating = Math.max(0, loser.rating - loserDelta);
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
      checkAchievements(loserId, { gamePlayed: true });

      grantReferralIfNeeded(winnerId);
      grantReferralIfNeeded(loserId);
      savePlayers();
    }

    const opp = winnerId ? online.get(winnerId) : null;
    if (opp && opp.socket) {
      opp.socket.emit('youWon', { ratingDelta: winnerDelta, newRating: winnerNewRating, coinsGained: winnerCoins });
      opp.opponentId = null; opp.roomId = null;
    }
    socket.emit('youLost', { ratingDelta: -loserDelta, newRating: loserNewRating, coinsGained: loserCoins });
    o.opponentId = null; o.roomId = null;
  });

  socket.on('leaveGame', () => {
    const userId = socket.data.userId; if (!userId) return;
    const o = online.get(userId); if (!o) return;
    if (o.roomId) socket.leave(o.roomId);
    if (o.opponentId) {
      const opp = online.get(o.opponentId);
      if (opp && opp.socket) { opp.socket.emit('oppLeft'); opp.opponentId = null; opp.roomId = null; }
    }
    o.opponentId = null; o.roomId = null;
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
server.listen(PORT, () => console.log('Block Blast Duel v8 on http://localhost:' + PORT));
