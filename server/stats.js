// 战绩统计 + 成就判定
// 设计原则：
//   1) 只做累加，不做业务判断 —— 所有 hook 都是「记账」，不改变游戏逻辑
//   2) 成就只在这里判定，world.js 只负责调用
//   3) 所有入口都对 isDecoy / 缺失档案做了防御，绝不让统计失败影响对局
'use strict';
const { ACHIEVEMENTS } = require('./config');

/** 按点号路径取值：'kills' / 'st.dmgDealt' / 'st.wpKills.sniper' */
function pick(obj, path) {
  let cur = obj;
  for (const seg of String(path).split('.')) {
    if (cur == null) return 0;
    cur = cur[seg];
  }
  const n = Number(cur);
  return Number.isFinite(n) ? n : 0;
}

/** 取得（必要时初始化）玩家档案里的统计对象 */
function statsOf(prof) {
  if (!prof.st || typeof prof.st !== 'object') {
    prof.st = {
      dmgDealt: 0, dmgTaken: 0, shotsFired: 0, shotsHit: 0, headshots: 0, crits: 0,
      meleeKills: 0, gunKills: 0, nadeKills: 0, longestKill: 0, streakMax: 0,
      playMs: 0, deathsByBoss: 0, witherKills: 0, wpKills: {},
    };
  }
  if (!prof.st.wpKills || typeof prof.st.wpKills !== 'object') prof.st.wpKills = {};
  return prof.st;
}

/**
 * 检查并解锁成就。
 * @returns {Array} 本次新解锁的成就定义数组（可能为空）
 */
function checkAchievements(prof) {
  if (!prof) return [];
  if (!Array.isArray(prof.ach)) prof.ach = [];
  const unlocked = [];
  for (const a of ACHIEVEMENTS) {
    if (prof.ach.includes(a.id)) continue;
    if (pick(prof, a.stat) >= a.goal) {
      prof.ach.push(a.id);
      if (a.reward > 0) prof.coins = (prof.coins || 0) + a.reward;
      unlocked.push(a);
    }
  }
  return unlocked;
}

/** 把新解锁的成就推给玩家（socket 由调用方提供） */
function announce(world, playerId, list) {
  if (!list || !list.length) return;
  for (const a of list) {
    world.sendTo(playerId, {
      type: 'ach',
      id: a.id, name: a.name, desc: a.desc, icon: a.icon, reward: a.reward,
    });
    world.broadcast({
      type: 'sys', style: 'ach',
      text: `${a.icon} 成就解锁「${a.name}」${a.reward > 0 ? ` +${a.reward} 金币` : ''}`,
    });
  }
}

// ---------- 记账入口（全部由 world.js 调用）----------

/** 造成伤害 */
function onDamageDealt(prof, dmg, opts = {}) {
  if (!prof || dmg <= 0) return;
  const st = statsOf(prof);
  st.dmgDealt += dmg;
  if (opts.crit) st.crits++;
  if (opts.hs) st.headshots++;
}

/** 承受伤害 */
function onDamageTaken(prof, dmg) {
  if (!prof || dmg <= 0) return;
  statsOf(prof).dmgTaken += dmg;
}

/** 开了一枪（散弹枪算 1 次射击） */
function onShotFired(prof) {
  if (!prof) return;
  statsOf(prof).shotsFired++;
}

/** 这一枪命中了至少一个目标 */
function onShotHit(prof) {
  if (!prof) return;
  statsOf(prof).shotsHit++;
}

/**
 * 击杀结算。
 * @param prof    击杀者档案
 * @param wp      武器 id
 * @param dist    击杀距离（米），未知传 0
 * @param opts    { melee, shutdown } shutdown = 被击杀者当时的连杀数
 */
function onKill(prof, wp, dist, opts = {}) {
  if (!prof) return;
  const st = statsOf(prof);
  if (opts.melee) st.meleeKills++;
  else if (wp === 'nade' || wp === 'barrel') st.nadeKills++;
  else st.gunKills++;
  if (wp) st.wpKills[wp] = (st.wpKills[wp] || 0) + 1;
  if (dist > st.longestKill) st.longestKill = Math.round(dist);
  if (opts.shutdown) st.witherKills++;
}

/** 连杀数刷新 */
function onStreak(prof, streak) {
  if (!prof) return;
  const st = statsOf(prof);
  if (streak > st.streakMax) st.streakMax = streak;
}

/** 被 BOSS 击杀 */
function onDeathByBoss(prof) {
  if (!prof) return;
  statsOf(prof).deathsByBoss++;
}

/** 本次会话时长（在玩家离开时结算） */
function onSessionEnd(prof, ms) {
  if (!prof || !(ms > 0)) return;
  statsOf(prof).playMs += Math.min(ms, 24 * 3600 * 1000); // 上限 24h，防挂机刷
}

// ---------- 对外展示 ----------

/** 汇总给客户端的战绩数据 */
function summary(prof) {
  if (!prof) return null;
  const st = statsOf(prof);
  const acc = st.shotsFired > 0 ? st.shotsHit / st.shotsFired : 0;
  const kd = prof.deaths > 0 ? prof.kills / prof.deaths : prof.kills;
  return {
    kills: prof.kills | 0,
    deaths: prof.deaths | 0,
    bossKills: prof.bossKills | 0,
    bestStreak: prof.bestStreak | 0,
    kd: Math.round(kd * 100) / 100,
    dmgDealt: st.dmgDealt | 0,
    dmgTaken: st.dmgTaken | 0,
    shotsFired: st.shotsFired | 0,
    shotsHit: st.shotsHit | 0,
    accuracy: Math.round(acc * 1000) / 10,   // 百分比，1 位小数
    headshots: st.headshots | 0,
    crits: st.crits | 0,
    meleeKills: st.meleeKills | 0,
    gunKills: st.gunKills | 0,
    nadeKills: st.nadeKills | 0,
    longestKill: st.longestKill | 0,
    streakMax: st.streakMax | 0,
    playMs: st.playMs | 0,
    deathsByBoss: st.deathsByBoss | 0,
    witherKills: st.witherKills | 0,
    joins: prof.joins | 0,
    decoyKills: prof.decoyKills | 0,
    wpKills: Object.assign({}, st.wpKills),
  };
}

/** 成就列表（含进度），给客户端渲染 */
function achievementList(prof) {
  const have = new Set(Array.isArray(prof && prof.ach) ? prof.ach : []);
  return ACHIEVEMENTS.map(a => {
    const cur = prof ? pick(prof, a.stat) : 0;
    return {
      id: a.id, name: a.name, desc: a.desc, icon: a.icon, reward: a.reward,
      goal: a.goal,
      progress: Math.min(cur, a.goal),
      done: have.has(a.id),
    };
  });
}

module.exports = {
  statsOf, checkAchievements, announce, pick,
  onDamageDealt, onDamageTaken, onShotFired, onShotHit,
  onKill, onStreak, onDeathByBoss, onSessionEnd,
  summary, achievementList,
};
