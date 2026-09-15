/**
 * decor.js — 竞技场外围装饰结构
 * ============================================================
 * 设计原则：
 *   ⛔ 不参与碰撞、不进入 colliders —— 玩法零影响
 *   ⛔ 不放等距重复物 —— 高度/尺寸全部不等，模拟真实天际线
 *   ✅ 全部位于 ±44 之外，避开出生点(±43)与商人(±43,±40)
 *   ✅ 用现有配色（青 #35e0ff / 品红 #ff4d9d），不引入新色
 *
 * 数据来自 decor.json，可单独编辑而不碰游戏代码。
 */
(function (global) {
  'use strict';
  var T = global.THREE;

  function q(n) { try { return new URLSearchParams(global.location.search).get(n); } catch (e) { return null; } }
  function qf(n, d) { var v = q(n); if (v === null) return d; var x = parseFloat(v); return isNaN(x) ? d : x; }
  function urlFlag(n, d) { var v = q(n); if (v === null) return d; return v !== '0' && v !== 'false'; }

  var NEON = 0x35e0ff;
  var MAGENTA = 0xff4d9d;

  /** 建筑主体材质（暗、粗糙、有微弱自发光窗格） */
  function makeBuildingTex(w, h, seed) {
    var c = document.createElement('canvas');
    c.width = 128; c.height = 256;
    var x = c.getContext('2d');

    // 底色：深蓝灰，四角略亮（模拟环境光）
    var g = x.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, '#161d2b');
    g.addColorStop(0.55, '#101623');
    g.addColorStop(1, '#0a0e18');
    x.fillStyle = g; x.fillRect(0, 0, 128, 256);

    // 竖向结构分格
    x.strokeStyle = 'rgba(90,120,165,0.13)';
    x.lineWidth = 1;
    for (var i = 1; i < 6; i++) {
      x.beginPath(); x.moveTo(i * 21.3, 0); x.lineTo(i * 21.3, 256); x.stroke();
    }

    // 横向楼层线
    x.strokeStyle = 'rgba(70,100,145,0.10)';
    for (var j = 1; j < 16; j++) {
      x.beginPath(); x.moveTo(0, j * 16); x.lineTo(128, j * 16); x.stroke();
    }

    // 亮着的窗户（稀疏，大部分是暗的 —— 避免"蜂窝"感）
    var s = seed || 1;
    function rnd() { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }
    for (var wy = 0; wy < 16; wy++) {
      for (var wx = 0; wx < 6; wx++) {
        if (rnd() > 0.14) continue;                 // 只有 14% 的窗亮着
        var bright = 0.25 + rnd() * 0.55;
        var hue = rnd() > 0.82 ? MAGENTA : NEON;    // 少量品红点缀
        var col = '#' + hue.toString(16).padStart(6, '0');
        x.globalAlpha = bright;
        x.fillStyle = col;
        x.fillRect(wx * 21.3 + 4, wy * 16 + 5, 13, 7);
        x.globalAlpha = 1;
      }
    }

    var tex = new T.CanvasTexture(c);
    tex.wrapS = tex.wrapT = T.RepeatWrapping;
    tex.anisotropy = 4;
    return tex;
  }

  function build(scene, map, decor) {
    if (!urlFlag('decor', true)) { console.log('[decor] ?decor=0 → 关闭'); return null; }
    if (!decor) { console.warn('[decor] 无装饰数据'); return null; }

    var half = (map && map.half) || 48;
    var group = new T.Group();
    group.name = 'arena-decor';
    var count = 0;

    // ---- 天际线：塔楼 + 建筑体块 ----
    var items = (decor.skyline || []).filter(function (o) { return o.x !== undefined; });
    items.forEach(function (o, i) {
      var isTower = o.style === 'tower';
      var tex = makeBuildingTex(o.w, o.h, (i + 3) * 977);
      tex.repeat.set(Math.max(1, Math.round(o.w / 5)), Math.max(1, Math.round(o.h / 10)));

      var mat = new T.MeshStandardMaterial({
        map: tex,
        emissiveMap: tex,                 // ⭐ 窗格自发光（会被 bloom 捕捉）
        emissive: new T.Color(0xffffff),
        emissiveIntensity: qf('decorGlow', 0.55),
        roughness: 0.88,
        metalness: 0.12,
      });

      var m = new T.Mesh(new T.BoxGeometry(o.w, o.h, o.d), mat);
      m.position.set(o.x, o.h / 2, o.z);
      m.castShadow = false;               // ⭐ 不投影（省性能，且在地图外）
      m.receiveShadow = false;
      group.add(m);
      count++;

      // 顶部霓虹标识条（塔楼才有，做视觉锚点）
      if (isTower) {
        var capMat = new T.MeshStandardMaterial({
          color: 0x0b3540,
          emissive: i % 2 === 0 ? NEON : MAGENTA,
          emissiveIntensity: 1.5,
        });
        var cap = new T.Mesh(new T.BoxGeometry(o.w + 0.25, 0.35, o.d + 0.25), capMat);
        cap.position.set(o.x, o.h + 0.2, o.z);
        group.add(cap);

        // 侧面的竖向灯带（不对称：只在两面）
        var stripMat = new T.MeshStandardMaterial({
          color: 0x0a2030, emissive: NEON, emissiveIntensity: 1.1,
        });
        var s1 = new T.Mesh(new T.BoxGeometry(0.3, o.h * 0.55, 0.3), stripMat);
        s1.position.set(o.x + o.w / 2 + 0.12, o.h * 0.45, o.z + o.d / 2);
        group.add(s1);
      }
    });

    // ---- 上空桁架 ----
    (decor.overhead || []).filter(function (o) {
      return o.kind === 'truss' && o.x1 !== undefined && o.x2 !== undefined &&
             o.z1 !== undefined && o.z2 !== undefined;
    }).forEach(function (o) {
      var dx = o.x2 - o.x1, dz = o.z2 - o.z1;
      var len = Math.sqrt(dx * dx + dz * dz);
      var ang = Math.atan2(dx, dz);

      var trussMat = new T.MeshStandardMaterial({ color: 0x1a2230, roughness: 0.75, metalness: 0.35 });
      var beam = new T.Mesh(new T.BoxGeometry(o.w, o.h, len), trussMat);
      beam.position.set((o.x1 + o.x2) / 2, o.y, (o.z1 + o.z2) / 2);
      beam.rotation.y = ang;
      group.add(beam);

      // 桁架下方的灯带（稀疏的点光源感）
      var lightMat = new T.MeshStandardMaterial({
        color: 0x0b2030, emissive: NEON, emissiveIntensity: 1.3,
      });
      var n = Math.max(2, Math.floor(len / 14));
      for (var i = 1; i < n; i++) {
        var t = i / n;
        var lx = o.x1 + dx * t, lz = o.z1 + dz * t;
        var lamp = new T.Mesh(new T.BoxGeometry(1.6, 0.22, 0.5), lightMat);
        lamp.position.set(lx, o.y - o.h / 2 - 0.2, lz);
        lamp.rotation.y = ang;
        group.add(lamp);
      }
      count += n;
    });

    // ---- 垂吊光缆 ----
    (decor.overhead || []).filter(function (o) { return o.kind === 'cable'; }).forEach(function (o) {
      var hgt = o.fromY - o.toY;
      var mat = new T.MeshStandardMaterial({ color: 0x141c28, roughness: 0.7, metalness: 0.4 });
      var cable = new T.Mesh(new T.CylinderGeometry(o.r, o.r * 0.75, hgt, 6), mat);
      cable.position.set(o.x, o.toY + hgt / 2, o.z);
      group.add(cable);

      // 末端指示灯
      var tipMat = new T.MeshStandardMaterial({
        color: 0x101820, emissive: MAGENTA, emissiveIntensity: 1.8,
      });
      var tip = new T.Mesh(new T.SphereGeometry(o.r * 1.8, 8, 6), tipMat);
      tip.position.set(o.x, o.toY, o.z);
      group.add(tip);
      count += 2;
    });

    // ---- 围墙分段（壁柱）----
    (decor.wallDetail || []).filter(function (o) { return o.kind === 'pilaster'; }).forEach(function (o) {
      var tex = makeBuildingTex(o.w, o.h, Math.round(o.x * 31 + o.z * 17));
      tex.repeat.set(1, Math.max(1, Math.round(o.h / 8)));
      var mat = new T.MeshStandardMaterial({
        map: tex, emissiveMap: tex, emissive: new T.Color(0xffffff),
        emissiveIntensity: qf('decorGlow', 0.55) * 0.6,
        roughness: 0.9, metalness: 0.1,
      });
      var m = new T.Mesh(new T.BoxGeometry(o.w, o.h, o.d), mat);
      m.position.set(o.x, o.h / 2, o.z);
      group.add(m);
      count++;
    });

    scene.add(group);

    console.log('[decor] 竞技场装饰已加入：' + count + ' 个结构（不参与碰撞）');

    return {
      group: group,
      count: count,
      setVisible: function (v) { group.visible = v; },
      setGlow: function (v) {
        group.traverse(function (o) {
          if (o.isMesh && o.material && o.material.emissiveIntensity !== undefined) {
            if (o.material.emissiveMap) o.material.emissiveIntensity = v;
          }
        });
      },
      info: function () { return { count: count, visible: group.visible }; },
    };
  }

  global.ArenaDecor = { build: build };
})(window);
