/**
 * ground-fx.js v2 — 真实镜面 + 发光网格叠加（方案 C+）
 * ============================================================
 * v1 只做了「自发光」，用户要的是「反射」。
 *
 * v2 结构：
 *   ① 底层：THREE.Reflector —— 真实镜面（反射围墙/箱子/霓虹/玩家）
 *   ② 上层：一块略高的透明平面，贴发光网格贴图（additive 混合）
 *      → 镜面 + 网格线，两者叠加，这是 samsy 那种质感
 *
 * 性能控制：
 *   - textureWidth/Height 可调（默认 512，越低越省）
 *   - 可用 ?mirror=0 完全关掉镜面，退回纯网格
 */
(function (global) {
  'use strict';
  var T = global.THREE;

  function q(n) { try { return new URLSearchParams(global.location.search).get(n); } catch (e) { return null; } }
  function qf(n, d) { var v = q(n); if (v === null) return d; var x = parseFloat(v); return isNaN(x) ? d : x; }
  function urlFlag(n, d) { var v = q(n); if (v === null) return d; return v !== '0' && v !== 'false'; }

  /** 生成「只有线条」的透明网格贴图（用于叠加层） */
  function makeGridOverlayTex(size, line, cells) {
    var c = document.createElement('canvas');
    c.width = c.height = size;
    var x = c.getContext('2d');
    x.clearRect(0, 0, size, size);

    var step = size / cells;

    // 细网格
    x.strokeStyle = 'rgba(80,140,190,0.20)';
    x.lineWidth = 1;
    for (var i = 0; i <= cells * 2; i++) {
      var p = (i * step) / 2;
      x.beginPath(); x.moveTo(p, 0); x.lineTo(p, size); x.stroke();
      x.beginPath(); x.moveTo(0, p); x.lineTo(size, p); x.stroke();
    }

    // 主网格（发光）
    x.strokeStyle = line;
    x.lineWidth = 2.6;
    x.shadowColor = line;
    x.shadowBlur = 8;
    for (var j = 0; j <= cells; j++) {
      var s = j * step;
      x.beginPath(); x.moveTo(s, 0); x.lineTo(s, size); x.stroke();
      x.beginPath(); x.moveTo(0, s); x.lineTo(size, s); x.stroke();
    }
    x.shadowBlur = 0;

    // 交叉点
    x.fillStyle = line;
    for (var a = 0; a <= cells; a++)
      for (var b = 0; b <= cells; b++) {
        x.beginPath(); x.arc(a * step, b * step, 3.4, 0, Math.PI * 2); x.fill();
      }

    var tex = new T.CanvasTexture(c);
    tex.wrapS = tex.wrapT = T.RepeatWrapping;
    tex.anisotropy = 8;
    return tex;
  }

  function apply(scene, opt) {
    opt = opt || {};
    var half = opt.half || 35;

    var useMirror = urlFlag('mirror', true) && !!T.Reflector;
    var mirrorRes = Math.max(128, Math.min(2048, qf('mres', 512)));
    var gridOn    = urlFlag('gridon', true);
    var color     = opt.color || (q('gridcol') ? '#' + q('gridcol') : '#35e0ff');
    var intensity = opt.intensity !== undefined ? opt.intensity : qf('grid', 0.85);
    var repeat    = opt.repeat || 18;
    var cells     = opt.cells || 2;
    var tint      = qf('mtint', 0.62);   // 镜面亮度（越小越暗，避免镜面抢戏）

    console.log('[groundfx v2] mirror=' + useMirror + ' res=' + mirrorRes +
      ' grid=' + gridOn + ' color=' + color + ' intensity=' + intensity);

    // ---- 找原地面 / 外圈 ----
    var ground = null, outer = null;
    scene.traverse(function (o) {
      if (o.isMesh && o.geometry && o.geometry.type === 'PlaneGeometry' &&
          Math.abs(o.rotation.x + Math.PI / 2) < 0.01) {
        var p = o.geometry.parameters || {};
        if (p.width >= half * 2 - 1 && p.width <= half * 2 + 1) ground = o;
        else if (p.width > 400) outer = o;
      }
    });
    if (!ground) { console.warn('[groundfx] 找不到地面'); return null; }

    var created = { mirror: null, overlay: null, gridTex: null };
    var groundParent = ground.parent;

    // ================= ① 镜面底层 =================
    if (useMirror) {
      try {
        // ⭐ 用带高斯模糊的镜面（GroundMirror）替代原版清晰 Reflector
        var mirror = (typeof GroundMirror !== 'undefined')
          ? GroundMirror.create(half * 2, { res: mirrorRes, color: 0x8899aa })
          : new T.Reflector(new T.PlaneGeometry(half * 2, half * 2), {
              clipBias: 0.003, textureWidth: mirrorRes, textureHeight: mirrorRes, color: 0x8899aa,
            });
        mirror.rotation.x = -Math.PI / 2;
        mirror.position.copy(ground.position);
        mirror.position.y = ground.position.y - 0.001;   // 略低于原地面
        mirror.name = 'groundfx-mirror';
        groundParent.add(mirror);
        created.mirror = mirror;

        // 原地面变透明（让镜面透出来），但仍保留阴影接收
        ground.material.transparent = true;
        ground.material.opacity = 0.0;    // 完全透明 → 只留 receiveShadow 的深度
        ground.material.depthWrite = false;
        ground.renderOrder = 1;

        console.log('[groundfx] 镜面已加入（' + mirrorRes + 'px）');
      } catch (e) {
        console.warn('[groundfx] 镜面创建失败:', e.message);
      }
    }

    // ================= ② 发光网格叠加层 =================
    if (gridOn) {
      var gridTex = makeGridOverlayTex(512, color, cells);
      gridTex.repeat.set(repeat, repeat);
      created.gridTex = gridTex;

      var ovGeo = new T.PlaneGeometry(half * 2, half * 2);
      var ovMat = new T.MeshBasicMaterial({
        map: gridTex,
        transparent: true,
        opacity: Math.min(1, intensity),
        blending: T.AdditiveBlending,   // ⭐ 叠加，不遮挡下面的镜面
        depthWrite: false,
        depthTest: true,
        fog: true,
      });
      var overlay = new T.Mesh(ovGeo, ovMat);
      overlay.rotation.x = -Math.PI / 2;
      overlay.position.copy(ground.position);
      overlay.position.y = ground.position.y + 0.006;   // 略高于镜面，避免 z-fighting
      overlay.renderOrder = 3;
      overlay.name = 'groundfx-overlay';
      groundParent.add(overlay);
      created.overlay = overlay;

      console.log('[groundfx] 发光网格叠加层已加入');
    }

    // 外圈压暗
    if (outer) {
      outer.material.color.setHex(0x05070c);
      outer.material.roughness = 0.9;
    }

    // ---- 对外 API ----
    return {
      mirror: created.mirror,
      overlay: created.overlay,
      texture: created.gridTex,
      ground: ground,
      setIntensity: function (v) {
        if (created.overlay) created.overlay.material.opacity = Math.min(1, v);
      },
      setColor: function (hex) {
        if (!created.overlay) return;
        var t2 = makeGridOverlayTex(512, hex, cells);
        t2.repeat.set(repeat, repeat);
        created.overlay.material.map = t2;
        created.overlay.material.needsUpdate = true;
        created.gridTex = t2;
      },
      setMirrorEnabled: function (on) {
        if (created.mirror) created.mirror.visible = on;
      },
      setMirrorRes: function (r) {
        // 需要重建，简单起见提示
        console.log('[groundfx] 改分辨率需刷新页面: ?mres=' + r);
      },
      info: function () {
        return {
          mirror: !!created.mirror,
          mirrorRes: created.mirror ? mirrorRes : 0,
          overlay: !!created.overlay,
          color: color,
          intensity: intensity,
        };
      },
    };
  }

  global.GroundFX = { apply: apply, makeGridOverlayTex: makeGridOverlayTex };
})(window);
