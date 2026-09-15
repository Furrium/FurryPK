/**
 * fog-event.js — 浓雾事件（真雾 + 场面雾团）
 * ============================================================
 * 「真雾」的两层含义（用户要求：雾必须在世界里真实存在，不是 UI 滤镜）：
 *
 *   ① 深度雾 —— scene.fog.near/far 收紧
 *      three.js 的雾在着色器里按【像素深度】混合雾色，是真实的空间衰减，
 *      不是屏幕遮罩。远处的东西被雾「挡住」是逐像素计算的。
 *
 *   ② 场面雾团 —— 世界里飘着的半透明雾体
 *      复用 world.js 里已有的 softBlobTex()（云用的那张径向渐变），
 *      放出若干缓慢漂移的 Sprite。走近能看见雾从身边飘过。
 *
 * 事件由服务端驱动（见 server 侧），客户端只负责平滑过渡与呈现。
 */
(function (global) {
  'use strict';
  var T = global.THREE;

  function q(n) { try { return new URLSearchParams(global.location.search).get(n); } catch (e) { return null; } }
  function qf(n, d) { var v = q(n); if (v === null) return d; var x = parseFloat(v); return isNaN(x) ? d : x; }
  function urlFlag(n, d) { var v = q(n); if (v === null) return d; return v !== '0' && v !== 'false'; }

  // 常态雾（与 world.js 原值一致）
  var NORMAL_NEAR = 50, NORMAL_FAR = 150;
  // 浓雾：默认更浓（near 3 / far 26）—— 真正的「看不见远处」
  var DENSE_NEAR = qf('fogNear', 3), DENSE_FAR = qf('fogFar', 26);
  // 过渡时长（秒）：起雾比散雾快，形成「突然压过来」的感觉
  var FADE_IN = qf('fogFadeIn', 4.0), FADE_OUT = qf('fogFadeOut', 7.0);

  function makeFogBlobTex() {
    // 比云更柔和：中心淡、边缘完全透明
    var c = document.createElement('canvas');
    c.width = c.height = 256;
    var x = c.getContext('2d');
    var g = x.createRadialGradient(128, 128, 10, 128, 128, 126);
    g.addColorStop(0.0, 'rgba(255,255,255,0.55)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.28)');
    g.addColorStop(0.7, 'rgba(255,255,255,0.08)');
    g.addColorStop(1.0, 'rgba(255,255,255,0)');
    x.fillStyle = g;
    x.fillRect(0, 0, 256, 256);
    return new T.CanvasTexture(c);
  }

  function create(scene, opts) {
    opts = opts || {};
    if (!urlFlag('fogevent', true)) {
      console.log('[fogevent] ?fogevent=0 → 关闭');
      return { setDense: function () {}, update: function () {}, active: false, info: function () { return { disabled: true }; } };
    }
    if (!scene.fog) {
      console.warn('[fogevent] 场景没有 fog，跳过');
      return { setDense: function () {}, update: function () {}, active: false, info: function () { return { noFog: true }; } };
    }

    var half = (opts.half || 48);
    // 默认加大到 40 团，并放大尺寸 —— 目标是「覆盖全场」
    var count = Math.max(0, Math.min(120, qf('fogBlobs', 40)));
    var blobTex = makeFogBlobTex();

    var group = new T.Group();
    group.name = 'fog-blobs';
    group.visible = false;
    var blobs = [];

    for (var i = 0; i < count; i++) {
      var mat = new T.SpriteMaterial({
        map: blobTex,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        depthTest: true,
        fog: true,
        color: new T.Color(0xb9cede),   // 稍亮，浓雾时更可见
      });
      var spr = new T.Sprite(mat);
      // ⭐ 尺寸放大：60~140 单位（覆盖全场，不再是小块）
      var s = 60 + Math.random() * 80;
      spr.scale.set(s, s * (0.5 + Math.random() * 0.3), 1);
      spr.position.set(
        (Math.random() - 0.5) * half * 2.1,
        2 + Math.random() * 14,
        (Math.random() - 0.5) * half * 2.1
      );
      spr.userData = {
        baseY: spr.position.y,
        driftX: (Math.random() - 0.5) * 0.9,
        driftZ: (Math.random() - 0.5) * 0.9,
        bobPh: Math.random() * Math.PI * 2,
        bobAmp: 0.35 + Math.random() * 0.8,
        // ⭐ 单团不透明度大幅提高（原来 0.22~0.52 太淡）
        maxOpacity: 0.42 + Math.random() * 0.38,
        phase: Math.random() * Math.PI * 2,
      };
      group.add(spr);
      blobs.push(spr);
    }
    scene.add(group);

    // ---- 状态 ----
    var state = {
      active: false,          // 服务端是否处于浓雾期
      k: 0,                   // 0=常态 1=浓雾（平滑过渡值）
      baseFogColor: new T.Color(),
      denseColor: new T.Color(0x7d93a8),   // 浓雾色（偏冷灰蓝，比原来亮）
      t: 0,
    };

    group.visible = false;

    return {
      group: group,
      get active() { return state.active; },

      /** 服务端事件入口：dense=是否进入浓雾，warnSec=前兆提前量 */
      setDense: function (dense, opts2) {
        opts2 = opts2 || {};
        var was = state.active;
        state.active = !!dense;
        if (was !== state.active) {
          console.log('[fogevent] ' + (state.active ? '浓雾开始' : '浓雾结束') +
            (opts2.duration ? ' 预计 ' + Math.round(opts2.duration / 1000) + 's' : ''));
        }
      },

      update: function (dt) {
        state.t += dt;

        // ---- ① 深度雾平滑过渡 ----
        var target = state.active ? 1 : 0;
        if (state.k !== target) {
          // ⭐ 起雾快、散雾慢 —— 形成「浓雾压过来」的感觉
          var dur = state.active ? FADE_IN : FADE_OUT;
          var step = dt / Math.max(0.1, dur);
          if (target > state.k) state.k = Math.min(1, state.k + step);
          else state.k = Math.max(0, state.k - step);
        }
        var k = state.k;
        var ease = k * k * (3 - 2 * k);   // smoothstep

        scene.fog.near = NORMAL_NEAR + (DENSE_NEAR - NORMAL_NEAR) * ease;
        scene.fog.far  = NORMAL_FAR  + (DENSE_FAR  - NORMAL_FAR ) * ease;

        // ⚠️ 雾色每帧被 world.setDay() 覆盖，这里在它之后叠加浓雾色调
        if (ease > 0.001) {
          scene.fog.color.lerp(state.denseColor, ease * 0.85);
          if (scene.background && scene.background.isColor) {
            scene.background.lerp(state.denseColor, ease * 0.7);
          }
        }

        // ---- ② 场面雾团 ----
        // 可见性：哪怕 k 很小也让 group 可见（透明度控制实际呈现）
        group.visible = k > 0.01;
        if (group.visible) {
          for (var i = 0; i < blobs.length; i++) {
            var b = blobs[i], u = b.userData;
            b.position.x += u.driftX * dt;
            b.position.z += u.driftZ * dt;
            b.position.y = u.baseY + Math.sin(state.t * 0.55 + u.bobPh) * u.bobAmp;

            // 环绕：飘出边界就折回
            var lim = half * 0.9;
            if (b.position.x > lim) b.position.x = -lim;
            if (b.position.x < -lim) b.position.x = lim;
            if (b.position.z > lim) b.position.z = -lim;
            if (b.position.z < -lim) b.position.z = lim;

            // 透明度：整体随 k，个体再加缓慢呼吸
            var breathe = 0.75 + 0.25 * Math.sin(state.t * 0.7 + u.phase);
            b.material.opacity = u.maxOpacity * ease * breathe;
          }
        } else if (blobs.length && blobs[0].material.opacity !== 0) {
          for (var j = 0; j < blobs.length; j++) blobs[j].material.opacity = 0;
        }
      },

      info: function () {
        return {
          active: state.active,
          k: +state.k.toFixed(3),
          fogNear: +scene.fog.near.toFixed(1),
          fogFar: +scene.fog.far.toFixed(1),
          blobs: blobs.length,
          blobsVisible: group.visible,
        };
      },
    };
  }

  global.FogEvent = { create: create };
})(window);
